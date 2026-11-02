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
import { defaultMcpIdentity, type McpIdentities, resolveMcpIdentity } from "../mcpIdentities";
import { McpSessionManager, type McpSessionManagerOptions } from "../sessionManager";
import {
    assertGeneratedInterfaceId,
    assertToolGroups,
    createMcpToolsInterfaces,
    type GeneratedToolMethod,
    type McpToolGroup,
    reservedToolParams,
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
    /**
     * The accounts the server can be used with; `factory` opens sessions for
     * them. Defaults to one identity, `default`, that needs no authentication.
     */
    readonly identities?: McpIdentities;
    readonly onRefreshError?: (error: unknown) => void;
    /** Receives warnings, e.g. about tools published with unchecked params. */
    readonly log?: (line: string) => void;
}

export interface McpToolBridgeRegistration {
    readonly sessionManager: McpSessionManager;
    /** The registered (non-empty) generated interfaces by id. */
    readonly currentInterfaces: ReadonlyMap<string, InterfaceDefinition<MemberMap>>;
    getState(target?: { readonly sessionId?: string; readonly mcpIdentity?: string }): McpServerState;
    refreshTools(): Promise<void>;
    dispose(): Promise<void>;
}

/** The shared bridge session of an identity, used when a call omits `sessionId`. */
const sharedSessionId = "";

/** A bridge session: the shared or an exclusive session of one MCP identity. */
interface SessionTarget {
    readonly identityId: string;
    readonly sessionId: string;
}

const fixedIdentities: McpIdentities = {
    list: () => [{ id: "default", default: true }],
    onDidChange: () => ({ dispose: () => {} }),
    upstream: () => { throw new Error("The bridge's session factory opens sessions"); },
    authentication: () => ({ status: "not-required" }),
};

/**
 * Publish an MCP server as a LinkRPC service under `serviceId`.
 *
 * - `<interfaceId>` (`mcp.tools.<name>`) and `<interfaceId>.<group>`: one
 *   method per tool, re-registered when the server reports
 *   `tools/list_changed`. Capabilities can therefore apply per tool or group.
 * - `mcp.tools`: the tool catalog and generic `callTool`.
 * - `mcp.server`: state, plus exclusive sessions.
 *
 * Calls select an MCP identity (account) with `mcpIdentity`, or use the
 * default one. All callers of an identity share one MCP session unless they
 * open an exclusive one with `mcp.server::openSession` and pass its id as
 * `sessionId`. Exclusive session ids are unguessable and minted by the bridge;
 * holding one is what grants its use. An exclusive session belongs to the
 * identity it was opened for, so a capability that pins `mcpIdentity` cannot
 * be bypassed with another identity's session id.
 */
export async function registerMcpToolBridge(
    options: RegisterMcpToolBridgeOptions,
): Promise<McpToolBridgeRegistration> {
    assertGeneratedInterfaceId(options.interfaceId);
    assertToolGroups(options.groups ?? []);
    const identities = options.identities ?? fixedIdentities;
    const sessions = new McpSessionManager(options);
    /** Exclusive session id → its identity. */
    const exclusiveSessions = new Map<string, string>();
    const toolsChanged = sessions.onToolsChanged(() => scheduleRefresh());
    /** Identity ids at the last refresh, and those whose tool list it read. */
    let refreshedIdentities = new Set<string>();
    let listedIdentities = new Set<string>();
    const identitiesChanged = identities.onDidChange(() => {
        void onIdentitiesChanged();
    });
    const reflection = options.enableReflection === false
        ? undefined
        : options.connection.enableReflection({ serviceId: options.serviceId });
    const staticRegistrations: InterfaceRegistration[] = [];
    const watchers = new Set<{ readonly target: () => SessionTarget | undefined; send(state: McpServerState): void }>();
    const sessionStates = new Map<string, McpServerState["session"]>();
    const registrationOptions = {
        serviceId: options.serviceId,
        serviceDescription: options.serviceDescription,
    };
    let revision = 0;
    let serverState: McpServerState["server"] = { status: "starting" };
    let transportState: McpServerState["transport"] = { status: "disconnected" };
    let toolsState: McpServerState["tools"] = { status: "loading" };
    let catalog: readonly McpCatalogTool[] = [];
    let toolMethods: ReadonlyMap<string, GeneratedToolMethod> = new Map();
    let refreshChain: Promise<void> = Promise.resolve();
    let disposed = false;
    const applications = new Map<string, {
        readonly definition: InterfaceDefinition<MemberMap>;
        readonly registration: InterfaceRegistration;
    }>();

    function getState(target: SessionTarget | undefined): McpServerState {
        const identity = target === undefined
            ? undefined
            : identities.list().find((candidate) => candidate.id === target.identityId);
        const sessionId = target?.sessionId ?? sharedSessionId;
        return {
            revision,
            ...(identity !== undefined
                ? { identity: { id: identity.id, ...(identity.label !== undefined ? { label: identity.label } : {}) } }
                : {}),
            server: { ...serverState },
            transport: { ...transportState },
            authentication: target === undefined
                ? { status: "error", error: "No MCP identity is available" }
                : { ...identities.authentication(target.identityId) },
            tools: { ...toolsState },
            session: {
                ...((target === undefined ? undefined : sessionStates.get(sessionKey(target)))
                    ?? { sessionId, status: "absent" }),
            },
        };
    }

    function emitState(): void {
        revision++;
        for (const watcher of watchers) watcher.send(getState(watcher.target()));
    }

    function setSessionState(target: SessionTarget, status: McpServerState["session"]["status"], error?: string): void {
        sessionStates.set(sessionKey(target), {
            sessionId: target.sessionId,
            status,
            ...(error === undefined ? {} : { error }),
        });
        emitState();
    }

    function resolveIdentity(mcpIdentity: string | undefined): string {
        return resolveMcpIdentity(identities, mcpIdentity);
    }

    function resolveTarget(params: { readonly sessionId?: string; readonly mcpIdentity?: string }): SessionTarget {
        const identityId = resolveIdentity(params.mcpIdentity);
        const sessionId = params.sessionId;
        if (sessionId === undefined || sessionId === sharedSessionId) return { identityId, sessionId: sharedSessionId };
        const owner = exclusiveSessions.get(sessionId);
        if (owner === undefined) {
            throw new RpcError("Unknown or closed MCP bridge session", ErrorCode.invalidParams);
        }
        if (owner !== identityId) {
            throw new RpcError(
                "The MCP bridge session belongs to another MCP identity; pass its mcpIdentity",
                ErrorCode.invalidParams,
            );
        }
        return { identityId, sessionId };
    }

    async function useSession<T>(target: SessionTarget, operation: (session: McpClientSession) => Promise<T>): Promise<T> {
        if (!sessions.has(target.sessionId, target.identityId)) {
            setSessionState(target, "opening");
            transportState = { status: "connecting" };
            emitState();
        }
        try {
            const result = await sessions.use(target.sessionId, operation, target.identityId);
            setSessionState(target, "ready");
            transportState = { status: "connected" };
            if (serverState.status === "starting" || serverState.status === "idle") serverState = { status: "running" };
            emitState();
            return result;
        } catch (error) {
            const message = errorMessage(error);
            setSessionState(target, "error", message);
            transportState = { status: "error", error: message };
            emitState();
            const authentication = identities.authentication(target.identityId);
            if (authentication.status === "authorization-required") {
                throw new RpcError(
                    `MCP identity '${target.identityId}' requires authorization at ${authentication.authorizationUri}`,
                    ErrorCode.invalidRequest,
                );
            }
            throw error;
        }
    }

    function usableIdentities(): Set<string> {
        return new Set(identities.list()
            .filter((identity) => isUsable(identities.authentication(identity.id)))
            .map((identity) => identity.id));
    }

    /** Close sessions of removed identities; refresh tools when identities appear or become usable. */
    async function onIdentitiesChanged(): Promise<void> {
        if (disposed) return;
        const current = new Set(identities.list().map((identity) => identity.id));
        for (const identityId of refreshedIdentities) {
            if (current.has(identityId)) continue;
            for (const [sessionId, owner] of exclusiveSessions) {
                if (owner === identityId) exclusiveSessions.delete(sessionId);
            }
            await sessions.closeIdentity(identityId);
        }
        // A usable identity whose tools were not listed, e.g. one that just signed in.
        const appeared = [...current].some((identityId) => !refreshedIdentities.has(identityId))
            || current.size !== refreshedIdentities.size
            || [...usableIdentities()].some((identityId) => !listedIdentities.has(identityId));
        if (appeared) scheduleRefresh();
        else emitState();
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

    /**
     * List the tools of every identity and publish their union: a tool that
     * only some identities have is still one method, and the server rejects
     * calls of identities that lack it.
     */
    async function performRefresh(): Promise<void> {
        toolsState = { status: "loading" };
        emitState();
        const list = orderDefaultFirst(identities.list());
        let tools: readonly McpToolDefinition[];
        let toolIdentities: ReadonlyMap<string, readonly string[]>;
        let generated: ReturnType<typeof createMcpToolsInterfaces>;
        let listedNow = new Set<string>();
        try {
            const listed = await Promise.allSettled(list.map((identity) =>
                useSession({ identityId: identity.id, sessionId: sharedSessionId }, (session) => session.listTools())));
            listedNow = new Set(list.filter((_, index) => listed[index].status === "fulfilled").map((identity) => identity.id));
            const failures = listed.flatMap((result, index) =>
                result.status === "rejected" ? [{ identityId: list[index].id, error: result.reason as unknown }] : []);
            if (list.length > 0 && failures.length === list.length) throw failures[0].error;
            for (const failure of failures) {
                options.log?.(`Cannot list the tools of MCP identity '${failure.identityId}': ${errorMessage(failure.error)}`);
            }
            const union = mergeToolLists(list.map((identity, index) => ({
                identityId: identity.id,
                tools: listed[index].status === "fulfilled" ? listed[index].value : undefined,
            })), options.log);
            tools = union.tools;
            toolIdentities = union.identities;
            generated = createMcpToolsInterfaces(tools, options.interfaceId, options.groups);
        } catch (error) {
            const message = errorMessage(error);
            serverState = { status: "error", error: message };
            toolsState = { status: "error", error: message };
            emitState();
            throw error;
        } finally {
            refreshedIdentities = new Set(list.map((identity) => identity.id));
            listedIdentities = listedNow;
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
                    const { target, args } = readToolCallParams(rawParams);
                    return invokeTool(toolName, method, resolveTarget(target), args, stream.signal);
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
                identities: [...(toolIdentities.get(tool.name) ?? [])],
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
        target: SessionTarget,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<JsonValue> {
        assertSchemaValue(method.params, { ...args }, method.components, "params");
        const result = await useSession(target, (session) => session.callTool(toolName, args, signal));
        assertSchemaValue(method.result, result, method.components, "result");
        return result;
    }

    staticRegistrations.push(options.connection.register(mcpToolsInterface, {
        listTools: async (): Promise<McpToolCatalog> => {
            await refreshChain;
            const fallback = defaultMcpIdentity(identities.list());
            return {
                interfaces: interfaceSummaries(),
                tools: catalog.map((tool) => ({ ...tool })),
                ...(fallback !== undefined ? { defaultIdentity: fallback.id } : {}),
            };
        },
        callTool: async ({ sessionId, mcpIdentity, name, arguments: args }, _ctx, stream) => {
            await refreshChain;
            const method = toolMethods.get(name);
            if (method === undefined) throw new RpcError(`Unknown MCP tool: ${name}`, ErrorCode.invalidParams);
            for (const reserved of reservedToolParams) {
                if (args !== undefined && reserved in args) {
                    throw new RpcError(`Pass ${reserved} next to arguments, not inside them`, ErrorCode.invalidParams);
                }
            }
            const target = resolveTarget({ sessionId, mcpIdentity });
            return callToolResultSchema.parse(
                await invokeTool(name, method, target, args ?? {}, stream.signal),
            ) as never;
        },
    }, registrationOptions));

    staticRegistrations.push(options.connection.register(mcpServerInterface, {
        getState: (params) => getState(resolveTarget(params)),
        watchState: (params, _ctx, stream) => {
            resolveTarget(params);
            const watcher = {
                // Identities can disappear while watching.
                target: () => {
                    try {
                        return resolveTarget(params);
                    } catch {
                        return undefined;
                    }
                },
                send: (state: McpServerState) => void stream.send(state),
            };
            return new Promise((resolve) => {
                watchers.add(watcher);
                watcher.send(getState(watcher.target()));
                const finish = () => {
                    watchers.delete(watcher);
                    resolve({});
                };
                if (stream.signal.aborted) finish();
                else stream.signal.addEventListener("abort", finish, { once: true });
            });
        },
        openSession: async ({ mcpIdentity }) => {
            const identityId = resolveIdentity(mcpIdentity);
            const sessionId = globalThis.crypto.randomUUID();
            exclusiveSessions.set(sessionId, identityId);
            try {
                await useSession({ identityId, sessionId }, async () => undefined);
            } catch (error) {
                exclusiveSessions.delete(sessionId);
                await sessions.close(sessionId, identityId);
                throw error;
            }
            return { sessionId };
        },
        closeSession: async (params) => {
            const target = resolveTarget(params);
            setSessionState(target, "closing");
            const closed = await sessions.close(target.sessionId, target.identityId);
            exclusiveSessions.delete(target.sessionId);
            if (target.sessionId === sharedSessionId) setSessionState(target, closed ? "closed" : "absent");
            else sessionStates.delete(sessionKey(target));
            if (sessions.activeSessionCount === 0) {
                transportState = { status: "disconnected" };
                serverState = { status: "idle" };
            }
            emitState();
            return { closed };
        },
        restartSession: async (params) => {
            const target = resolveTarget(params);
            await sessions.close(target.sessionId, target.identityId);
            await useSession(target, async () => undefined);
            if (target.sessionId === sharedSessionId) await enqueueRefresh();
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
        getState: (target = {}) => getState(resolveTarget(target)),
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
            identitiesChanged.dispose();
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
    readonly target: { readonly sessionId?: string; readonly mcpIdentity?: string };
    readonly args: Readonly<Record<string, unknown>>;
} {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new RpcError("MCP tool call params must be an object", ErrorCode.invalidParams);
    }
    const { sessionId, mcpIdentity, ...args } = value as Readonly<Record<string, unknown>>;
    if (sessionId !== undefined && typeof sessionId !== "string") {
        throw new RpcError("MCP tool call sessionId must be a string", ErrorCode.invalidParams);
    }
    if (mcpIdentity !== undefined && typeof mcpIdentity !== "string") {
        throw new RpcError("MCP tool call mcpIdentity must be a string", ErrorCode.invalidParams);
    }
    return {
        target: {
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(mcpIdentity !== undefined ? { mcpIdentity } : {}),
        },
        args,
    };
}

function sessionKey(target: SessionTarget): string {
    return `${target.identityId}\u0000${target.sessionId}`;
}

function isUsable(state: McpAuthenticationState): boolean {
    return state.status === "ready" || state.status === "not-required";
}

function orderDefaultFirst<T extends { readonly id: string; readonly default?: boolean }>(list: readonly T[]): T[] {
    const fallback = defaultMcpIdentity(list);
    return fallback === undefined ? [...list] : [fallback as T, ...list.filter((identity) => identity !== fallback)];
}

/** Union of the identities' tool lists; the first identity's definition of a tool wins. */
function mergeToolLists(
    lists: readonly { readonly identityId: string; readonly tools: readonly McpToolDefinition[] | undefined }[],
    log: ((line: string) => void) | undefined,
): { readonly tools: McpToolDefinition[]; readonly identities: Map<string, string[]> } {
    const tools = new Map<string, McpToolDefinition>();
    const identities = new Map<string, string[]>();
    for (const { identityId, tools: list } of lists) {
        for (const tool of list ?? []) {
            const existing = tools.get(tool.name);
            if (existing === undefined) {
                tools.set(tool.name, tool);
                identities.set(tool.name, [identityId]);
                continue;
            }
            identities.get(tool.name)!.push(identityId);
            if (JSON.stringify(existing.inputSchema) !== JSON.stringify(tool.inputSchema)) {
                log?.(`MCP tool '${tool.name}' of identity '${identityId}' has another input schema; using the first`);
            }
        }
    }
    return { tools: [...tools.values()], identities };
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
