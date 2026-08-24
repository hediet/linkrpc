// ---- runHubRpcScript sandbox API ----------------------------------------
//
// The MCP tool `runHubRpcScript` takes `code` (a JS function expression) and
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
     * The value returned by the previous `runHubRpcScript` call on the same hub
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
     * call observable through `awaitHubRpcTask` without extra callback code.
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
     * Discover what's on the bus.
     *
     *   - With no args: returns up to 10 `{ serviceId, interfaceId }`
     *     entries from across the whole bus.
     *   - Filter by `interfaceId` and/or `serviceId` to narrow.
     *   - `grep`: case-insensitive substring search over each listing's
     *     metadata (serviceId, interfaceId, service description). Cheap — no
     *     schema fetch. `grepAllSchemas`: same, but ALSO searches every
     *     interface's JSON schema (method/param names, descriptions); this
     *     fetches all candidate schemas, so it's slower — prefer `grep`.
     *   - Reflection plumbing (`hubrpc.*`) is hidden by default; pass
     *     `showHubrpcInternalInterfaces: true` to include it (or filter for an
     *     exact `hubrpc.*` interfaceId, which always shows it).
     *   - Set `includeSchema: true` to also fetch the JSON schema for each
     *     returned interface (one extra RPC per entry).
     *   - Set `includeTypeScript: true` to emit a self-contained TypeScript
     *     module re-creating the interface via `defineInterface` (zod +
     *     hubrpc). Implies fetching the schema internally; omit
     *     `includeSchema` unless you also need the raw JSON, since returning
     *     both can be large.
     *
     *     To retrieve one module without returning the surrounding result:
     *
     *         const result = await con.explore({
     *             serviceId: "vscode",
     *             interfaceId: "vscode.execution",
     *             includeTypeScript: true,
     *             maxResults: 1,
     *         });
     *         const entry = result.entries[0];
     *         if (!entry) throw new Error("Interface not found");
     *         if (entry.typeScriptError) throw new Error(entry.typeScriptError);
     *         return entry.typeScript;
     *   - `maxResults` is the page size (default 10; pass `0` for "no limit").
     *     Page through larger hubs with `offset`: when more matches remain, the
     *     result carries `nextOffset` — pass it as the next call's `offset`.
     *   - Set `requestPermission: true` to enumerate the ENTIRE hub, including
     *     gated directories (e.g. the `hub` directory). This requests reflection
     *     access (`hubrpc.*`) across all services in a SINGLE consent prompt and
     *     then walks every directory — prefer this over requesting access to one
     *     gated directory at a time. Default `false`, in which case gated
     *     directories are reported under `ExploreResult.inaccessible` instead.
     *
     * `totalMatched` is the number of matches across all pages; `entries` holds
     * this page (starting at `offset`), and `nextOffset` is present when more
     * remain.
     */
    explore(args?: ExploreArgs): Promise<ExploreResult>;

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

interface ExploreArgs {
    readonly interfaceId?: string;
    readonly serviceId?: string;
    readonly includeSchema?: boolean;
    /** Emit a TypeScript module re-creating the interface. Implies fetching the schema. */
    readonly includeTypeScript?: boolean;
    /** Page size. Defaults to 10. `0` means "no limit" (still bounded by bus walk depth). */
    readonly maxResults?: number;
    /**
     * 0-based index to start this page at. Combine with `maxResults` to page
     * through a large hub: pass the previous result's `nextOffset` here.
     * Defaults to 0.
     */
    readonly offset?: number;
    /**
     * Include the reflection plumbing interfaces (`hubrpc.*` — e.g.
     * `hubrpc.directory`, `hubrpc.schemas`) in the results. Hidden by default
     * because they exist on every service. Filtering by an exact `hubrpc.*`
     * `interfaceId` shows it regardless.
     */
    readonly showHubrpcInternalInterfaces?: boolean;
    /**
     * Case-insensitive substring filter over each listing's metadata
     * (serviceId, interfaceId, service description). Cheap — no schema fetch.
     */
    readonly grep?: string;
    /**
     * Like `grep`, but also searches each interface's full JSON schema
     * (method/param names, descriptions). Fetches every candidate schema, so
     * it's slower than `grep`.
     */
    readonly grepAllSchemas?: string;
    /**
     * When `true`, gated directories encountered during the walk (e.g. the
     * `hub` directory) are unlocked in-line: `explore` requests a capability
     * for the reflection interfaces (`hubrpc.*`) across all services — a single
     * consent — then enumerates them. Default `false`, in which case gated
     * directories are reported under `ExploreResult.inaccessible` instead.
     */
    readonly requestPermission?: boolean;
}

interface ExploreResult {
    /** Number of entries that matched the filters, across all pages. */
    readonly totalMatched: number;
    /** This page of matches (up to `maxResults`, starting at `offset`). */
    readonly entries: ReadonlyArray<ExploreEntry>;
    /** 0-based index this page starts at (echoes the requested `offset`). */
    readonly offset: number;
    /**
     * Index to pass as `offset` to fetch the next page. Present only when more
     * matches remain beyond this page.
     */
    readonly nextOffset?: number;
    /**
     * Directories that exist but could not be enumerated without an additional
     * capability (e.g. a gated `hub` directory). Their services are absent from
     * `entries`. Present only when at least one directory was gated — read the
     * `hint` for the exact `con.requestAccess(...)` to unlock it, then explore
     * again.
     */
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

interface ExploreEntry {
    readonly serviceId: string;
    readonly interfaceId: string;
    /** Present when `includeSchema: true` and the lookup succeeded. */
    readonly schema?: unknown;
    /** Present when `includeSchema: true` and the lookup failed. */
    readonly schemaError?: string;
    /** Present when `includeTypeScript: true` and codegen succeeded. */
    readonly typeScript?: string;
    /** Present when `includeTypeScript: true` and codegen (or the schema fetch) failed. */
    readonly typeScriptError?: string;
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
