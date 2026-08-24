// ---- guest runtime ------------------------------------------------------
//
// Handcrafted implementation of the `con` API declared in `connection.d.ts`.
// It runs INSIDE the QuickJS sandbox. The host (`sandbox.ts`) bundles this
// file (via `new URL("./guestMain.ts?esm", ...)`) and evaluates the result
// before any user code, then reads back `globalThis.con` / `globalThis.console`.
//
// Typing it as `SvcConnection` is the whole point: if the public contract in
// `connection.d.ts` drifts from what we actually expose here, this file stops
// compiling. The only way out to the host is the `__host*` seam declared in
// `hostBridge.d.ts` — every call marshals through JSON strings.

const __toJson = (v: unknown): string => (v === undefined ? "" : JSON.stringify(v));
const __fromJson = (s: string): unknown => (s === "" ? undefined : JSON.parse(s));
const __mkMethod = (serviceId: string, interfaceId: string, member: string): string =>
    serviceId ? `${serviceId}::${interfaceId}::${member}` : `${interfaceId}::${member}`;
const __presentationTag = "__hubrpcMcpPresentationV1";
let __nextStreamId = 0;
const __streamHandlers = new Map<string, (message: unknown) => void>();
let __nextTimerId = 0;
const __timerHandlers = new Map<number, {
    readonly callback: (...args: unknown[]) => void;
    readonly args: readonly unknown[];
    readonly repeat: boolean;
}>();
const __mcpContent = (content: McpContentBlock): McpContentBlock => ({
    [__presentationTag]: { kind: "content", content },
}) as unknown as McpContentBlock;

const __callHost = (
    method: string,
    params: unknown,
    options: CallOptions | undefined,
): Promise<unknown> => {
    const onStreamMessage = options?.onStreamMessage
        ?? ((message: unknown) => __console.log("stream", method, message));
    const streamId = String(++__nextStreamId);
    __streamHandlers.set(streamId, onStreamMessage);
    const hostOptions = options === undefined ? undefined : { ...options };
    if (hostOptions !== undefined) {
        delete hostOptions.onStreamMessage;
    }
    return __hostCall(method, __toJson(params), __toJson(hostOptions), streamId)
        .then(__fromJson)
        .finally(() => __streamHandlers.delete(streamId));
};

const __dispatchHostStream = (streamId: string, payloadJson: string): void => {
    __streamHandlers.get(streamId)?.(__fromJson(payloadJson));
};

const __setTimer = (
    callback: (...args: unknown[]) => void,
    timeout: number | undefined,
    args: readonly unknown[],
    repeat: boolean,
): number => {
    if (typeof callback !== "function") {
        throw new TypeError("Timer callback must be a function");
    }
    const timerId = ++__nextTimerId;
    const numericDelay = Number(timeout ?? 0);
    const delay = Number.isFinite(numericDelay) ? Math.max(0, numericDelay) : 0;
    __timerHandlers.set(timerId, { callback, args, repeat });
    __hostSetTimer(timerId, delay, repeat ? 1 : 0);
    return timerId;
};

const __dispatchHostTimer = (timerId: number): void => {
    const timer = __timerHandlers.get(timerId);
    if (!timer) return;
    if (!timer.repeat) __timerHandlers.delete(timerId);
    timer.callback(...timer.args);
};

const __clearTimer = (timerId: number | undefined): void => {
    if (timerId === undefined) return;
    __timerHandlers.delete(timerId);
    __hostClearTimer(timerId);
};

const con: SvcConnection = {
    abortSignal: {
        aborted: false,
        reason: undefined,
        throwIfAborted(): void {
            if (this.aborted) {
                const e = new Error("AbortError: " + (this.reason || "aborted"));
                e.name = "AbortError";
                throw e;
            }
        },
    },

    callRaw(method, params, options) {
        return __callHost(method, params, options);
    },
    notifyRaw(method, params) {
        return __hostNotify(method, __toJson(params)).then(() => undefined);
    },
    call(serviceId, interfaceId, member, params, options) {
        return this.callRaw(__mkMethod(serviceId, interfaceId, member), params, options);
    },
    notify(serviceId, interfaceId, member, params) {
        return this.notifyRaw(__mkMethod(serviceId, interfaceId, member), params);
    },
    explore(args) {
        return __hostExplore(__toJson(args ?? {}), "").then(__fromJson) as Promise<ExploreResult>;
    },
    requestAccess(args) {
        return __hostRequestAccess(__toJson(args), "").then(__fromJson) as Promise<RequestAccessResult>;
    },
    grants() {
        return __hostGrants("", "").then(__fromJson) as Promise<GrantsSummary>;
    },
    getDocs() {
        return __docs;
    },
};

const __safeStringify = (v: unknown): string => {
    if (typeof v === "string") {
        return v;
    }
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
};

const __console = {
    log: (...a: unknown[]): void => __hostLog("log", a.map(__safeStringify).join(" ")),
    warn: (...a: unknown[]): void => __hostLog("warn", a.map(__safeStringify).join(" ")),
    error: (...a: unknown[]): void => __hostLog("error", a.map(__safeStringify).join(" ")),
};

const mcp: McpPresentation = {
    raw(value) {
        return {
            [__presentationTag]: { kind: "raw", value },
        } as unknown as typeof value;
    },
    text(text, annotations) {
        return __mcpContent({ type: "text", text, ...(annotations ? { annotations } : {}) });
    },
    image(data, mimeType, annotations) {
        return __mcpContent({ type: "image", data, mimeType, ...(annotations ? { annotations } : {}) });
    },
    audio(data, mimeType, annotations) {
        return __mcpContent({ type: "audio", data, mimeType, ...(annotations ? { annotations } : {}) });
    },
    resource(resource, annotations) {
        return __mcpContent({ type: "resource", resource, ...(annotations ? { annotations } : {}) });
    },
    resourceLink(resource) {
        return __mcpContent({ type: "resource_link", ...resource });
    },
    content(block) {
        return __mcpContent(block);
    },
    result(options) {
        return {
            [__presentationTag]: {
                kind: "result",
                ...(Object.prototype.hasOwnProperty.call(options, "value")
                    ? { value: options.value }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(options, "structuredContent")
                    ? { structuredContent: options.structuredContent }
                    : {}),
                ...(options.content ? { content: options.content } : {}),
                ...(options.isError !== undefined ? { isError: options.isError } : {}),
                ...(options._meta ? { _meta: options._meta } : {}),
            },
        };
    },
};

// Publish onto the guest global so later-evaluated user code (and the host's
// soft-abort poke at `con.abortSignal`) can reach them by bare name.
const __g = globalThis as Record<string, unknown>;
__g.con = con;
__g.console = __console;
__g.mcp = mcp;
__g.setTimeout = (
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
) => __setTimer(callback, timeout, args, false);
__g.clearTimeout = __clearTimer;
__g.setInterval = (
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
) => __setTimer(callback, timeout, args, true);
__g.clearInterval = __clearTimer;
__g.__dispatchHostStream = __dispatchHostStream;
__g.__dispatchHostTimer = __dispatchHostTimer;
