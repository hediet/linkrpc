/// <reference path="./md.d.ts" />
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, RpcError } from "@hediet/linkrpc";
import type { ResolvedEndpoint } from "@hediet/linkrpc/node";
import { z } from "zod";
import { ConnectionPool, type DefaultTransport, type HubAccess, type IConnectionPool, type PooledConnection } from "./connectionPool";
import { type HubSenderProvider, ProviderPool } from "./senderProvider";
import { summarizeGrants } from "./grants";
import { startSandbox, type SandboxHostApi } from "./sandbox";
import { TaskRegistry } from "./taskRegistry";
import { explore } from "./explore";
import {
    presentToolResult,
    scriptResultValue,
    type ResultPresentationMode,
} from "./resultPresentation";

export interface McpToolCall {
    readonly name: string;
    readonly arguments: unknown;
    readonly result: unknown;
}

export type McpExploreCall =
    | { readonly arguments: unknown; readonly result: unknown }
    | { readonly arguments: unknown; readonly error: string };

export interface LinkRpcMcpServerOptions {
    /**
     * Endpoint used when the tool call does not supply a `connection`. When
     * omitted, the server falls back to the `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN`
     * environment variables (the stdio CLI mode).
     */
    readonly defaultEndpoint?: ResolvedEndpoint;
    /**
     * Connection pool to use. Defaults to a real {@link ConnectionPool}.
     * Injectable so tests can supply a fake pool without a live hub.
     */
    readonly pool?: IConnectionPool;
    /**
     * Resolves a signing sender per MCP session / `connection` argument instead
     * of dialing an endpoint. When set (and no explicit `pool` is given), the
     * server uses a {@link ProviderPool} — the consumer-provisioned identity
     * mode. Mutually exclusive with `defaultEndpoint`.
     */
    readonly provider?: HubSenderProvider;
    /**
     * Supplies the **default** connection (used when a tool call omits
     * `connection`) over an in-process transport — typically a leg into an
     * in-process hub participant — instead of dialing a socket. Explicit
     * `connection` endpoint URIs still dial normally. Combine with
     * {@link defaultEndpoint} to additionally set a dialed fallback; mutually
     * exclusive with `pool` / `provider`.
     */
    readonly defaultConnection?: () => DefaultTransport;
    /** Observes completed MCP tool calls exactly as their result is returned to the client. */
    readonly onToolCall?: (call: McpToolCall) => void;
    /** Observes every sandbox `con.explore` call, including calls that fail. */
    readonly onExploreCall?: (call: McpExploreCall) => void;
}

const CONNECTION_SCHEMA = z.string().optional().describe(
    "Endpoint URI of the hub to connect to, e.g. `unix:/run/hub.sock?token=…`, " +
    "`npipe://./pipe/vscode-linkrpc-…?token=…`, or `wss://host:port?token=…`. " +
    "The token may be embedded as a `token` query param or supplied via the " +
    "LINKRPC_TOKEN environment variable. When omitted entirely, the server falls " +
    "back to the LINKRPC_ENDPOINT and LINKRPC_TOKEN environment variables.",
);

const PRESENTATION_SCHEMA = z.enum(["auto", "raw"]).optional().describe(
    "How to present the returned value. `auto` (default) recognizes MCP content blocks, " +
    "data URLs, common base64 media signatures, and `{ data|base64|blob, mimeType }` " +
    "objects, emitting native image/audio/resource content while keeping the original " +
    "value available to subsequent scripts through `lastResultVal`. `raw` disables " +
    "transformation and exposes the original JSON/base64.",
);

const SERVER_NAME = "linkrpc-mcp";
const SERVER_VERSION = "0.0.1";

/**
 * MCP server exposing the `runLinkRpcScript` tool plus task-management helpers.
 *
 * Documentation for the sandbox API (`con`) is reachable from inside the
 * sandbox via `con.getDocs()` rather than an MCP resource — that way the
 * model can pull it in by issuing a one-line `runLinkRpcScript` call.
 *
 * Can be hosted over stdio (CLI mode, via {@link startStdio}) or over any
 * MCP {@link Transport} (e.g. Streamable HTTP, used by the VS Code Team
 * Tools extension which embeds this server in-process).
 */
export class LinkRpcMcpServer {
    public static async startStdio(options?: LinkRpcMcpServerOptions): Promise<LinkRpcMcpServer> {
        const server = new LinkRpcMcpServer(options);
        await server.connect(new StdioServerTransport());
        return server;
    }

    private readonly _mcp: SdkMcpServer;
    private readonly _pool: IConnectionPool;
    private readonly _tasks = new TaskRegistry();
    private readonly _onToolCall: ((call: McpToolCall) => void) | undefined;
    private readonly _onExploreCall: ((call: McpExploreCall) => void) | undefined;

    public constructor(options: LinkRpcMcpServerOptions = {}) {
        this._mcp = new SdkMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
        this._onToolCall = options.onToolCall;
        this._onExploreCall = options.onExploreCall;
        this._pool = options.pool
            ?? (options.provider
                ? new ProviderPool(options.provider)
                : new ConnectionPool({
                    defaultEndpoint: options.defaultEndpoint,
                    ...(options.defaultConnection
                        ? { defaultTransport: options.defaultConnection }
                        : {}),
                }));
        this._registerTools();
    }

    public async connect(transport: Transport): Promise<void> {
        await this._mcp.connect(transport);
    }

    public dispose(): void {
        this._tasks.dispose();
        this._pool.dispose();
    }

    private _registerTools(): void {
        this._mcp.registerTool(
            "runLinkRpcScript",
            {
                title: "Run JS against a linkrpc hub",
                description:
                    "Evaluate a JS function inside a QuickJS sandbox with `con` (the live hub " +
                    "connection), `lastResultVal` (previous call's original result), and " +
                    "`mcp` (optional result-presentation helpers) in scope.\n\n" +
                    "Before composing non-trivial calls, fetch the full sandbox API docs by " +
                    "running:\n" +
                    "  `async ({ con }) => con.getDocs()`\n" +
                    "That returns the TypeScript declarations for the full script context, " +
                    "including `con`, `mcp`, sandbox limits, and available console.\n\n" +
                    "`code` MUST be a function expression, e.g.\n" +
                    "  `({ con }) => con.call(\"vscode\", \"vscode.window\", \"showInformationMessage\", { message: \"hi\" })`\n\n" +
                    "Set `connection` to a hub endpoint URI (e.g. `unix:/path?token=…` or " +
                    "`wss://host?token=…`) to target a specific hub, or leave it out to use " +
                    "the LINKRPC_ENDPOINT / LINKRPC_TOKEN env vars.\n\n" +
                    "ACCESS IS NOT AUTOMATIC: a gated `con.call(...)` is NOT silently " +
                    "granted. Reflection (`con.explore`) works out of the box, but calling " +
                    "a service member you have no capability for fails with a permission " +
                    "error. Inspect what you already hold with `con.grants()`, then ask " +
                    "the user for access — ideally for MANY members at once — with " +
                    "`con.requestAccess({ permissions, duration })`. Pick `duration`: `once` for a " +
                    "one-off, `session` for the rest of this connection, `persistent` to " +
                    "remember across runs. Batch related permissions into a single request " +
                    "so the user sees one prompt instead of many.\n\n" +
                    "BACKGROUND TASKS: if the code is still awaiting I/O (an RPC reply, a " +
                    "user dialog, a stream) when `foregroundMs` elapses, the call does NOT " +
                    "fail — it is parked as a background task and the result is " +
                    "`{ status: \"running\", taskId, debugName, inFlight }`. Use " +
                    "`awaitLinkRpcTask` to wait for it or `cancelLinkRpcTask` to abandon " +
                    "it. Set `label` to give the task a " +
                    "clear debug name. Starting a new `runLinkRpcScript` " +
                    "cancels any task still parked (reported as `supersededTask`).\n\n" +
                    "RESULT PRESENTATION: returned image/audio/resource data is automatically " +
                    "emitted as native MCP content when it is a data URL, recognizable base64, " +
                    "an MCP content block, or an object shaped like " +
                    "`{ data|base64|blob, mimeType }`. This happens only after the script " +
                    "finishes: values passed between hub calls and saved in `lastResultVal` " +
                    "remain original and unmodified. Use `presentation: \"raw\"` or " +
                    "`mcp.raw(value)` when the model needs the literal base64. Use `mcp.image`, " +
                    "`mcp.audio`, `mcp.resource`, `mcp.resourceLink`, or `mcp.result` for " +
                    "explicit control. Native content always includes JSON text and structured " +
                    "fallbacks.\n\n" +
                    "The result contains `{ status, result | taskId, logs, endpoint }`. " +
                    "Pass `trace: true` to also receive a per-call JSON-RPC wire log under " +
                    "`trace` — useful when a call fails or returns unexpected data.",
                inputSchema: {
                    connection: CONNECTION_SCHEMA,
                    code: z.string().describe(
                        "JS function expression. Receives `{ con, lastResultVal, mcp }`. " +
                        "Sync or async. Return value is JSON-stringified.",
                    ),
                    presentation: PRESENTATION_SCHEMA,
                    label: z.string().optional().describe(
                        "Human-readable debug name for the task if it gets parked, e.g. " +
                        "\"ask user to confirm deploy\". When omitted, the name is inferred " +
                        "from the in-flight RPC(s) at park time.",
                    ),
                    foregroundMs: z.number().int().positive().optional().describe(
                        "How long the call runs synchronously before being parked as a " +
                        "background task. Defaults to 5000.",
                    ),
                    maxLifetimeMs: z.number().int().positive().optional().describe(
                        "Absolute lifetime cap for a parked task before it is cancelled. " +
                        "Defaults to 120000.",
                    ),
                    trace: z.boolean().optional().describe(
                        "When true, include a `trace` array in the result with every " +
                        "outbound JSON-RPC request / notification, its outcome, and " +
                        "every permission round-trip. Off by default to keep results small.",
                    ),
                },
                annotations: {
                    // LinkRPC performs its own capability checks and consent flow, so MCP
                    // clients can skip a redundant outer approval prompt.
                    readOnlyHint: true,
                },
            },
            async (args) => this._observeToolCall("runLinkRpcScript", args, async () => {
                let pooled: PooledConnection;
                try {
                    pooled = await this._pool.resolve(args.connection);
                } catch (e) {
                    return _errorResult(_describeError(e));
                }

                // A new request supersedes any task still parked — cancel it
                // before running the new code.
                const superseded = await this._tasks.cancelLive();

                // Capture every trace line produced during this run (transport
                // I/O + permission requests). Returned in the tool result so the
                // calling AI can see exactly what hit the wire — stderr only
                // reaches the MCP host's log surface, not the model. Only collected
                // when the caller opts in via `trace: true`, otherwise the listener
                // is never registered and the result stays small.
                const traceEnabled = args.trace === true;
                const trace: string[] = [];
                const disposeTrace = traceEnabled
                    ? pooled.addTraceListener((line) => trace.push(line))
                    : () => { /* no-op */ };

                const host: SandboxHostApi = {
                    call: async (method, paramsJson, optsJson, onStreamMessage, signal) => {
                        // Most linkrpc schemas validate against `z.object({...})`, which
                        // rejects `undefined`. Default omitted params to `{}` so
                        // `con.call(s,i,m)` works the same as `con.call(s,i,m,{})`.
                        const params = paramsJson === "" ? {} : JSON.parse(paramsJson);
                        const opts: { readonly requestPermission?: boolean } =
                            optsJson === "" ? {} : JSON.parse(optsJson);
                        const requestPermission = opts.requestPermission === true;
                        const send = async () => {
                            if (signal.aborted) {
                                const error = new Error(`AbortError: ${String(signal.reason ?? "cancelled")}`);
                                error.name = "AbortError";
                                throw error;
                            }
                            const call = pooled.channel.sendRequestWithStream(method, params, {
                                onStreamMessage: (payload) =>
                                    onStreamMessage(JSON.stringify(payload)),
                            });
                            const cancel = () => {
                                const reason = String(signal.reason ?? "cancelled");
                                call.cancel(reason);
                                call.dispose?.(reason);
                            };
                            signal.addEventListener("abort", cancel, { once: true });
                            try {
                                return await call.result;
                            } finally {
                                signal.removeEventListener("abort", cancel);
                            }
                        };
                        // Calls are NOT auto-granted: the channel presents only the
                        // caps already in the bag (reflection + explicitly requested
                        // grants). A gated form-3 call with no covering cap fails with
                        // `permissionRequired`. With `requestPermission`, negotiate a
                        // cap for exactly this call and retry once; otherwise rethrow
                        // with guidance toward `con.requestAccess(...)`.
                        try {
                            const result = await send();
                            return JSON.stringify(result ?? null);
                        } catch (e) {
                            if (requestPermission && _isPermissionError(e)) {
                                const granted = await _autoRequestAccess(pooled.session, method);
                                if (granted) {
                                    const result = await send();
                                    return JSON.stringify(result ?? null);
                                }
                            }
                            throw _enrichPermissionError(e, method);
                        }
                    },
                    notify: async (method, paramsJson) => {
                        const params = paramsJson === "" ? {} : JSON.parse(paramsJson);
                        await pooled.channel.sendNotification(method, params);
                        return "";
                    },
                    explore: async (argsJson) => {
                        const exploreArgs = argsJson === "" ? {} : JSON.parse(argsJson);
                        // By default `explore` only uses the persistent reflection
                        // capabilities cached on the channel by `setupSigning`. With
                        // `requestPermission: true`, the first gated directory triggers
                        // a single broad reflection grant (`linkrpc.*` on every service)
                        // through the same `hubAccess` door `con.call` uses; it's
                        // memoized so the whole walk costs at most one consent.
                        let reflectionGrant: Promise<boolean> | undefined;
                        try {
                            const result = await explore(pooled.channel, exploreArgs, {
                                requestReflectionAccess: () =>
                                    (reflectionGrant ??= _requestReflectionAccess(pooled.session)),
                            });
                            this._observeExploreCall({ arguments: exploreArgs, result });
                            return JSON.stringify(result);
                        } catch (error) {
                            this._observeExploreCall({
                                arguments: exploreArgs,
                                error: error instanceof Error ? error.message : String(error),
                            });
                            throw error;
                        }
                    },
                    requestAccess: async (argsJson) => {
                        const req = argsJson === "" ? {} : JSON.parse(argsJson);
                        const result = await pooled.session.requestAccess({
                            consumer: { name: "linkrpc-mcp", purpose: req.purpose },
                            permissions: req.permissions ?? [],
                            duration: req.duration,
                        });
                        return JSON.stringify(result);
                    },
                    grants: async () => JSON.stringify(summarizeGrants(pooled.session.listGrants())),
                };

                try {
                    const outcome = await startSandbox(args.code, host, pooled.lastResultVal, {
                        foregroundMs: args.foregroundMs,
                        maxLifetimeMs: args.maxLifetimeMs,
                        label: args.label,
                    });

                    if (outcome.status === "completed") {
                        pooled.lastResultVal = scriptResultValue(outcome.result);
                        return presentToolResult({
                            status: "completed",
                            result: outcome.result,
                            logs: outcome.logs,
                            ...(traceEnabled ? { trace } : {}),
                            endpoint: pooled.endpoint,
                            ...(superseded ? { supersededTask: superseded } : {}),
                        }, args.presentation);
                    }

                    if (outcome.status === "error") {
                        return _errorResult(
                            `runLinkRpcScript failed: ${outcome.error}`,
                            traceEnabled ? trace : undefined,
                        );
                    }

                    // Parked: register the task and report it as running. The
                    // debug name + in-flight labels come straight from the live
                    // sandbox, so they accurately describe what it's waiting on.
                    const taskId = this._tasks.register(
                        pooled.endpoint,
                        outcome.debugName,
                        outcome.task,
                        (result) => { pooled.lastResultVal = scriptResultValue(result); },
                    );
                    return presentToolResult({
                        status: "running",
                        taskId,
                        debugName: outcome.debugName,
                        inFlight: outcome.task.inFlight(),
                        logsSoFar: outcome.task.logs,
                        ...(traceEnabled ? { traceSoFar: trace } : {}),
                        endpoint: pooled.endpoint,
                        ...(superseded ? { supersededTask: superseded } : {}),
                    }, "raw");
                } catch (e) {
                    return _errorResult(
                        `runLinkRpcScript failed: ${_describeError(e)}`,
                        traceEnabled ? trace : undefined,
                    );
                } finally {
                    disposeTrace();
                }
            }),
        );

        this._mcp.registerTool(
            "awaitLinkRpcTask",
            {
                title: "Wait for a parked linkrpc task",
                description:
                    "Wait up to `timeoutMs` for a background task started by `runLinkRpcScript` " +
                    "to settle. Returns `{ status: \"completed\" | \"error\" | \"cancelled\" " +
                    "| \"running\", … }`. A `running` result means it is still going (with a " +
                    "progress snapshot) — call again to keep waiting. Does NOT cancel the task.",
                inputSchema: {
                    taskId: z.string().describe("Task id returned by `runLinkRpcScript`."),
                    timeoutMs: z.number().int().positive().optional().describe(
                        "How long to wait before returning a `running` snapshot. Defaults to 30000.",
                    ),
                    presentation: PRESENTATION_SCHEMA,
                },
                annotations: { readOnlyHint: true },
            },
            async (args) => this._observeToolCall("awaitLinkRpcTask", args, async () => {
                const res = await this._tasks.awaitTask(args.taskId, args.timeoutMs ?? 30_000);
                if (res.status === "unknown") {
                    return _errorResult(`No task with id ${args.taskId}`);
                }
                return _presentTaskResult(res, args.presentation);
            }),
        );

        this._mcp.registerTool(
            "cancelLinkRpcTask",
            {
                title: "Cancel a parked linkrpc task",
                description:
                    "Soft-abort a background task started by `runLinkRpcScript` and return its " +
                    "terminal outcome. The guest gets a short grace window to run cleanup.",
                inputSchema: {
                    taskId: z.string().describe("Task id returned by `runLinkRpcScript`."),
                    presentation: PRESENTATION_SCHEMA,
                },
                // Cancelling only affects a task created through this MCP session.
                annotations: { readOnlyHint: true },
            },
            async (args) => this._observeToolCall("cancelLinkRpcTask", args, async () => {
                const res = await this._tasks.cancel(args.taskId);
                if (res.status === "unknown") {
                    return _errorResult(`No task with id ${args.taskId}`);
                }
                return _presentTaskResult(res, args.presentation);
            }),
        );

    }

    private async _observeToolCall<Args, Result>(
        name: string,
        args: Args,
        invoke: () => Promise<Result>,
    ): Promise<Result> {
        const result = await invoke();
        try {
            this._onToolCall?.({ name, arguments: args, result });
        } catch {
            // Observability must not change the tool result.
        }
        return result;
    }

    private _observeExploreCall(call: McpExploreCall): void {
        try {
            this._onExploreCall?.(call);
        } catch {
            // Observability must not change exploration behavior.
        }
    }
}

function _presentTaskResult(
    value: Readonly<Record<string, unknown>>,
    mode: ResultPresentationMode | undefined,
) {
    try {
        return presentToolResult(value, mode);
    } catch (e) {
        return _errorResult(`Failed to present task result: ${_describeError(e)}`);
    }
}

function _errorResult(message: string, trace?: readonly string[]): {
    content: { type: "text"; text: string }[];
    isError: true;
} {
    const body = trace && trace.length > 0
        ? `${message}\n\nTrace:\n${trace.join("\n")}`
        : message;
    return {
        content: [{ type: "text", text: body }],
        isError: true,
    };
}

/**
 * Render an unknown thrown value as a debuggable string: the error's stack
 * (which already begins with `Name: message`) plus the full `cause` chain. The
 * MCP host only forwards the result text to the model — never a JS stack — so
 * without this every failure collapses to a single bare message line.
 */
function _describeError(e: unknown): string {
    if (!(e instanceof Error)) return String(e);
    let out = typeof e.stack === "string" && e.stack.length > 0 ? e.stack : e.message;
    let cause: unknown = (e as { cause?: unknown }).cause;
    while (cause != null) {
        if (cause instanceof Error) {
            out += `\n\nCaused by: ${typeof cause.stack === "string" && cause.stack.length > 0 ? cause.stack : cause.message
                }`;
            cause = (cause as { cause?: unknown }).cause;
        } else {
            out += `\n\nCaused by: ${String(cause)}`;
            break;
        }
    }
    return out;
}

/**
 * Map a hub `permissionRequired` (-32401) error to an actionable message that
 * points the model at the explicit access flow. Other errors pass through
 * unchanged (re-wrapped as an `Error` when they are not already one).
 */
function _enrichPermissionError(e: unknown, method: string): Error {
    if (_isPermissionError(e)) {
        const { serviceId, interfaceId, member } = _parseMethod(method);
        const original = e instanceof Error ? e.message : String(e);
        return new Error(
            `Permission required for ${method} — no capability is held for this call.\n` +
            `Inspect current access with con.grants(), then ` +
            `request it with con.requestAccess({ permissions: [{ target: { ` +
            `serviceId: { exact: ${JSON.stringify(serviceId)} }, ` +
            `interfaceId: { exact: ${JSON.stringify(interfaceId)} }, ` +
            `members: [{ exact: ${JSON.stringify(member)} }] }, canInvoke: true }], ` +
            `duration: "longLived" }).\nOriginal error: ${original}`,
        );
    }
    return e instanceof Error ? e : new Error(String(e));
}

/** True when `e` is a hub `permissionRequired` (-32401) error. */
function _isPermissionError(e: unknown): boolean {
    return e instanceof RpcError
        ? e.code === ErrorCode.permissionRequired
        : (typeof e === "object" && e !== null && (e as { code?: unknown }).code === ErrorCode.permissionRequired);
}

/**
 * Split a JSON-RPC method name into its `(serviceId, interfaceId, member)`
 * parts. Form-3 (`serviceId::interfaceId::member`) keeps the serviceId; form-2
 * (`interfaceId::member`, a root/hub call) reports an empty serviceId.
 */
function _parseMethod(method: string): { serviceId: string; interfaceId: string; member: string } {
    const parts = method.split("::");
    if (parts.length >= 3) {
        return { serviceId: parts[0], interfaceId: parts[1], member: parts.slice(2).join("::") };
    }
    return { serviceId: "", interfaceId: parts[0] ?? "", member: parts[1] ?? "" };
}

/**
 * Negotiate durable capabilities for the reflection methods the bus walk uses
 * — `hubrpc.directory::list` (enumeration) and `hubrpc.schemas::get` (schema
 * fetch) — across *all* service ids, through the hub's `hubAccess` consent
 * door. One grant unlocks enumeration of every gated directory the walk
 * reaches, so `explore({ requestPermission: true })` only needs a single
 * consent round-trip. Returns `true` when the grant was issued.
 */
async function _requestReflectionAccess(session: HubAccess): Promise<boolean> {
    const result = await session.requestAccess({
        consumer: { name: "linkrpc-mcp", purpose: "explore the hub (reflection)" },
        permissions: [
            {
                target: {
                    serviceId: { prefix: "" },
                    interfaceId: { exact: "hubrpc.directory" },
                    members: [{ exact: "list" }],
                },
                canInvoke: true,
            },
            {
                target: {
                    serviceId: { prefix: "" },
                    interfaceId: { exact: "hubrpc.schemas" },
                    members: [{ exact: "get" }],
                },
                canInvoke: true,
            },
        ],
        duration: "longLived",
    });
    return result.status === "granted";
}

/**
 * Negotiate a durable capability for exactly `method` through the hub's
 * `hubAccess` consent door (the `requestPermission: true` path of `con.call`).
 * Returns `true` when the grant was issued — its durable cap joins the
 * connection's bag, so the caller can retry the call.
 */
async function _autoRequestAccess(session: HubAccess, method: string): Promise<boolean> {
    const { serviceId, interfaceId, member } = _parseMethod(method);
    const result = await session.requestAccess({
        consumer: { name: "linkrpc-mcp", purpose: `invoke ${method}` },
        permissions: [{
            target: {
                serviceId: { exact: serviceId },
                interfaceId: { exact: interfaceId },
                members: [{ exact: member }],
            },
            canInvoke: true,
        }],
        duration: "longLived",
    });
    return result.status === "granted";
}
