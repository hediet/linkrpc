import {
    type MessageWithCtx,
    type ChannelTransport,
    type IMessageTransport,
    type JsonRpcMessage,
    LinkRpcConnection,
    TransportPair,
} from '@hediet/linkrpc';
import { nodeInterface, type TopologyTransportInfo } from '@hediet/linkrpc/inspection';
import { randomUUID } from 'node:crypto';
import { OverlaySplitter, type OverlaySplitterInspection } from './overlaySplitter';
import type { ManagedRoutingTopology } from './routingTopology';

export interface RootOverlayOptions {
    /**
     * The uplink transport to the parent hub. The overlay forwards all
     * prefixed (`serviceId::…`) participant traffic here and receives the
     * parent's routed traffic back. Obtain it from `parentHub.attach(pair.b)`
     * and pass `pair.a`.
     */
    readonly uplink: IMessageTransport;
    /**
     * Optional inspection wiring forwarded to the underlying
     * {@link OverlaySplitter}. Set `edges.h` to the parent hub link's `edgeId`
     * (from `parentHub.attach(...).edgeId`) so transits chain across the
     * boundary.
     */
    readonly inspection?: OverlaySplitterInspection;
    /** Parent-facing topology port. Defaults to a generated connection-lifetime id. */
    readonly uplinkPortId?: string;
}

/**
 * A **RootOverlay** is the per-participant front door. It is a pure
 * {@link OverlaySplitter} wiring with no routing table, no nested hub, and —
 * deliberately — **no knowledge of which services it serves**. It exposes:
 *
 * - {@link root} — the connection serving this participant's root services.
 *   Install bootstrap/identity modules onto it with `registerHubServices` /
 *   `registerIdentityServices` *before or after* connecting the participant.
 * - {@link connectParticipant} — wires the downstream participant through the
 *   splitter (`P·root → root`, `P·* → uplink`, `uplink·* → P`).
 *
 * Because an overlay represents exactly one participant, prefix claims happen
 * only on the parent (via the {@link import('./routingHub').AttachedLink} that
 * `registerHubServices` was given); there is no local table to write.
 *
 * The overlay is generic over the per-call `TContext` its {@link root}
 * connection sees. Pass a context-stamping {@link ChannelTransport} to
 * {@link connectParticipant} to attach per-call context. Most callers connect a
 * plain (or signature-verifying) transport and leave `TContext` as `undefined`
 * (context-free).
 */
export class RootOverlay<TContext = undefined> {
    /**
     * The per-participant root connection. Register the overlay's root
     * services here — e.g. `registerHubServices(overlay.root, upstream)` and
     * `registerIdentityServices(overlay.root, { resolveIdentity })`. Reachable
     * only by this overlay's participant (root-addressed calls land here).
     *
     * Its inbound transport carries the overlay's `TContext`, so identity-aware
     * front doors — notably the consent `hubAccess` service — can be served here
     * for the interface-form calls a participant addresses to its own root.
     */
    public readonly root: LinkRpcConnection<TContext>;
    public readonly nodeId = `overlay:${randomUUID()}`;
    public readonly participantPortId = `port:${randomUUID()}`;
    public readonly rootPortId = `port:${randomUUID()}`;
    public readonly rootNodeId = `endpoint:${randomUUID()}`;
    public readonly uplinkPortId: string;

    private readonly _uplink: IMessageTransport;
    private readonly _rootPair: TransportPair<MessageWithCtx<TContext>, JsonRpcMessage>;
    private readonly _inspection: OverlaySplitterInspection | undefined;
    private _splitter: OverlaySplitter<TContext> | undefined;
    private _disposed = false;

    constructor(options: RootOverlayOptions) {
        this._uplink = options.uplink;
        this._inspection = options.inspection;
        this.uplinkPortId = options.uplinkPortId ?? `port:${randomUUID()}`;
        this._rootPair = new TransportPair<MessageWithCtx<TContext>, JsonRpcMessage>();
        this.root = LinkRpcConnection.fromTransport<TContext>(this._rootPair.b);
        this.root.register(nodeInterface, {
            getNodeId: () => ({
                nodeId: this.nodeId,
                portId: this.participantPortId,
            }),
        });
    }

    public managedTopology(
        edgeLabel?: string,
        peerTransport?: TopologyTransportInfo,
    ): ManagedRoutingTopology {
        return {
            node: {
                nodeId: this.nodeId,
                kind: 'hub',
                label: 'Root overlay',
                ports: [
                    { portId: this.participantPortId, label: 'participant' },
                    { portId: this.rootPortId, label: 'root' },
                    { portId: this.uplinkPortId, label: 'uplink' },
                ],
            },
            hubLinks: [{
                hubPortId: this.uplinkPortId,
                nodePortId: this.uplinkPortId,
                ...(edgeLabel !== undefined ? { label: edgeLabel } : {}),
            }],
            peerPortId: this.participantPortId,
            ...(peerTransport !== undefined ? { peerTransport } : {}),
            adjacentNodes: [{
                nodeId: this.rootNodeId,
                kind: 'endpoint',
                label: 'Root services',
                ports: [{ portId: this.rootPortId }],
            }],
            adjacentLinks: [{
                from: { nodeId: this.nodeId, portId: this.rootPortId },
                to: { nodeId: this.rootNodeId, portId: this.rootPortId },
            }],
        };
    }

    /**
     * Connect the downstream participant. Root-addressed calls from it hit the
     * {@link root} services; prefixed calls forward via the uplink. May be
     * called once.
     *
     * Connect a context-stamping {@link ChannelTransport} when `TContext` is
     * concrete; otherwise connect the raw participant transport directly.
     */
    public connectParticipant(participant: IMessageTransport<MessageWithCtx<TContext>>): void {
        if (this._splitter) throw new Error('RootOverlay: participant already connected');
        this._splitter = new OverlaySplitter<TContext>(participant, this._rootPair.a, this._uplink, this._inspection);
    }

    /**
     * Tear the overlay down: detach the splitter and dispose the internal root
     * transport pair. The caller owns the uplink and the participant transport
     * and disposes them separately (disposing the uplink's
     * {@link import('./routingHub').AttachedLink} releases any claimed prefixes
     * on the parent). Idempotent.
     */
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._splitter?.dispose();
        this._rootPair.a.dispose();
        this._rootPair.b.dispose();
    }
}
