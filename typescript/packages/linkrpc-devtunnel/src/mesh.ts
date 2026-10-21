import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import type { MeshTunnel, TunnelBackend, TunnelHosting } from './backend';
import { connectOverStream, forwardTo, type RawConnection } from './forward';

export interface DevTunnelMeshOptions {
    readonly backend: TunnelBackend;
    /**
     * Open a connection to the local hub whose granted service ID namespace
     * contains the peers' hub IDs (the service's `LINKRPC_ENDPOINT`).
     */
    readonly openLocal: () => Promise<RawConnection>;
    /** The local hub's application endpoint; each hosted tunnel stream is piped into it. */
    readonly appEndpoint: string | undefined;
    readonly host: boolean;
    readonly connect: boolean;
    readonly log: (line: string) => void;
    readonly discoveryIntervalMs?: number;
}

const DISCOVERY_INTERVAL_MS = 30_000;
const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
/** A link that stays up this long resets the retry delay. */
const STABLE_AFTER_MS = 30_000;

const GET_NAMESPACE = 'hubGrantedServiceId::get';
const GET_HUB_SERVICE_ID = 'hubGrantedServiceId::getHubServiceId';
const CLAIM = 'hubGrantedServiceId::register';

/**
 * Connects the local hub to the hubs on the account's other machines through
 * private Dev Tunnels:
 *
 * - **Host:** the hub's tunnel (created on demand, described by its hub ID)
 *   pipes every incoming stream into the hub's application endpoint, so a
 *   remote mesh service enters like a local application.
 * - **Connect:** every online peer gets one local connection that claims the
 *   peer's hub ID inside this service's granted namespace and forwards each
 *   call verbatim over the peer's tunnel (like `linkrpc hub tunnel`). Closing
 *   the connection releases the claim.
 */
export class DevTunnelMesh {
    public static async start(options: DevTunnelMeshOptions): Promise<DevTunnelMesh> {
        const control = await options.openLocal();
        try {
            const { hubServiceId } = await control.channel.sender.sendRequest(GET_HUB_SERVICE_ID, {}) as { hubServiceId: string; };
            const { grantedServiceIdNamespace } = await control.channel.sender.sendRequest(GET_NAMESPACE, {}) as { grantedServiceIdNamespace: string; };
            return new DevTunnelMesh(options, control, hubServiceId, grantedServiceIdNamespace);
        } catch (error) {
            control.close();
            throw error;
        }
    }

    /** Resolves when the local hub connection closed (e.g. the hub stopped). */
    public readonly closed: Promise<void>;

    private readonly _peers = new Map<string, PeerLink>();
    private readonly _skipped = new Set<string>();
    private _hosting: TunnelHosting | undefined;
    private _discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    private _hostRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private _hostRetryMs = MIN_RETRY_MS;
    private _discoveryError: string | undefined;
    private _disposed = false;

    private constructor(
        private readonly _options: DevTunnelMeshOptions,
        private readonly _control: RawConnection,
        public readonly hubServiceId: string,
        public readonly namespace: string,
    ) {
        this.closed = _control.closed;
        void _control.closed.then(() => this.dispose());
        _options.log(`hub ${hubServiceId}; peers are claimed under '${namespace}'`);
        if (_options.host) void this._startHosting();
        if (_options.connect) void this._discover();
    }

    /** Peers with a working link, by hub ID. */
    public connectedPeers(): string[] {
        return [...this._peers.values()].filter(peer => peer.connected).map(peer => peer.tunnel.hubServiceId).sort();
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        clearTimeout(this._discoveryTimer);
        clearTimeout(this._hostRetryTimer);
        this._hosting?.dispose();
        for (const peer of this._peers.values()) peer.dispose();
        this._peers.clear();
        this._control.close();
    }

    private async _startHosting(): Promise<void> {
        const appEndpoint = this._options.appEndpoint;
        if (appEndpoint === undefined) {
            this._options.log('cannot host: the hub\'s application endpoint is unknown (pass --hub-endpoint)');
            return;
        }
        let hosting: TunnelHosting;
        try {
            hosting = await this._options.backend.host(this.hubServiceId, stream => _pipeToEndpoint(stream, appEndpoint));
        } catch (error) {
            this._hostFailed(_message(error));
            return;
        }
        if (this._disposed) {
            hosting.dispose();
            return;
        }
        this._hosting = hosting;
        this._hostRetryMs = MIN_RETRY_MS;
        this._options.log(`hosting tunnel ${hosting.tunnelId}`);
        const cause = await hosting.closed;
        if (this._disposed) return;
        this._hosting = undefined;
        this._hostFailed(`hosting ended${cause ? `: ${cause.message}` : ''}`);
    }

    private _hostFailed(error: string): void {
        if (this._disposed) return;
        this._options.log(`cannot host the tunnel: ${error}; retrying in ${Math.round(this._hostRetryMs / 1000)} s`);
        this._hostRetryTimer = setTimeout(() => void this._startHosting(), this._hostRetryMs);
        this._hostRetryMs = Math.min(MAX_RETRY_MS, this._hostRetryMs * 2);
    }

    private async _discover(): Promise<void> {
        try {
            const tunnels = await this._options.backend.list();
            if (this._disposed) return;
            const online = new Map<string, MeshTunnel>();
            for (const tunnel of tunnels) {
                if (!tunnel.online || tunnel.hubServiceId === this.hubServiceId) continue;
                if (!_isUnder(tunnel.hubServiceId, this.namespace)) {
                    if (!this._skipped.has(tunnel.hubServiceId)) {
                        this._skipped.add(tunnel.hubServiceId);
                        this._options.log(`[${tunnel.hubServiceId}] skipped: not under the granted namespace '${this.namespace}'`);
                    }
                    continue;
                }
                online.set(tunnel.hubServiceId, tunnel);
            }
            for (const [hubServiceId, peer] of this._peers) {
                if (online.get(hubServiceId)?.tunnelId === peer.tunnel.tunnelId) continue;
                this._options.log(`[${hubServiceId}] went offline`);
                peer.dispose();
                this._peers.delete(hubServiceId);
            }
            for (const [hubServiceId, tunnel] of online) {
                if (this._peers.has(hubServiceId)) continue;
                this._options.log(`[${hubServiceId}] online (tunnel ${tunnel.tunnelId})`);
                this._peers.set(hubServiceId, new PeerLink(tunnel, this._options));
            }
            this._discoveryError = undefined;
        } catch (error) {
            const message = _message(error);
            if (message !== this._discoveryError) this._options.log(`cannot discover peers: ${message}`);
            this._discoveryError = message;
        }
        if (!this._disposed) {
            this._discoveryTimer = setTimeout(() => void this._discover(), this._options.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS);
        }
    }
}

/** Keeps one forwarding link to a peer hub while it is online. */
class PeerLink {
    public connected = false;
    private readonly _stop = new AbortController();

    constructor(
        public readonly tunnel: MeshTunnel,
        private readonly _options: DevTunnelMeshOptions,
    ) {
        void this._run();
    }

    public dispose(): void {
        this._stop.abort();
    }

    private async _run(): Promise<void> {
        let retryMs = MIN_RETRY_MS;
        while (!this._stop.signal.aborted) {
            const startedAt = Date.now();
            try {
                await this._connectOnce();
            } catch (error) {
                if (this._stop.signal.aborted) return;
                this._options.log(`[${this.tunnel.hubServiceId}] cannot connect: ${_message(error)}`);
            }
            if (Date.now() - startedAt > STABLE_AFTER_MS) retryMs = MIN_RETRY_MS;
            if (!await _delay(retryMs, this._stop.signal)) return;
            retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
        }
    }

    /** Resolves when the established link closed. */
    private async _connectOnce(): Promise<void> {
        const peer = this.tunnel.hubServiceId;
        const cleanup: Array<() => void> = [];
        const stopped = new Promise<void>(resolve => this._stop.signal.addEventListener('abort', () => resolve(), { once: true }));
        try {
            const relay = await this._options.backend.connect(this.tunnel);
            cleanup.push(() => relay.dispose());
            const remote = await connectOverStream(await relay.openStream());
            cleanup.push(() => remote.close());
            const local = await this._options.openLocal();
            cleanup.push(() => local.close());
            if (this._stop.signal.aborted) return;
            local.channel.setRequestHandler(forwardTo(remote.channel.sender));
            await local.channel.sender.sendRequest(CLAIM, { serviceId: peer });
            this.connected = true;
            this._options.log(`[${peer}] connected`);
            await Promise.race([remote.closed, local.closed, relay.closed, stopped]);
            if (!this._stop.signal.aborted) this._options.log(`[${peer}] disconnected`);
        } finally {
            this.connected = false;
            for (const dispose of cleanup.reverse()) dispose();
        }
    }
}

function _pipeToEndpoint(stream: Duplex, endpoint: string): void {
    const socket = net.createConnection(endpoint);
    stream.pipe(socket);
    socket.pipe(stream);
    const close = (): void => {
        stream.destroy();
        socket.destroy();
    };
    for (const side of [stream, socket]) {
        side.once('error', close);
        side.once('close', close);
    }
}

function _isUnder(serviceId: string, namespace: string): boolean {
    return namespace !== '' && (serviceId === namespace || serviceId.startsWith(`${namespace}/`));
}

function _delay(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function _message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
