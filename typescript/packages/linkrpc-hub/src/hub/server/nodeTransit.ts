/**
 * Node-transit observation — the inspection primitive for a {@link Hub}.
 *
 * A **node transit** records a single message passing *through* a routing
 * node: the edge it arrived on (`in`) and the edge it left on (`out`),
 * together with the per-edge request id on each side. Because a node is
 * exactly where a router rewrites the JSON-RPC `id` (the hub swaps
 * `originalId → hubId`), capturing the crossing at the node makes the
 * rewrite explicit — so a request and its response pair locally by their
 * `(in.requestId, out.requestId)`, and adjacent nodes chain by the shared
 * `(edgeId, requestId)` on the edge between them. No global span id needed
 * for in-process inspection.
 *
 * Emission is **off by default**: a hub with no transit observer pays no
 * cost (the emit sites short-circuit on the missing observer), mirroring the
 * `IHubLogger` contract.
 */
import type {
    JsonRpcError,
    JsonRpcMessage,
    JsonRpcRequest,
    JsonRpcSuccess,
    JsonValue,
    RequestId,
} from '@hediet/linkrpc';
import type { IMessageTransport } from '@hediet/linkrpc';
import type { TrafficTransitEvent } from '@hediet/linkrpc/inspection';
import { STREAM_METHOD } from '@hediet/linkrpc';

/** What kind of message crossed the node. Cancel/ping/pong are stream controls. */
export type TransitKind = 'request' | 'notification' | 'response' | 'stream';

/** What the node did with the message. */
export type TransitDisposition = 'forwarded' | 'consumed' | 'dropped' | 'unroutable';

/** One side of a transit: the edge, plus the request id as it appears there. */
export interface TransitEndpoint {
    readonly edgeId: string;
    /** Stable topology port id. Older/custom emitters may omit it. */
    readonly portId?: string;
    /** JSON-RPC request id on this edge. Absent for notifications. */
    readonly requestId?: RequestId;
}

/** Wire-shaped error mirrored onto a `response` transit. */
export interface TransitError {
    readonly code: number;
    readonly message: string;
    readonly data?: JsonValue;
}

/**
 * A single message passing through a node. `in` absent ⇒ the message
 * originated here; `out` absent ⇒ it was consumed or dropped here.
 */
export interface NodeTransit {
    readonly timeMs: number;
    readonly nodeId: string;
    readonly in?: TransitEndpoint;
    readonly out?: TransitEndpoint;
    readonly disposition: TransitDisposition;
    readonly kind: TransitKind;
    readonly method?: string;
    readonly params?: JsonValue;
    readonly result?: JsonValue;
    readonly error?: TransitError;
}

/** Sink for node transits. Synchronous; keep it cheap. */
export type NodeTransitObserver = (transit: NodeTransit) => void;

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Status of a coalesced flow at the moment it is reported. */
export type FlowStatus = 'completed' | 'failed' | 'pending' | 'dropped' | 'unroutable';

/** One stream frame (`$stream::send`) attached to a flow, in arrival order. */
export interface FlowStreamMessage {
    readonly timeMs: number;
    /** `toCaller` = callee→caller (progress); `toCallee` = caller→callee (input/cancel). */
    readonly dir: 'toCaller' | 'toCallee';
    /** Reserved control verb (`cancel`/`ping`/`pong`), if this is a control frame. */
    readonly control?: string;
    /** App stream payload (typed per call by the originating method's stream schema). */
    readonly payload?: JsonValue;
}

/** A coalesced logical operation, reported once (or twice: partial → final). */
export interface FlowSummary {
    readonly id: string;
    readonly kind: TransitKind;
    readonly method: string | undefined;
    readonly params: JsonValue | undefined;
    readonly status: FlowStatus;
    readonly result?: JsonValue;
    readonly error?: TransitError;
    readonly startTs: number;
    readonly endTs: number | undefined;
    readonly durationMs: number;
    /** Ordered, interleaved edge/node labels the message traversed. */
    readonly path: readonly string[];
    /** True when reported while still in flight (slow / stuck). */
    readonly partial: boolean;
    /**
     * Stream frames (`$stream::send`) seen on this flow, in arrival order. Only
     * populated when the hub is configured to emit stream transits (debug+); an
     * absent/empty array means "not captured", not "no streaming happened".
     */
    readonly stream?: readonly FlowStreamMessage[];
}

export interface TransitAggregatorOptions {
    /** Called once a flow settles, or once when it is first reported partial. */
    readonly onFlow: (summary: FlowSummary) => void;
    /** Quiet-period before a flow is flushed. Default 50ms. */
    readonly flushDelayMs?: number;
    /** Drop an unsettled flow after this long (leak guard). Default 5min. */
    readonly giveUpMs?: number;
    /**
     * How long after a request starts its stream frames stay attached to that
     * request's flow. Frames within this window fold into the request summary;
     * later frames are logged independently (live), so a long-running request's
     * stream output is visible promptly and doesn't accumulate unbounded in the
     * pending flow. Default 1000ms.
     */
    readonly streamRetainMs?: number;
    /** Map an edgeId to a friendly label for {@link FlowSummary.path}. */
    readonly labelOf?: (edgeId: string) => string | undefined;
    /** Injected clock (tests). Default {@link Date.now}. */
    readonly now?: () => number;
    /** Injected timer (tests). Default {@link setTimeout}. */
    readonly setTimer?: (cb: () => void, ms: number) => unknown;
    /** Injected timer clear (tests). Default {@link clearTimeout}. */
    readonly clearTimer?: (handle: unknown) => void;
    /** Hash params for the notification-correlation heuristic. Default JSON. */
    readonly hashParams?: (params: JsonValue | undefined) => string;
}

interface Flow {
    readonly id: string;
    readonly endpoints: Set<string>;
    readonly transits: NodeTransit[];
    settled: boolean;
    reportedPartial: boolean;
    timer: unknown | undefined;
    timerIsGiveUp: boolean;
    firstTs: number;
}

/**
 * Coalesces {@link NodeTransit}s into per-operation {@link FlowSummary}s and
 * reports each after a short quiet period. A fast request is reported **once**
 * (path + params + response); a slow/stuck one is reported **partial** while
 * in flight and again on completion.
 *
 * Correlation:
 * - request ↔ response and adjacent-node hops join by shared
 *   `(edgeId, requestId)` endpoints;
 * - **notifications** (no request id) join heuristically by
 *   `(edgeId, method, paramsHash)` — same edge + method + params ⇒ same message.
 */
export class TransitAggregator {
    private readonly _flushDelayMs: number;
    private readonly _giveUpMs: number;
    private readonly _streamRetainMs: number;
    private readonly _now: () => number;
    private readonly _setTimer: (cb: () => void, ms: number) => unknown;
    private readonly _clearTimer: (handle: unknown) => void;
    private readonly _hashParams: (params: JsonValue | undefined) => string;
    private readonly _labelOf: ((edgeId: string) => string | undefined) | undefined;

    private readonly _flows = new Set<Flow>();
    private readonly _endpointToFlow = new Map<string, Flow>();
    private _nextId = 1;

    constructor(private readonly _options: TransitAggregatorOptions) {
        this._flushDelayMs = _options.flushDelayMs ?? 50;
        this._giveUpMs = _options.giveUpMs ?? 5 * 60_000;
        this._streamRetainMs = _options.streamRetainMs ?? 1000;
        this._now = _options.now ?? (() => Date.now());
        this._setTimer = _options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
        this._clearTimer = _options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
        this._hashParams = _options.hashParams ?? ((p) => JSON.stringify(p ?? null));
        this._labelOf = _options.labelOf;
    }

    public add(transit: NodeTransit): void {
        // Stream frames attach to their owning request's flow only briefly: past
        // `streamRetainMs` after the request started (or with no owning flow at
        // all) they're logged independently and never buffered — so long-running
        // requests stream live and don't grow the pending flow unbounded.
        if (transit.kind === 'stream') {
            const parent = this._findFlow(this._endpointKeys(transit));
            const fresh = parent !== undefined
                && transit.timeMs - parent.firstTs <= this._streamRetainMs;
            if (!fresh) {
                this._emitStandaloneStream(transit, parent);
                return;
            }
        }

        const keys = this._endpointKeys(transit);

        // Find every existing flow this transit touches; merge them.
        let flow: Flow | undefined;
        for (const k of keys) {
            const f = this._endpointToFlow.get(k);
            if (!f) continue;
            if (!flow) flow = f;
            else if (f !== flow) flow = this._merge(flow, f);
        }
        if (!flow) {
            flow = {
                id: `flow${this._nextId++}`,
                endpoints: new Set(),
                transits: [],
                settled: false,
                reportedPartial: false,
                timer: undefined,
                timerIsGiveUp: false,
                firstTs: transit.timeMs,
            };
            this._flows.add(flow);
        }

        flow.transits.push(transit);
        if (transit.timeMs < flow.firstTs) flow.firstTs = transit.timeMs;
        for (const k of keys) {
            flow.endpoints.add(k);
            this._endpointToFlow.set(k, flow);
        }
        if (transit.kind === 'response') flow.settled = true;

        this._armFlush(flow);
    }

    /** Drop all pending flows and timers. Does not emit. */
    public dispose(): void {
        for (const flow of this._flows) {
            if (flow.timer !== undefined) this._clearTimer(flow.timer);
        }
        this._flows.clear();
        this._endpointToFlow.clear();
    }

    /** Emit pending flows as partial summaries before a diagnostic capture ends. */
    public flush(): void {
        for (const flow of [...this._flows]) {
            if (flow.timer !== undefined) this._clearTimer(flow.timer);
            flow.timer = undefined;
            this._options.onFlow(this._summarize(flow));
            this._delete(flow);
        }
    }

    /** First flow registered under any of `keys`, if any (no merge/create). */
    private _findFlow(keys: string[]): Flow | undefined {
        for (const k of keys) {
            const f = this._endpointToFlow.get(k);
            if (f) return f;
        }
        return undefined;
    }

    /**
     * Report a single stream frame as its own one-line flow, correlated to its
     * owning request by method + path (the request itself is reported separately
     * when it settles). Used for frames that arrive after {@link _streamRetainMs}
     * so they surface live instead of waiting on a slow request to finish.
     */
    private _emitStandaloneStream(transit: NodeTransit, parent: Flow | undefined): void {
        const msg = _streamMessagesOf([transit])[0];
        if (!msg) return;
        const method = parent?.transits.find(
            (t) => t.kind === 'request' || t.kind === 'notification',
        )?.method;
        const startTs = parent?.firstTs ?? transit.timeMs;
        this._options.onFlow({
            id: `flow${this._nextId++}`,
            kind: 'stream',
            method,
            params: undefined,
            status: 'completed',
            startTs,
            endTs: transit.timeMs,
            durationMs: transit.timeMs - startTs,
            path: this._buildStreamPath(transit),
            partial: false,
            stream: [msg],
        });
    }

    /** Path for a lone stream transit (in → node → out), with labels applied. */
    private _buildStreamPath(t: NodeTransit): string[] {
        const path: string[] = [];
        const push = (s: string): void => {
            if (path[path.length - 1] !== s) path.push(s);
        };
        if (t.in) push(this._label(t.in.edgeId));
        push(t.nodeId);
        if (t.out) push(this._label(t.out.edgeId));
        return path;
    }

    private _endpointKeys(t: NodeTransit): string[] {
        const keys: string[] = [];
        for (const ep of [t.in, t.out]) {
            if (!ep) continue;
            if (t.kind === 'notification') {
                // No request id — correlate by edge + method + params.
                keys.push(`${ep.edgeId}#N#${t.method ?? ''}#${this._hashParams(t.params)}`);
            } else if (ep.requestId !== undefined) {
                keys.push(`${ep.edgeId}#${String(ep.requestId)}`);
            }
        }
        return keys;
    }

    private _merge(into: Flow, other: Flow): Flow {
        if (into === other) return into;
        for (const t of other.transits) into.transits.push(t);
        for (const k of other.endpoints) {
            into.endpoints.add(k);
            this._endpointToFlow.set(k, into);
        }
        into.settled ||= other.settled;
        into.reportedPartial ||= other.reportedPartial;
        if (other.firstTs < into.firstTs) into.firstTs = other.firstTs;
        if (other.timer !== undefined) this._clearTimer(other.timer);
        this._flows.delete(other);
        return into;
    }

    private _armFlush(flow: Flow): void {
        if (flow.timer !== undefined) this._clearTimer(flow.timer);
        flow.timerIsGiveUp = false;
        flow.timer = this._setTimer(() => this._flush(flow), this._flushDelayMs);
    }

    private _flush(flow: Flow): void {
        flow.timer = undefined;
        if (!this._flows.has(flow)) return;

        const summary = this._summarize(flow);
        if (summary.status === 'pending') {
            if (!flow.reportedPartial) {
                flow.reportedPartial = true;
                this._options.onFlow(summary);
            }
            // Keep the flow alive awaiting completion, but guard against leaks.
            flow.timerIsGiveUp = true;
            flow.timer = this._setTimer(() => this._giveUp(flow), this._giveUpMs);
            return;
        }
        this._options.onFlow(summary);
        this._delete(flow);
    }

    private _giveUp(flow: Flow): void {
        flow.timer = undefined;
        this._delete(flow);
    }

    private _delete(flow: Flow): void {
        if (flow.timer !== undefined) this._clearTimer(flow.timer);
        flow.timer = undefined;
        this._flows.delete(flow);
        for (const k of flow.endpoints) {
            if (this._endpointToFlow.get(k) === flow) this._endpointToFlow.delete(k);
        }
    }

    private _summarize(flow: Flow): FlowSummary {
        const transits = [...flow.transits].sort((a, b) => a.timeMs - b.timeMs);
        const head =
            transits.find((t) => t.kind === 'request') ??
            transits.find((t) => t.kind === 'notification') ??
            transits[0];
        const response = [...transits].reverse().find((t) => t.kind === 'response');

        let status: FlowStatus;
        if (response) {
            status = response.error ? 'failed' : 'completed';
        } else if (head?.kind === 'notification') {
            status = head.disposition === 'dropped' ? 'dropped' : 'completed';
        } else if (transits.some((t) => t.disposition === 'unroutable')) {
            status = 'unroutable';
        } else if (transits.some((t) => t.disposition === 'dropped')) {
            status = 'dropped';
        } else {
            status = 'pending';
        }

        const endTs = response?.timeMs
            ?? (status === 'pending' ? undefined : transits[transits.length - 1]?.timeMs);
        const startTs = flow.firstTs;
        const durationMs = (endTs ?? this._now()) - startTs;

        const stream = _streamMessagesOf(transits);

        return {
            id: flow.id,
            kind: head?.kind === 'notification' ? 'notification' : 'request',
            method: head?.method,
            params: head?.params,
            status,
            result: response?.result,
            error: response?.error,
            startTs,
            endTs,
            durationMs,
            path: this._buildPath(transits),
            partial: status === 'pending',
            ...(stream.length > 0 ? { stream } : {}),
        };
    }

    private _buildPath(transits: NodeTransit[]): string[] {
        const forward = transits.filter((t) => t.kind === 'request' || t.kind === 'notification');
        const path: string[] = [];
        const push = (s: string): void => {
            if (path[path.length - 1] !== s) path.push(s);
        };
        for (const t of forward) {
            if (t.in) push(this._label(t.in.edgeId));
            push(t.nodeId);
            if (t.out) push(this._label(t.out.edgeId));
        }
        return path;
    }

    private _label(edgeId: string): string {
        return this._labelOf?.(edgeId) ?? edgeId;
    }
}

/**
 * Presentation adapter that coalesces the public traffic stream into legacy
 * {@link FlowSummary} values. Routing and endpoint observation stay entirely
 * behind the inspection interfaces; consumers only provide formatting/UI.
 */
export class TrafficFlowAggregator {
    private readonly _portLabels = new Map<string, string>();
    private readonly _aggregator: TransitAggregator;

    constructor(options: TransitAggregatorOptions) {
        this._aggregator = new TransitAggregator({
            ...options,
            labelOf: (portId) => this._portLabels.get(portId) ?? options.labelOf?.(portId),
        });
    }

    public add(transit: TrafficTransitEvent): void {
        this._aggregator.add({
            timeMs: transit.timeMs,
            nodeId: transit.nodeId,
            ...(transit.in !== undefined ? { in: toTransitEndpoint(transit.in) } : {}),
            ...(transit.out !== undefined ? { out: toTransitEndpoint(transit.out) } : {}),
            disposition: transit.disposition,
            kind: transit.kind,
            method: transit.method,
            params: _isJsonValue(transit.params) ? transit.params : undefined,
            result: _isJsonValue(transit.result) ? transit.result : undefined,
            error: transit.error === undefined
                ? undefined
                : {
                    code: transit.error.code,
                    message: transit.error.message,
                    ...(_isJsonValue(transit.error.data) ? { data: transit.error.data } : {}),
                },
        });
    }

    public setPortLabel(portId: string, label: string): void {
        this._portLabels.set(portId, label);
    }

    public flush(): void {
        this._aggregator.flush();
    }

    public dispose(): void {
        this._aggregator.dispose();
        this._portLabels.clear();
    }
}

function toTransitEndpoint(
    endpoint: NonNullable<TrafficTransitEvent['in']>,
): TransitEndpoint {
    return {
        edgeId: endpoint.portId,
        portId: endpoint.portId,
        ...(endpoint.requestId !== undefined ? { requestId: endpoint.requestId } : {}),
    };
}

function _isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
    ) {
        return true;
    }
    if (Array.isArray(value)) return value.every(_isJsonValue);
    if (typeof value !== 'object' || value === undefined) return false;
    return Object.values(value).every(_isJsonValue);
}

/**
 * Render a {@link FlowSummary} as a single, human-readable log line. Payloads
 * are JSON-stringified and truncated. Intended for a VS Code output channel.
 */
export function formatFlowSummary(s: FlowSummary, maxPayload = 200): string {
    // A standalone stream frame (one logged independently of its slow request)
    // renders compactly on one line, tagged with the offset since the request
    // started so it can be lined up against the request's own summary.
    if (s.kind === 'stream') {
        const m = s.stream?.[0];
        const route = s.path.join(' → ');
        const arrow = m?.dir === 'toCaller' ? '←' : '→';
        const body = m?.control !== undefined ? `ctrl:${m.control}` : _trunc(m?.payload, maxPayload);
        const call = s.method ?? STREAM_METHOD;
        return `┄ ${route}  ${call}  ${arrow} stream ${body} (+${s.durationMs}ms)`;
    }
    const icon =
        s.status === 'completed' ? '✓' :
            s.status === 'failed' ? '✗' :
                s.status === 'pending' ? '⧖' :
                    '·';
    const route = s.path.join(' → ');
    const call = `${s.method ?? '(unknown)'}(${_trunc(s.params, maxPayload)})`;
    const tail =
        s.status === 'pending' ? `…in flight (${s.durationMs}ms)` :
            s.status === 'completed' ? `→ ${_trunc(s.result, maxPayload)} (${s.durationMs}ms)` :
                s.status === 'failed' ? `→ error ${_trunc(s.error, maxPayload)} (${s.durationMs}ms)` :
                    `${s.status} (${s.durationMs}ms)`;
    const head = `${icon} ${route}  ${call}  ${tail}`;
    if (!s.stream || s.stream.length === 0) return head;
    // Attach each stream frame on its own indented line, in arrival order.
    const frames = s.stream.map((m) => {
        const arrow = m.dir === 'toCaller' ? '←' : '→';
        const body = m.control !== undefined
            ? `ctrl:${m.control}`
            : _trunc(m.payload, maxPayload);
        return `    ${arrow} stream ${body}`;
    });
    return [head, ...frames].join('\n');
}

function _trunc(value: unknown, max: number): string {
    if (value === undefined) return '';
    let str: string;
    try {
        str = JSON.stringify(value) ?? String(value);
    } catch {
        str = String(value);
    }
    return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** Extract the `$stream::send` frames from a flow's transits, in arrival order. */
function _streamMessagesOf(transits: readonly NodeTransit[]): FlowStreamMessage[] {
    const out: FlowStreamMessage[] = [];
    for (const t of transits) {
        if (t.kind !== 'stream') continue;
        const p = (t.params ?? undefined) as
            | { dir?: unknown; control?: { type?: unknown }; payload?: JsonValue }
            | undefined;
        const dir = p?.dir === 'toCallee' ? 'toCallee' : 'toCaller';
        const control = typeof p?.control?.type === 'string' ? p.control.type : undefined;
        out.push({
            timeMs: t.timeMs,
            dir,
            ...(control !== undefined ? { control } : {}),
            ...(p?.payload !== undefined ? { payload: p.payload } : {}),
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Flow logger
// ---------------------------------------------------------------------------

export interface FlowLoggerOptions {
    /** Sink for the formatted, one-line-per-flow output. */
    readonly log: (line: string) => void;
    /**
     * Max JSON length per payload before truncation. Default 200; pass
     * {@link Number.POSITIVE_INFINITY} for full, untruncated payloads.
     */
    readonly maxPayload?: number;
    /** Quiet-period before a flow is flushed. Default 50ms. */
    readonly flushDelayMs?: number;
    /** Drop an unsettled flow after this long (leak guard). Default 5min. */
    readonly giveUpMs?: number;
    /** Map an edgeId to a friendly label for the rendered path. */
    readonly labelOf?: (edgeId: string) => string | undefined;
}

/** A ready-to-attach flow logger: an {@link NodeTransitObserver} + teardown. */
export interface FlowLogger {
    /** Wire this as a hub / overlay `onTransit` observer. */
    readonly onTransit: NodeTransitObserver;
    /** Flush nothing; just clear pending timers. */
    dispose(): void;
}

/**
 * Wire a {@link TransitAggregator} to a line sink: each settled (or partial)
 * flow is rendered with {@link formatFlowSummary} and handed to `log`. This is
 * the shared engine behind both the VS Code "linkrpc Flows" output channel and
 * the CLI's `--log-messages` flag.
 */
export function createFlowLogger(opts: FlowLoggerOptions): FlowLogger {
    const agg = new TransitAggregator({
        onFlow: (s) => opts.log(formatFlowSummary(s, opts.maxPayload)),
        ...(opts.flushDelayMs !== undefined ? { flushDelayMs: opts.flushDelayMs } : {}),
        ...(opts.giveUpMs !== undefined ? { giveUpMs: opts.giveUpMs } : {}),
        ...(opts.labelOf !== undefined ? { labelOf: opts.labelOf } : {}),
    });
    return {
        onTransit: (t) => agg.add(t),
        dispose: () => agg.dispose(),
    };
}

// ---------------------------------------------------------------------------
// Wire tap
// ---------------------------------------------------------------------------

export interface WireTapOptions {
    /** Sink for the formatted, one-line-per-flow output. */
    readonly log: (line: string) => void;
    /** Max JSON length per payload before truncation. Default 200. */
    readonly maxPayload?: number;
    /** Edge label for the near end (the tapping side). Default `"local"`. */
    readonly localLabel?: string;
    /** Edge label for the far end (the peer). Default `"peer"`. */
    readonly remoteLabel?: string;
    /** Synthetic node id for the tap point. Default = {@link localLabel}. */
    readonly nodeId?: string;
}

/**
 * Wrap an {@link IMessageTransport} so every JSON-RPC message crossing it — in
 * both directions — is rendered to a line sink, exactly like {@link Hub} traffic.
 *
 * No hub is involved: the tap point is modelled as a single node with two edges
 * (`local`, `peer`). Each outbound message is a transit `local → peer`, each
 * inbound one `peer → local`; requests and their responses still pair by their
 * shared `(peer-edge, requestId)`, so the rendered flows match the hub view.
 * Use this to inspect a *direct* connection that never touches a local hub.
 */
export function tapTransport(
    inner: IMessageTransport,
    opts: WireTapOptions,
): IMessageTransport {
    const logger = createFlowLogger({
        log: opts.log,
        ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}),
    });
    const local = opts.localLabel ?? 'local';
    const remote = opts.remoteLabel ?? 'peer';
    const nodeId = opts.nodeId ?? local;
    const emit = (m: JsonRpcMessage, outbound: boolean): void => {
        try {
            logger.onTransit(_wireTransit(m, outbound, nodeId, local, remote));
        } catch { /* never let logging break the transport */ }
    };
    return {
        send: (m) => {
            emit(m, true);
            return inner.send(m);
        },
        setListener: (listener) =>
            inner.setListener(
                listener === undefined
                    ? undefined
                    : (m) => {
                        emit(m, false);
                        listener(m);
                    },
            ),
        dispose: () => {
            logger.dispose();
            inner.dispose();
        },
    };
}

/** Classify one wire message into a {@link NodeTransit} at the tap node. */
function _wireTransit(
    m: JsonRpcMessage,
    outbound: boolean,
    nodeId: string,
    local: string,
    remote: string,
): NodeTransit {
    const fromEdge = outbound ? local : remote;
    const toEdge = outbound ? remote : local;

    let kind: TransitKind;
    let method: string | undefined;
    let requestId: RequestId | undefined;
    let params: JsonValue | undefined;
    let result: JsonValue | undefined;
    let error: TransitError | undefined;

    const req = m as JsonRpcRequest;
    if (typeof req.method === 'string') {
        method = req.method;
        params = req.params;
        if (req.id !== undefined && req.id !== null) {
            kind = 'request';
            requestId = req.id;
        } else {
            kind = 'notification';
        }
    } else {
        kind = 'response';
        const resp = m as JsonRpcSuccess & JsonRpcError;
        if (resp.id !== undefined && resp.id !== null) requestId = resp.id;
        if ((m as JsonRpcError).error !== undefined) {
            const e = (m as JsonRpcError).error;
            error = {
                code: e.code,
                message: e.message,
                ...(e.data !== undefined ? { data: e.data } : {}),
            };
        } else {
            result = (m as JsonRpcSuccess).result;
        }
    }

    const endpoint = (edgeId: string): TransitEndpoint =>
        requestId !== undefined ? { edgeId, requestId } : { edgeId };

    return {
        timeMs: Date.now(),
        nodeId,
        disposition: 'forwarded',
        kind,
        in: endpoint(fromEdge),
        out: endpoint(toEdge),
        ...(method !== undefined ? { method } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
    };
}
