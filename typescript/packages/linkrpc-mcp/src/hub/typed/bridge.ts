import {
    ErrorCode,
    type InterfaceDefinition,
    type InterfaceRegistration,
    type JsonValue,
    type LinkRpcConnection,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
    type MemberMap,
    RpcError,
    schemaToZod,
} from "@hediet/linkrpc";
import type { McpClientSession, McpToolDefinition } from "../clientSession";
import {
    type McpAuthenticationState,
    type McpCatalogTool,
    type McpServerState,
    type McpToolCatalog,
    mcpServerInterface,
    mcpToolsInterface,
} from "../contracts";
import { McpSessionManager, type McpSessionManagerOptions } from "../sessionManager";
import { createMcpToolsInterface, encodeToolMethodName } from "./generatedInterface";

export interface RegisterMcpToolBridgeOptions extends McpSessionManagerOptions {
    readonly connection: LinkRpcConnection;
    readonly serviceId: string;
    /** Generated interface id, `mcp.tools.<name>`. */
    readonly interfaceId: string;
    readonly serviceDescription?: string;
    /** Register reflection for `serviceId`. Defaults to `true`. */
    readonly enableReflection?: boolean;
    readonly initialAuthenticationState?: McpAuthenticationState;
    readonly onRefreshError?: (error: unknown) => void;
}

export interface McpToolBridgeRegistration {
    readonly sessionManager: McpSessionManager;
    readonly currentInterface: InterfaceDefinition<MemberMap>;
    getState(sessionId?: string): McpServerState;
    updateAuthenticationState(state: McpAuthenticationState): void;
    refreshTools(): Promise<void>;
    dispose(): Promise<void>;
}

/** The shared bridge session, used when a call omits `sessionId`. */
const sharedSessionId = "";

/**
 * Publish an MCP server's tools as typed LinkRPC methods under `serviceId`.
 *
 * - `<interfaceId>` (`mcp.tools.<name>`): one method per tool, re-registered
 *   when the server reports `tools/list_changed`. Capabilities therefore apply
 *   per tool.
 * - `mcp.tools`: the tool catalog, mapping tools to generated methods.
 * - `mcp.server`: state, plus exclusive sessions.
 *
 * All callers share one MCP session unless they open an exclusive one with
 * `mcp.server::openSession` and pass its id as `sessionId`. Exclusive session
 * ids are unguessable and minted by the bridge; holding one is what grants its
 * use, so one caller cannot reach another caller's session.
 */
export async function registerMcpToolBridge(
    options: RegisterMcpToolBridgeOptions,
): Promise<McpToolBridgeRegistration> {
    const sessions = new McpSessionManager(options);
    const exclusiveSessions = new Set<string>();
    const toolsChanged = sessions.onToolsChanged(() => scheduleRefresh());
    const reflection = options.enableReflection === false
        ? undefined
        : options.connection.enableReflection({ serviceId: options.serviceId });
    const staticRegistrations: InterfaceRegistration[] = [];
    const watchers = new Set<{ readonly sessionId: string; send(state: McpServerState): void }>();
    const sessionStates = new Map<string, McpServerState["session"]>();
    const registrationOptions = {
        serviceId: options.serviceId,
        serviceDescription: options.serviceDescription,
    };
    let revision = 0;
    let serverState: McpServerState["server"] = { status: "starting" };
    let transportState: McpServerState["transport"] = { status: "disconnected" };
    let authenticationState: McpAuthenticationState = options.initialAuthenticationState ?? { status: "not-required" };
    let toolsState: McpServerState["tools"] = { status: "loading", interfaceId: options.interfaceId };
    let catalog: readonly McpCatalogTool[] = [];
    let refreshChain: Promise<void> = Promise.resolve();
    let disposed = false;

    let currentInterface = createMcpToolsInterface([], options.interfaceId).interface;
    let application: InterfaceRegistration = options.connection.register(currentInterface, {}, registrationOptions);

    function getState(sessionId = sharedSessionId): McpServerState {
        return {
            revision,
            server: { ...serverState },
            transport: { ...transportState },
            authentication: { ...authenticationState },
            tools: { ...toolsState },
            session: { ...(sessionStates.get(sessionId) ?? { sessionId, status: "absent" }) },
        };
    }

    function emitState(): void {
        revision++;
        for (const watcher of watchers) watcher.send(getState(watcher.sessionId));
    }

    function setSessionState(sessionId: string, status: McpServerState["session"]["status"], error?: string): void {
        sessionStates.set(sessionId, { sessionId, status, ...(error === undefined ? {} : { error }) });
        emitState();
    }

    function resolveSessionId(sessionId: string | undefined): string {
        if (sessionId === undefined || sessionId === sharedSessionId) return sharedSessionId;
        if (!exclusiveSessions.has(sessionId)) {
            throw new RpcError("Unknown or closed MCP bridge session", ErrorCode.invalidParams);
        }
        return sessionId;
    }

    async function useSession<T>(sessionId: string, operation: (session: McpClientSession) => Promise<T>): Promise<T> {
        if (!sessions.has(sessionId)) {
            setSessionState(sessionId, "opening");
            transportState = { status: "connecting" };
            emitState();
        }
        try {
            const result = await sessions.use(sessionId, operation);
            setSessionState(sessionId, "ready");
            transportState = { status: "connected" };
            if (serverState.status === "starting" || serverState.status === "idle") serverState = { status: "running" };
            emitState();
            return result;
        } catch (error) {
            const message = errorMessage(error);
            setSessionState(sessionId, "error", message);
            transportState = { status: "error", error: message };
            emitState();
            throw error;
        }
    }

    function reportRefreshError(error: unknown): void {
        if (options.onRefreshError !== undefined) options.onRefreshError(error);
        else console.error("MCP tool bridge refresh failed", error);
    }

    function scheduleRefresh(): void {
        if (disposed) return;
        void enqueueRefresh().catch(reportRefreshError);
    }

    function enqueueRefresh(): Promise<void> {
        const result = refreshChain.then(performRefresh);
        refreshChain = result.catch(() => { /* reported by the caller */ });
        return result;
    }

    async function performRefresh(): Promise<void> {
        toolsState = { status: "loading", interfaceId: options.interfaceId };
        emitState();
        let tools: readonly McpToolDefinition[];
        let generated: ReturnType<typeof createMcpToolsInterface>;
        try {
            tools = await useSession(sharedSessionId, (session) => session.listTools());
            generated = createMcpToolsInterface(tools, options.interfaceId);
        } catch (error) {
            const message = errorMessage(error);
            serverState = { status: "error", error: message };
            toolsState = { status: "error", interfaceId: options.interfaceId, error: message };
            emitState();
            throw error;
        }
        if (generated.interface.schemaHash !== currentInterface.schemaHash) {
            const reflectedSchema = generated.interface.toSchema();
            const handlers: Record<string, (params: unknown, ctx: unknown, stream: { signal: AbortSignal }) => Promise<JsonValue>> = {};
            for (const [methodName, toolName] of generated.routes) {
                const methodSchema = reflectedSchema.methods[methodName];
                if (methodSchema === undefined) throw new Error(`Missing generated schema for MCP tool '${toolName}'`);
                handlers[methodName] = async (rawParams, _ctx, stream) => {
                    assertSchemaValue(methodSchema.params, rawParams, "params", reflectedSchema);
                    const { sessionId, args } = readToolCallParams(rawParams);
                    const result = await useSession(resolveSessionId(sessionId), (session) =>
                        session.callTool(toolName, args, stream.signal));
                    if (methodSchema.result !== undefined) {
                        assertSchemaValue(methodSchema.result, result, "result", reflectedSchema);
                    }
                    return result;
                };
            }
            application.dispose();
            application = options.connection.register(generated.interface, handlers as never, registrationOptions);
            currentInterface = generated.interface;
        }
        catalog = tools.map((tool) => ({
            name: tool.name,
            method: encodeToolMethodName(tool.name),
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        }));
        toolsState = {
            status: "ready",
            interfaceId: options.interfaceId,
            interfaceHash: currentInterface.schemaHash,
            count: tools.length,
        };
        serverState = { status: "running" };
        emitState();
    }

    staticRegistrations.push(options.connection.register(mcpToolsInterface, {
        listTools: async (): Promise<McpToolCatalog> => {
            await refreshChain;
            return {
                interfaceId: options.interfaceId,
                interfaceHash: currentInterface.schemaHash,
                tools: catalog.map((tool) => ({ ...tool })),
            };
        },
    }, registrationOptions));

    staticRegistrations.push(options.connection.register(mcpServerInterface, {
        getState: ({ sessionId }) => getState(resolveSessionId(sessionId)),
        watchState: ({ sessionId }, _ctx, stream) => {
            const watcher = {
                sessionId: resolveSessionId(sessionId),
                send: (state: McpServerState) => void stream.send(state),
            };
            return new Promise((resolve) => {
                watchers.add(watcher);
                watcher.send(getState(watcher.sessionId));
                const finish = () => {
                    watchers.delete(watcher);
                    resolve({});
                };
                if (stream.signal.aborted) finish();
                else stream.signal.addEventListener("abort", finish, { once: true });
            });
        },
        openSession: async () => {
            const sessionId = globalThis.crypto.randomUUID();
            exclusiveSessions.add(sessionId);
            try {
                await useSession(sessionId, async () => undefined);
            } catch (error) {
                exclusiveSessions.delete(sessionId);
                await sessions.close(sessionId);
                throw error;
            }
            return { sessionId };
        },
        closeSession: async ({ sessionId }) => {
            const id = resolveSessionId(sessionId);
            setSessionState(id, "closing");
            const closed = await sessions.close(id);
            exclusiveSessions.delete(id);
            if (id === sharedSessionId) setSessionState(id, closed ? "closed" : "absent");
            else sessionStates.delete(id);
            if (sessions.activeSessionCount === 0) {
                transportState = { status: "disconnected" };
                serverState = { status: "idle" };
            }
            emitState();
            return { closed };
        },
        restartSession: async ({ sessionId }) => {
            const id = resolveSessionId(sessionId);
            await sessions.close(id);
            await useSession(id, async () => undefined);
            if (id === sharedSessionId) await enqueueRefresh();
            return {};
        },
    }, registrationOptions));

    try {
        await enqueueRefresh();
    } catch (error) {
        reportRefreshError(error);
    }

    return {
        sessionManager: sessions,
        get currentInterface() {
            return currentInterface;
        },
        getState,
        updateAuthenticationState: (state) => {
            authenticationState = state;
            emitState();
        },
        refreshTools: () => {
            if (disposed) return Promise.reject(new Error("MCP tool bridge is disposed"));
            return enqueueRefresh();
        },
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            serverState = { status: "stopping" };
            emitState();
            await refreshChain;
            toolsChanged.dispose();
            application.dispose();
            for (const registration of staticRegistrations.reverse()) registration.dispose();
            reflection?.dispose();
            await sessions.dispose();
            exclusiveSessions.clear();
            serverState = { status: "stopped" };
            transportState = { status: "disconnected" };
            watchers.clear();
        },
    };
}

function readToolCallParams(value: unknown): {
    readonly sessionId: string | undefined;
    readonly args: Readonly<Record<string, unknown>>;
} {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new RpcError("MCP tool call params must be an object", ErrorCode.invalidParams);
    }
    const { sessionId, ...args } = value as Readonly<Record<string, unknown>>;
    if (sessionId !== undefined && typeof sessionId !== "string") {
        throw new RpcError("MCP tool call sessionId must be a string", ErrorCode.invalidParams);
    }
    return { sessionId, args };
}

function assertSchemaValue(
    schema: LinkRpcJsonSchema,
    value: unknown,
    kind: "params" | "result",
    interfaceSchema: LinkRpcInterfaceSchema,
): void {
    if (schemaToZod(schema, interfaceSchema.components?.schemas).safeParse(value).success) return;
    throw new RpcError(
        `Invalid MCP tool ${kind}`,
        kind === "params" ? ErrorCode.invalidParams : ErrorCode.internalError,
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
