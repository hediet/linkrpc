import {
    ErrorCode,
    type InterfaceDefinition,
    type InterfaceRegistration,
    type JsonValue,
    type LinkRpcConnection,
    type LinkRpcJsonSchema,
    type MemberMap,
    RpcError,
    schemaToZod,
} from "@hediet/linkrpc";
import type { McpClientSession, McpToolDefinition } from "../clientSession";
import {
    callToolResultSchema,
    type McpAuthenticationState,
    type McpCatalogTool,
    type McpServerState,
    type McpToolCatalog,
    mcpServerInterface,
    mcpToolsInterface,
} from "../contracts";
import { McpSessionManager, type McpSessionManagerOptions } from "../sessionManager";
import {
    assertGeneratedInterfaceId,
    assertToolGroups,
    createMcpToolsInterfaces,
    type GeneratedToolMethod,
    type McpToolGroup,
} from "./generatedInterface";

export interface RegisterMcpToolBridgeOptions extends McpSessionManagerOptions {
    readonly connection: LinkRpcConnection;
    readonly serviceId: string;
    /** Base generated interface id, `mcp.tools.<name>`. */
    readonly interfaceId: string;
    /** Split tools into further interfaces `<interfaceId>.<group>`. */
    readonly groups?: readonly McpToolGroup[];
    readonly serviceDescription?: string;
    /** Register reflection for `serviceId`. Defaults to `true`. */
    readonly enableReflection?: boolean;
    readonly initialAuthenticationState?: McpAuthenticationState;
    readonly onRefreshError?: (error: unknown) => void;
    /** Receives warnings, e.g. about tools published with unchecked params. */
    readonly log?: (line: string) => void;
}

export interface McpToolBridgeRegistration {
    readonly sessionManager: McpSessionManager;
    /** The registered (non-empty) generated interfaces by id. */
    readonly currentInterfaces: ReadonlyMap<string, InterfaceDefinition<MemberMap>>;
    getState(sessionId?: string): McpServerState;
    updateAuthenticationState(state: McpAuthenticationState): void;
    refreshTools(): Promise<void>;
    dispose(): Promise<void>;
}

/** The shared bridge session, used when a call omits `sessionId`. */
const sharedSessionId = "";

/**
 * Publish an MCP server as a LinkRPC service under `serviceId`.
 *
 * - `<interfaceId>` (`mcp.tools.<name>`) and `<interfaceId>.<group>`: one
 *   method per tool, re-registered when the server reports
 *   `tools/list_changed`. Capabilities can therefore apply per tool or group.
 * - `mcp.tools`: the tool catalog and generic `callTool`.
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
    assertGeneratedInterfaceId(options.interfaceId);
    assertToolGroups(options.groups ?? []);
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
    let toolsState: McpServerState["tools"] = { status: "loading" };
    let catalog: readonly McpCatalogTool[] = [];
    let toolMethods: ReadonlyMap<string, GeneratedToolMethod> = new Map();
    let refreshChain: Promise<void> = Promise.resolve();
    let disposed = false;
    const applications = new Map<string, {
        readonly definition: InterfaceDefinition<MemberMap>;
        readonly registration: InterfaceRegistration;
    }>();

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
        toolsState = { status: "loading" };
        emitState();
        let tools: readonly McpToolDefinition[];
        let generated: ReturnType<typeof createMcpToolsInterfaces>;
        try {
            tools = await useSession(sharedSessionId, (session) => session.listTools());
            generated = createMcpToolsInterfaces(tools, options.interfaceId, options.groups);
        } catch (error) {
            const message = errorMessage(error);
            serverState = { status: "error", error: message };
            toolsState = { status: "error", error: message };
            emitState();
            throw error;
        }
        for (const warning of generated.warnings) options.log?.(warning);
        for (const [interfaceId, application] of applications) {
            if (generated.interfaces.get(interfaceId)?.schemaHash === application.definition.schemaHash) continue;
            application.registration.dispose();
            applications.delete(interfaceId);
        }
        for (const [interfaceId, definition] of generated.interfaces) {
            if (applications.has(interfaceId)) continue;
            const handlers: Record<string, (params: unknown, ctx: unknown, stream: { signal: AbortSignal }) => Promise<JsonValue>> = {};
            for (const [toolName, method] of generated.tools) {
                if (method.interfaceId !== interfaceId) continue;
                handlers[method.method] = async (rawParams, _ctx, stream) => {
                    const { sessionId, args } = readToolCallParams(rawParams);
                    return invokeTool(toolName, method, sessionId, args, stream.signal);
                };
            }
            applications.set(interfaceId, {
                definition,
                registration: options.connection.register(definition, handlers as never, registrationOptions),
            });
        }
        toolMethods = generated.tools;
        catalog = tools.map((tool) => {
            const method = generated.tools.get(tool.name)!;
            return {
                name: tool.name,
                interfaceId: method.interfaceId,
                method: method.method,
                ...(tool.title !== undefined ? { title: tool.title } : {}),
                ...(tool.description !== undefined ? { description: tool.description } : {}),
                inputSchema: tool.inputSchema,
                ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
                ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
            };
        });
        toolsState = { status: "ready", interfaces: interfaceSummaries(), count: tools.length };
        serverState = { status: "running" };
        emitState();
    }

    function interfaceSummaries(): McpToolCatalog["interfaces"] {
        return [...applications].map(([interfaceId, application]) => ({
            interfaceId,
            interfaceHash: application.definition.schemaHash,
            toolCount: catalog.filter((tool) => tool.interfaceId === interfaceId).length,
        }));
    }

    /** Validates params against the tool's generated schema, then calls it. */
    async function invokeTool(
        toolName: string,
        method: GeneratedToolMethod,
        sessionId: string | undefined,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<JsonValue> {
        assertSchemaValue(method.params, { ...args }, method.components, "params");
        const result = await useSession(resolveSessionId(sessionId), (session) =>
            session.callTool(toolName, args, signal));
        assertSchemaValue(method.result, result, method.components, "result");
        return result;
    }

    staticRegistrations.push(options.connection.register(mcpToolsInterface, {
        listTools: async (): Promise<McpToolCatalog> => {
            await refreshChain;
            return {
                interfaces: interfaceSummaries(),
                tools: catalog.map((tool) => ({ ...tool })),
            };
        },
        callTool: async ({ sessionId, name, arguments: args }, _ctx, stream) => {
            await refreshChain;
            const method = toolMethods.get(name);
            if (method === undefined) throw new RpcError(`Unknown MCP tool: ${name}`, ErrorCode.invalidParams);
            if (args !== undefined && "sessionId" in args) {
                throw new RpcError("Pass sessionId next to arguments, not inside them", ErrorCode.invalidParams);
            }
            return callToolResultSchema.parse(
                await invokeTool(name, method, sessionId, args ?? {}, stream.signal),
            ) as never;
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
        get currentInterfaces() {
            return new Map([...applications].map(([interfaceId, application]) => [interfaceId, application.definition]));
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
            for (const application of applications.values()) application.registration.dispose();
            applications.clear();
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
    components: Readonly<Record<string, LinkRpcJsonSchema>>,
    kind: "params" | "result",
): void {
    if (schemaToZod(schema, { ...components }).safeParse(value).success) return;
    throw new RpcError(
        `Invalid MCP tool ${kind}`,
        kind === "params" ? ErrorCode.invalidParams : ErrorCode.internalError,
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
