// ---- runLinkRpcScript sandbox API ----------------------------------------
//
// The MCP tool `runLinkRpcScript` takes `code` (a JS function expression) and
// invokes it inside a QuickJS sandbox with the signature below. Anything the
// function returns (sync or async) becomes the tool's result, JSON-encoded.
//
//     ({ con, lastResultVal, mcp }) => any | Promise<any>
//
// Example:
//
//     ({ con }) => con.call("vscode", "vscode.window",
//                           "showInformationMessage",
//                           { message: "hello" })
//
// The sandbox is isolated: no `require`, no `process`, no host globals
// other than the ones declared here. Memory is capped (~32 MB) and execution
// is interrupted after ~5 s.

interface RunSvcContext {
    /** The live connection wired to the requested hub. */
    readonly con: SvcConnection;
    /**
     * The value returned by the previous `runLinkRpcScript` call on the same hub
     * connection. JSON round-tripped — non-serialisable members are dropped.
     * `undefined` on the first call.
     */
    readonly lastResultVal: unknown;
    /**
     * Optional presentation helpers. Ordinary return values are automatically
     * converted to native MCP image/audio/resource blocks when possible.
     */
    readonly mcp: McpPresentation;
}

interface McpAnnotations {
    readonly audience?: ReadonlyArray<"user" | "assistant">;
    readonly priority?: number;
    readonly lastModified?: string;
}

type McpMeta = Record<string, unknown>;

type McpContentBlock =
    | {
        readonly type: "text";
        readonly text: string;
        readonly annotations?: McpAnnotations;
        readonly _meta?: McpMeta;
    }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
        readonly annotations?: McpAnnotations;
        readonly _meta?: McpMeta;
    }
    | {
        readonly type: "audio";
        readonly data: string;
        readonly mimeType: string;
        readonly annotations?: McpAnnotations;
        readonly _meta?: McpMeta;
    }
    | {
        readonly type: "resource";
        readonly resource:
            | { readonly uri: string; readonly mimeType?: string; readonly text: string; readonly _meta?: McpMeta }
            | { readonly uri: string; readonly mimeType?: string; readonly blob: string; readonly _meta?: McpMeta };
        readonly annotations?: McpAnnotations;
        readonly _meta?: McpMeta;
    }
    | {
        readonly type: "resource_link";
        readonly uri: string;
        readonly name: string;
        readonly title?: string;
        readonly description?: string;
        readonly mimeType?: string;
        readonly size?: number;
        readonly annotations?: McpAnnotations;
        readonly icons?: ReadonlyArray<{
            readonly src: string;
            readonly mimeType?: string;
            readonly sizes?: ReadonlyArray<string>;
            readonly theme?: "light" | "dark";
        }>;
        readonly _meta?: McpMeta;
    };

interface McpPresentation {
    /** Suppress automatic presentation for this value and expose its original JSON. */
    raw<T>(value: T): T;
    text(text: string, annotations?: McpAnnotations): McpContentBlock;
    image(data: string, mimeType: string, annotations?: McpAnnotations): McpContentBlock;
    audio(data: string, mimeType: string, annotations?: McpAnnotations): McpContentBlock;
    resource(
        resource:
            | {
                readonly uri: string;
                readonly mimeType?: string;
                readonly text: string;
                readonly _meta?: McpMeta;
            }
            | {
                readonly uri: string;
                readonly mimeType?: string;
                readonly blob: string;
                readonly _meta?: McpMeta;
            },
        annotations?: McpAnnotations,
    ): McpContentBlock;
    resourceLink(
        resource: Omit<Extract<McpContentBlock, { readonly type: "resource_link" }>, "type">,
    ): McpContentBlock;
    /** Mark any MCP content block for validation when the script result is presented. */
    content(block: McpContentBlock): McpContentBlock;
    /**
     * Return custom MCP content alongside a separate logical value. `value` is
     * what the next call receives as `lastResultVal`.
     */
    result(options: {
        readonly value?: unknown;
        readonly structuredContent?: Record<string, unknown>;
        readonly content?: ReadonlyArray<McpContentBlock>;
        readonly isError?: boolean;
        readonly _meta?: McpMeta;
    }): unknown;
}

interface SvcConnection {
    /**
     * Cooperative cancellation signal. When the sandbox is ~200 ms away
     * from its hard timeout (and the configured `timeoutMs` was at least
     * 500 ms), the host flips `aborted` to `true`, sets `reason`, and
     * rejects every in-flight host promise with an `AbortError`. This
     * gives the guest a small grace window to run `finally` blocks,
     * persist partial state, or return a partial result before the hard
     * interrupt kicks in. Subsequent `con.call` / `con.notify` /
     * `con.explore` calls in this window reject immediately so the guest
     * doesn't spend its grace window waiting for another RPC.
     *
     * Idiomatic use:
     *
     *     try {
     *         return await con.call(s, i, m, params);
     *     } catch (e) {
     *         if (con.abortSignal.aborted) return { partial: true };
     *         throw e;
     *     }
     */
    readonly abortSignal: {
        readonly aborted: boolean;
        readonly reason: string | undefined;
        throwIfAborted(): void;
    };

    /**
     * Invoke a request on the bus.
     *   - Form 3 (most common): pass `serviceId` to address a specific
     *     participant: `con.call("vscode", "vscode.window", "showInformationMessage", { message })`.
     *   - Form 2: pass `serviceId: ""` to address the hub itself (the
     *     root): `con.call("", "hubDirectory", "listPrefixes")`.
     *
     * Rejects with an `Error` that carries the RPC error message when the
     * peer returns a JSON-RPC error.
     *
     * Access is NOT automatic: a gated member you hold no capability for
     * rejects with a permission error. Check `con.grants()` and request
     * access via `con.requestAccess(...)` first — or pass
     * `{ requestPermission: true }` to have this call auto-negotiate the
     * capability it needs (a single `hubAccess` round-trip) and retry once.
     *
     * Streaming methods can report server-to-client messages while the request
     * is pending:
     *
     *     const progress = [];
     *     const result = await con.call("svc", "jobs", "run", {}, {
     *         onStreamMessage: message => {
     *             progress.push(message);
     *             console.log("progress", message);
     *         },
     *     });
     *
     * When `onStreamMessage` is omitted, each stream message is written to
     * `console.log` with the wire method name. This makes a parked streaming
     * call observable through `awaitLinkRpcTask` without extra callback code.
     */
    call(
        serviceId: string,
        interfaceId: string,
        member: string,
        params?: unknown,
        options?: CallOptions,
    ): Promise<unknown>;

    /** Fire-and-forget variant of `call`. Returns once the notification has been sent. */
    notify(
        serviceId: string,
        interfaceId: string,
        member: string,
        params?: unknown,
    ): Promise<void>;

    /**
     * Escape hatch when you have a fully-formed JSON-RPC method name (e.g.
     * `"vscode::vscode.window::showInformationMessage"`). Prefer `call`.
     */
    callRaw(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
    notifyRaw(method: string, params?: unknown): Promise<void>;

    /**
     * Discover and inspect the interfaces on the bus.
     *
     *   - `{ kind: "browse" }` lists stable virtual-document identities. Use
     *     exact `serviceId` / `interfaceId` filters to narrow the directory.
     *   - `{ kind: "grep", pattern }` searches the generated, self-contained
     *     `defineInterface` source for every candidate. `pattern` is a
     *     case-insensitive regular expression by default; set `syntax:
     *     "literal"` for a case-insensitive substring. Results contain the
     *     matching line, nearby source context, and enclosing member name.
     *   - `{ kind: "inspect", serviceId, interfaceId }` returns one complete
     *     generated source document. Set `format: "schema"` for its exact raw
     *     wire schema instead.
     *   - Reflection plumbing (`linkrpc.*`) is hidden unless `includeInternal`
     *     is true or an exact internal `interfaceId` is requested.
     *   - `requestPermission: true` requests one broad reflection grant and
     *     walks gated directories. Without it, inaccessible branches are
     *     reported explicitly instead of being silently omitted.
     *   - Browse and grep use cursor pagination. Pass a returned `nextCursor`
     *     back with the same query to continue.
     */
    explore(args: ExploreArgs): Promise<ExploreResult>;

    /**
     * List the capabilities this connection currently holds — what
     * `(serviceId, interfaceId, members)` you may already invoke, each grant's
     * expiry, and whether it is one-shot. Call this BEFORE invoking a gated
     * member to check you have access, and to decide what to pass to
     * `requestAccess`. Reflection (`explore`) works without any grant.
     */
    grants(): Promise<GrantsSummary>;

    /**
     * Request one or more capabilities from the hub. Calls are NOT
     * auto-granted: if `con.call(...)` fails with a permission error, ask for
     * access here first, then retry the call.
     *
     *   - Pass MANY `permissions` at once to batch related access into a
     *     SINGLE user prompt (e.g. several members on one service, or read +
     *     write together) instead of nagging once per call.
     *   - Choose `duration`: `"once"` (single use, 5 min), `"shortLived"`
     *     (5 min), `"longLived"` (24 h), or `"persistent"` (never expires,
     *     remembered across runs).
     *   - Granted durable caps are cached on the connection, so later
     *     `con.call`s present them automatically — no need to re-request.
     *
     * `target.serviceId` / `interfaceId` / `members` are matchers:
     * `{ exact: "x" }` or `{ prefix: "x" }` (`{ prefix: "" }` = any).
     * Set `canInvoke: true` to actually call the members.
     *
     *     con.requestAccess({
     *         permissions: [{
     *             target: {
     *                 serviceId: { exact: "github" },
     *                 interfaceId: { exact: "github.issues" },
     *                 members: [{ exact: "list" }, { exact: "get" }],
     *             },
     *             canInvoke: true,
     *         }],
     *         duration: "longLived",
     *         purpose: "read the open repo's issues",
     *     })
     */
    requestAccess(args: RequestAccessArgs): Promise<RequestAccessResult>;

    /**
     * Return this very text (the TypeScript declarations for the full script context).
     * Synchronous, no host round-trip — just an embedded string. Useful
     * when you want to re-read the API contract before composing a more
     * complicated call.
     */
    getDocs(): string;
}

// ---- access (capabilities) ----------------------------------------------

/** Per-call options for {@link SvcConnection.call} / {@link SvcConnection.callRaw}. */
interface CallOptions {
    /**
     * When `true` and the call is rejected because no capability is held
     * (`permissionRequired`), automatically request access for exactly this
     * `(serviceId, interfaceId, member)` — a single `hubAccess` round-trip —
     * and retry the call once. The granted capability is durable
     * (`longLived`), so later calls to the same member present it
     * automatically. On a gated hub this may prompt the user.
     *
     * Defaults to `false`: a missing capability surfaces as an error directing
     * you to `con.requestAccess(...)`.
     */
    readonly requestPermission?: boolean;
    /**
     * Called for each server-to-client stream message associated with this
     * request. Messages are delivered as they arrive, including while a script
     * is parked as a background task. Throwing from the callback fails the
     * sandbox and cancels its outstanding requests. When omitted, messages are
     * logged automatically.
     */
    readonly onStreamMessage?: (message: unknown) => void;
}

/**
 * Sandbox-owned timers. Pending timers continue to run while a script is
 * parked and are cancelled automatically when it completes, fails, is
 * cancelled, or reaches its maximum lifetime.
 */
declare function setTimeout(
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
): number;
declare function clearTimeout(timerId: number | undefined): void;
declare function setInterval(
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
): number;
declare function clearInterval(timerId: number | undefined): void;

/** A `serviceId` / `interfaceId` / member matcher. `{ prefix: "" }` matches anything. */
type AccessPattern = { readonly exact: string } | { readonly prefix: string };

interface AccessPermission {
    readonly target: {
        readonly serviceId: AccessPattern;
        readonly interfaceId: AccessPattern;
        readonly interfaceHash?: string;
        /** `[{ prefix: "" }]` covers every member. */
        readonly members: ReadonlyArray<AccessPattern>;
    };
    /** Set true to actually invoke the members (default false). */
    readonly canInvoke?: boolean;
    /** Set true to allow re-delegating this authority (default false). */
    readonly canDelegate?: boolean;
    readonly params?: Record<string, unknown>;
}

interface RequestAccessArgs {
    /** One or more authorities to request together in a single prompt. */
    readonly permissions: ReadonlyArray<AccessPermission>;
    readonly duration?: "once" | "shortLived" | "longLived" | "persistent";
    /** Short human-readable reason shown to the user. */
    readonly purpose?: string;
}

type RequestAccessResult =
    | { readonly status: "granted"; readonly capabilities: ReadonlyArray<unknown>; readonly addedDurable: number }
    | { readonly status: "denied"; readonly reason?: string }
    | { readonly status: string; readonly reason?: string };

interface GrantPermissionSummary {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly members: ReadonlyArray<string>;
    readonly canInvoke: boolean;
    readonly canDelegate: boolean;
}

interface GrantSummary {
    readonly issuer: string;
    readonly audience: string;
    readonly expiresAtMs?: number;
    /** True when pinned to a single call (`callBind`); not reusable. */
    readonly oneShot: boolean;
    readonly permissions: ReadonlyArray<GrantPermissionSummary>;
}

interface GrantsSummary {
    readonly count: number;
    readonly grants: ReadonlyArray<GrantSummary>;
}

interface ExploreCommonArgs {
    /** Exact directory-level filters, applied before browsing or searching. */
    readonly serviceId?: string;
    readonly interfaceId?: string;
    /** Include reflection plumbing such as `linkrpc.directory` and `linkrpc.schemas`. */
    readonly includeInternal?: boolean;
    /** Request one broad reflection grant when a gated directory is encountered. */
    readonly requestPermission?: boolean;
}

interface ExploreBrowseArgs extends ExploreCommonArgs {
    readonly kind: "browse";
    /** Number of interfaces to return. Defaults to 20; maximum 100. */
    readonly limit?: number;
    /** Continuation cursor returned by a previous browse call. */
    readonly cursor?: string;
}

interface ExploreGrepArgs extends ExploreCommonArgs {
    readonly kind: "grep";
    /** Pattern searched against generated `defineInterface` source, one line at a time. */
    readonly pattern: string;
    /** Defaults to `regex`. Both modes are case-insensitive. */
    readonly syntax?: "regex" | "literal";
    /** Number of matching virtual documents to return. Defaults to 20; maximum 100. */
    readonly limit?: number;
    /** Continuation cursor returned by a previous grep call. */
    readonly cursor?: string;
    /** Source lines included before and after each match. Defaults to 1; maximum 5. */
    readonly contextLines?: number;
}

interface ExploreInspectArgs extends ExploreCommonArgs {
    readonly kind: "inspect";
    readonly serviceId: string;
    readonly interfaceId: string;
    /** Generated source by default; use `schema` for the raw wire schema. */
    readonly format?: "source" | "schema";
}

type ExploreArgs = ExploreBrowseArgs | ExploreGrepArgs | ExploreInspectArgs;

type ExploreResult = ExploreBrowseResult | ExploreGrepResult | ExploreInspectResult;

interface ExploreListing {
    readonly serviceId: string;
    readonly serviceDescription?: string;
    readonly interfaceId: string;
    readonly interfaceHash: string;
    readonly documentId: string;
}

interface ExploreBrowseResult {
    readonly kind: "browse";
    readonly total: number;
    readonly entries: ReadonlyArray<ExploreListing>;
    readonly nextCursor?: string;
    readonly inaccessible?: ReadonlyArray<ExploreInaccessible>;
}

interface ExploreGrepMatch {
    /** Matching source plus the requested surrounding context, joined with newlines. */
    readonly searchResult: string;
    /** Inclusive, 1-based line range of `searchResult` in the virtual document. */
    readonly lineRange: readonly [start: number, end: number];
    /** LinkRPC member containing every matched line in this chunk, when unambiguous. */
    readonly member?: string;
}

interface ExploreGrepEntry extends ExploreListing {
    readonly matches: ReadonlyArray<ExploreGrepMatch>;
    readonly matchesTruncated?: boolean;
}

interface ExploreDocumentError {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly error: string;
}

interface ExploreGrepResult {
    readonly kind: "grep";
    readonly pattern: string;
    readonly syntax: "regex" | "literal";
    readonly total: number;
    readonly entries: ReadonlyArray<ExploreGrepEntry>;
    readonly nextCursor?: string;
    readonly documentErrors?: ReadonlyArray<ExploreDocumentError>;
    readonly inaccessible?: ReadonlyArray<ExploreInaccessible>;
}

interface ExploreInspectResult extends ExploreListing {
    readonly kind: "inspect";
    readonly format: "source" | "schema";
    readonly source?: string;
    readonly schema?: unknown;
    readonly inaccessible?: ReadonlyArray<ExploreInaccessible>;
}

interface ExploreInaccessible {
    /** The directory target (serviceId) that could not be enumerated. */
    readonly serviceId: string;
    /** The error message from the denied directory lookup. */
    readonly reason: string;
    /** Actionable next step to gain visibility into this directory. */
    readonly hint: string;
}

// ---- console -------------------------------------------------------------
// `console.log`, `console.warn`, `console.error` are captured and
// returned alongside the tool result. There is no `console.debug` /
// `console.trace` etc.
declare const console: {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};

// ---- Notes ---------------------------------------------------------------
// - Everything is JSON-serialisable. Functions, dates, etc. become `null`
//   when crossing the sandbox boundary.
// - The user code MUST evaluate to a function. Top-level statements are
//   wrapped, so write an arrow or function expression, not a bare
//   `await con.call(...)`.
// - `throw` inside user code surfaces as a failed tool call.
