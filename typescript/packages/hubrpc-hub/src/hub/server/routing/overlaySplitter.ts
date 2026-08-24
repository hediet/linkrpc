import { isNotification, isRequest, isResponse } from '@vscode/hubrpc';
import type {
    MessageWithCtx, IMessageTransport,
    JsonRpcMessage,
    RequestId
} from '@vscode/hubrpc';
import type { JsonValue } from '@vscode/hubrpc';
import { parseMethodName } from '@vscode/hubrpc';
import { STREAM_METHOD, StreamDir } from '@vscode/hubrpc';
import type { NodeTransit, NodeTransitObserver, TransitError, TransitKind } from '../nodeTransit';
import { isInspectionLifecycle } from '../inspectionLifecycle';

/** Which upstream port an inbound-to-participant request came from. */
type Origin = 'H' | 'C';

/** Separator for return-path tags. NUL never appears in JSON-RPC ids. */
const SEP = '\u0000';

/**
 * Inspection wiring for an {@link OverlaySplitter}. When supplied, the splitter
 * emits a {@link NodeTransit} for every message it routes. The three port edge
 * ids name the splitter's own edges; **`edges.h` must equal the parent hub
 * link's `edgeId`** so a {@link TransitAggregator} chains the splitter's and
 * hub's transits across the shared boundary (the splitter forwards request ids
 * verbatim there, so the `(edgeId, requestId)` endpoints line up).
 */
export interface OverlaySplitterInspection {
    readonly nodeId: string;
    readonly onTransit: NodeTransitObserver;
    readonly edges: { readonly p: string; readonly c: string; readonly h: string; };
}

/**
 * A fixed three-port message splitter — the per-participant primitive that
 * replaces a nested {@link import('./routingHub').Hub} inside a
 * {@link import('./rootOverlay').RootOverlay}.
 *
 * Ports:
 * - **P** — the participant (downstream connection),
 * - **C** — the local root-services connection (`hubServiceIdRegistry::registerServiceId`,
 *   `hubrpc.directory`, `identity::*`, …),
 * - **H** — the uplink to the parent hub.
 *
 * Routing rules (verbatim to the design):
 * ```
 *   P·root → C        P·*    → H
 *   H·*    → P        H·root → P
 *   C·*    → P
 * ```
 * where `root` means a bare/interface-form method and `*` a fully-qualified
 * (`serviceId::…`) method. Responses follow the reverse path. `H·root → P`
 * lets the parent hub reach the participant's *own* root services (e.g. the
 * participant-served root directory) — distinct from `P·root → C`, which is
 * the participant *consuming* the overlay's root services; the two are
 * opposite directions served by different connections, so they never collide.
 *
 * ### `$stream::send` — correlated by `requestId`, not by method form
 *
 * A {@link STREAM_METHOD} (`$stream::send`) notification is *interface-form*
 * (`$stream::send`), so the method-form rules above would naively treat it as
 * `root` and send a participant's stream to **C** (and route an inbound one as
 * a root call to **P**). That is wrong: a stream message belongs to an in-flight
 * request's lifetime and must follow **that request's** path, exactly like a
 * response does. So `$stream::send` bypasses the method-form table and is
 * routed like a response instead:
 *
 * - **P → ?**: the participant streams using the `requestId` it *observed*,
 *   which for a request it serves is the tag the splitter stamped on the
 *   delivered request id (`H\0…` / `C\0…`). We {@link _decodeId | decode} that
 *   tag, restore the original id, and forward to the tagged origin (H or C) —
 *   the same demux responses get. An **untagged** `requestId` means the
 *   participant *initiated* the request (P→H or P→C); we cannot tell which
 *   statelessly, so we default to the **uplink** (the common case: streaming
 *   to a fully-qualified service via the parent).
 * - **H/C → P**: forwarded verbatim to the participant (never dropped), as a
 *   response would be — the parent has already restored P's original
 *   `requestId`, symmetric to response-id rewriting.
 *
 * PARTICIPANT-INITIATED STREAMS — the one stateful case: because `requestId`
 * lives in `params` (not a structural top-level id the splitter rewrites in
 * lock-step), a stream frame for a request the participant *initiated* (`P→C`
 * or `P→H`) carries P's *own untagged* id, which alone cannot say whether the
 * call went to the root (C) or the uplink (H). The splitter therefore keeps a
 * small `requestId → target` map ({@link _pInitiated}), populated when P sends
 * such a request and cleared when its response returns, and consults it to
 * route those frames. This is the splitter's *only* per-request state; every
 * other path still routes statelessly via id-tagging.
 *
 * ### Stateless demux via id-tagging
 *
 * P is the only port that receives requests from *two* sources (H and C),
 * so a response from P is ambiguous and ids can collide (`H` and `C` may
 * each send `id:5`). Rather than a pending-request map (with its attendant
 * timeout/leak problem), the splitter rewrites **only requests destined for
 * P**, prepending the origin and original id type to the id:
 *
 * ```
 *   H→P:  id' = "H\0n\042"     (push origin tag)
 *   C→P:  id' = "C\0s\0abc"
 *   P→?:  decode id' → route to H or C, restore the original id
 * ```
 *
 * Every other edge (P→H, P→C and the responses coming back from H/C to P)
 * passes **verbatim** — those targets each have a single peer, so there is no
 * response ambiguity. The sole exception is *stream* frames for
 * participant-initiated requests, whose target is recovered from the small
 * {@link _pInitiated} map (see above); apart from that the id encodes its own
 * return path.
 *
 * NOTE: unlike the central {@link import('./routingHub').Hub}, the tag is
 * not authenticated. A misbehaving participant could emit a forged tagged
 * response toward H or C; each endpoint still drops ids it has no pending
 * request for, and identity/signing live in a higher layer. For the
 * single-participant overlay this is an acceptable trade for being fully
 * stateless. If unforgeable return paths are ever required here, HMAC the
 * tag with a splitter-private secret.
 */
export class OverlaySplitter<TContext = undefined> {
    private _disposed = false;
    private readonly _inspect: OverlaySplitterInspection | undefined;
    /**
     * Per-request routing target (`C` or `H`) for requests the participant
     * *initiated*, keyed by P's own request id. Streams for those requests
     * carry P's untagged id, which alone can't say whether the call went to the
     * root (C) or the uplink (H); this map recovers it. Populated when P sends
     * the request, cleared when its response returns. The splitter's only
     * per-request state — every other path routes statelessly via id-tagging.
     */
    private readonly _pInitiated = new Map<RequestId, {
        readonly target: 'C' | 'H';
        readonly inspection: boolean;
    }>();
    private readonly _inboundInspectionRequests = new Set<RequestId>();

    constructor(
        private readonly _participant: IMessageTransport<MessageWithCtx<TContext>>,
        private readonly _root: IMessageTransport<JsonRpcMessage, MessageWithCtx<TContext>>,
        private readonly _uplink: IMessageTransport,
        inspection?: OverlaySplitterInspection,
    ) {
        this._inspect = inspection;
        this._participant.setListener((m) => this._onFromParticipant(m));
        this._root.setListener((m) => this._onFromUpstream(m, 'C'));
        this._uplink.setListener((m) => this._onFromUpstream(m, 'H'));
    }

    /** Detach all three ports. Does not dispose the transports themselves. */
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._participant.setListener(undefined);
        this._root.setListener(undefined);
        this._uplink.setListener(undefined);
        this._pInitiated.clear();
        this._inboundInspectionRequests.clear();
    }

    /** Edge id of an upstream origin port. */
    private _originEdge(origin: Origin): string {
        return origin === 'H' ? this._inspect!.edges.h : this._inspect!.edges.c;
    }

    /** Emit a node transit if inspection is enabled. Zero-cost otherwise. */
    private _emit(t: NodeTransit): void {
        if (this._inspect) this._inspect.onTransit(t);
    }

    private _onFromParticipant(m: MessageWithCtx<TContext>): void {
        if (isResponse(m)) {
            // Answer to a tagged inbound request — route by the return tag.
            if (m.id === null) return;
            const dec = _decodeId(m.id);
            if (!dec) return; // untagged response from P → unexpected, drop
            const inspection = this._inboundInspectionRequests.delete(m.id);
            if (dec.origin === 'H') {
                if (this._inspect && !inspection) {
                    this._emit(this._mkResponse(this._inspect.edges.p, m.id, this._inspect.edges.h, dec.id, m));
                }
                void this._uplink.send({ ...m, id: dec.id });
            } else {
                if (this._inspect && !inspection) {
                    this._emit(this._mkResponse(this._inspect.edges.p, m.id, this._inspect.edges.c, dec.id, m));
                }
                // An ordinary context-stamping transport uses an enumerable
                // `context`; the spread preserves its value while the cast
                // restores the typed root port's static witness.
                void this._root.send({ ...m, id: dec.id } as MessageWithCtx<TContext>);
            }
            return;
        }
        const method = _methodOf(m);
        if (method === undefined) return;
        // `$stream::send` is correlated by `requestId`, not by method form:
        // route it like a response (see the class doc), never by the table.
        if (method === STREAM_METHOD) {
            this._routeParticipantStream(m);
            return;
        }
        const rootForm = _isRootForm(method);
        if (rootForm === undefined) {
            // malformed method → drop (no port to route to).
            if (this._inspect) {
                this._emit(this._mkForward(this._inspect.edges.p, m, undefined, method, 'dropped'));
            }
            return;
        }
        // root-form → local root services (C); prefixed → parent (H). The context
        // stamp (if any) rides along verbatim so the root connection can read it.
        // Remember the resolved target for a participant-initiated *request* so
        // its (untagged) stream frames can be routed back to the same port.
        const inspection = isInspectionLifecycle(m);
        if (rootForm) {
            if (this._inspect && !inspection) {
                this._emit(this._mkForward(this._inspect.edges.p, m, this._inspect.edges.c, method, 'forwarded'));
            }
            if (isRequest(m)) this._pInitiated.set(m.id, { target: 'C', inspection });
            void this._root.send(m);
        } else {
            if (this._inspect && !inspection) {
                this._emit(this._mkForward(this._inspect.edges.p, m, this._inspect.edges.h, method, 'forwarded'));
            }
            if (isRequest(m)) this._pInitiated.set(m.id, { target: 'H', inspection });
            void this._uplink.send(m);
        }
    }

    /**
     * Route a participant-emitted `$stream::send` by its `requestId` tag,
     * mirroring how a {@link _onFromParticipant | response} is demuxed. The
     * participant streams with the id it *observed*; for a request it serves
     * that id carries the origin tag the splitter stamped, so decoding it
     * yields the return port and the original id. Untagged → a request the
     * participant *initiated*; recover its target (C or H) from {@link
     * _pInitiated}, defaulting to the uplink.
     */
    private _routeParticipantStream(m: MessageWithCtx<TContext>): void {
        const requestId = _streamRequestId(m);
        const dec = requestId !== undefined ? _decodeId(requestId) : undefined;
        if (dec) {
            const restored = _withRequestId(m, dec.id);
            if (dec.origin === 'H') {
                void this._uplink.send(restored);
            } else {
                void this._root.send(restored as MessageWithCtx<TContext>);
            }
            return;
        }
        // Untagged → participant-initiated request: its id is P's own, so the
        // form-derived target was recorded when the request was forwarded.
        const initiated = requestId !== undefined ? this._pInitiated.get(requestId) : undefined;
        if (initiated?.target === 'C') {
            void this._root.send(m as MessageWithCtx<TContext>);
            return;
        }
        void this._uplink.send(m);
    }

    private _onFromUpstream(m: JsonRpcMessage, origin: Origin): void {
        if (isResponse(m)) {
            // Answer to a participant-initiated request — verbatim to P. The
            // request is now complete, so drop its stream-routing entry.
            const initiated = m.id === null ? undefined : this._pInitiated.get(m.id);
            if (m.id !== null) this._pInitiated.delete(m.id);
            if (this._inspect && initiated?.inspection !== true) {
                this._emit(this._mkResponse(this._originEdge(origin), m.id, this._inspect.edges.p, m.id, m));
            }
            void this._participant.send(m);
            return;
        }
        const method = _methodOf(m);
        if (method === undefined) return;
        // `$stream::send` is correlated by `requestId`, not by method form, so
        // it must reach the participant like a response — never be dropped by
        // the malformed-drop rule below. For a request this overlay forwarded
        // *to* the participant (participant is the callee), the participant
        // observes that request under an origin-encoded id, so an inbound
        // `toCallee` frame must be re-tagged with the same encoded id to match
        // the participant's stream listener. A `toCaller` frame answers a
        // participant-initiated request and keeps the participant's own id.
        if (method === STREAM_METHOD) {
            if (_streamDir(m) === StreamDir.toCallee) {
                const requestId = _streamRequestId(m);
                if (requestId !== undefined) {
                    void this._participant.send(_withRequestId(m, _encodeId(origin, requestId)));
                    return;
                }
            }
            void this._participant.send(m);
            return;
        }
        // Malformed → drop (no port to route to). Everything well-formed from H
        // or C reaches P: prefixed H·* → P, root-form H·root → P (the
        // participant serves its own root services), and all C·* → P.
        if (_isRootForm(method) === undefined) {
            if (this._inspect) {
                this._emit(this._mkForward(this._originEdge(origin), m, undefined, method, 'dropped'));
            }
            return;
        }

        if (isRequest(m)) {
            const encodedId = _encodeId(origin, m.id);
            const inspection = isInspectionLifecycle(m);
            if (inspection) this._inboundInspectionRequests.add(encodedId);
            if (this._inspect && !inspection) {
                this._emit(this._mkForward(this._originEdge(origin), m, this._inspect.edges.p, method, 'forwarded', encodedId));
            }
            void this._participant.send({ ...m, id: encodedId });
        } else if (isNotification(m)) {
            if (this._inspect && !isInspectionLifecycle(m)) {
                this._emit(this._mkForward(this._originEdge(origin), m, this._inspect.edges.p, method, 'forwarded'));
            }
            void this._participant.send(m);
        }
    }

    /** Build a request/notification transit (`out` absent ⇒ dropped here). */
    private _mkForward(
        inEdge: string,
        m: JsonRpcMessage,
        outEdge: string | undefined,
        method: string,
        disposition: 'forwarded' | 'dropped',
        outRequestId?: RequestId,
    ): NodeTransit {
        const id = (m as { id?: RequestId; }).id;
        const isReq = isRequest(m);
        const inEp = { edgeId: inEdge, ...(isReq && id !== undefined ? { requestId: id } : {}) };
        const outEp = outEdge === undefined
            ? undefined
            : { edgeId: outEdge, ...(isReq ? { requestId: outRequestId ?? id } : {}) };
        return {
            ts: Date.now(),
            nodeId: this._inspect!.nodeId,
            in: inEp,
            out: outEp,
            disposition,
            kind: (isReq ? 'request' : 'notification') as TransitKind,
            method,
            params: (m as { params?: JsonValue; }).params,
        };
    }

    /** Build a response transit crossing from `inEdge`/`inId` to `outEdge`/`outId`. */
    private _mkResponse(
        inEdge: string,
        inId: RequestId | null,
        outEdge: string,
        outId: RequestId | null,
        m: JsonRpcMessage,
    ): NodeTransit {
        return {
            ts: Date.now(),
            nodeId: this._inspect!.nodeId,
            in: { edgeId: inEdge, ...(inId !== null ? { requestId: inId } : {}) },
            out: { edgeId: outEdge, ...(outId !== null ? { requestId: outId } : {}) },
            disposition: 'forwarded',
            kind: 'response',
            result: (m as { result?: JsonValue; }).result,
            error: (m as { error?: TransitError; }).error,
        };
    }
}

function _methodOf(m: JsonRpcMessage): string | undefined {
    const method = (m as { method?: unknown; }).method;
    return typeof method === 'string' ? method : undefined;
}

/** Read the `requestId` correlator off a `$stream::send` notification. */
function _streamRequestId(m: JsonRpcMessage): RequestId | undefined {
    const params = (m as { params?: unknown; }).params;
    if (params === null || typeof params !== 'object') return undefined;
    const requestId = (params as { requestId?: unknown; }).requestId;
    return typeof requestId === 'number' || typeof requestId === 'string' ? requestId : undefined;
}

/** Read the `dir` discriminator off a `$stream::send` notification. */
function _streamDir(m: JsonRpcMessage): StreamDir | undefined {
    const params = (m as { params?: unknown; }).params;
    if (params === null || typeof params !== 'object') return undefined;
    const dir = (params as { dir?: unknown; }).dir;
    return dir === StreamDir.toCaller || dir === StreamDir.toCallee ? dir : undefined;
}

/** Clone a `$stream::send` notification with `requestId` replaced (id restore). */
function _withRequestId(m: JsonRpcMessage, requestId: RequestId): JsonRpcMessage {
    const params = { ...(m as { params?: object; }).params, requestId };
    return { ...m, params } as JsonRpcMessage;
}

/** `true` for bare/interface form, `false` for fully-qualified, `undefined` if malformed. */
function _isRootForm(method: string): boolean | undefined {
    const p = parseMethodName(method);
    if (!p) return undefined;
    return p.kind === 'bare' || p.kind === 'interface';
}

function _encodeId(origin: Origin, id: RequestId): string {
    const type = typeof id === 'number' ? 'n' : 's';
    return `${origin}${SEP}${type}${SEP}${String(id)}`;
}

function _decodeId(id: RequestId | null): { origin: Origin; id: RequestId; } | undefined {
    if (typeof id !== 'string') return undefined;
    const i1 = id.indexOf(SEP);
    if (i1 < 0) return undefined;
    const origin = id.slice(0, i1);
    if (origin !== 'H' && origin !== 'C') return undefined;
    const i2 = id.indexOf(SEP, i1 + 1);
    if (i2 < 0) return undefined;
    const type = id.slice(i1 + 1, i2);
    const raw = id.slice(i2 + 1);
    return { origin, id: type === 'n' ? Number(raw) : raw };
}
