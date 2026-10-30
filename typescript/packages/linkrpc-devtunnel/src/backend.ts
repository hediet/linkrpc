import type { Duplex } from 'node:stream';
import crossSpawn from 'cross-spawn';
import { ConnectionStatus, TunnelRelayTunnelClient, TunnelRelayTunnelHost } from '@microsoft/dev-tunnels-connections';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { ManagementApiVersions, TunnelManagementHttpClient, type TunnelManagementClient } from '@microsoft/dev-tunnels-management';

/** A hub's tunnel on the account. */
export interface MeshTunnel {
    readonly tunnelId: string;
    readonly clusterId: string;
    readonly hubServiceId: string;
    /** Whether its hub is currently hosting it. */
    readonly online: boolean;
}

export interface TunnelHosting {
    readonly tunnelId: string;
    /** Resolves when hosting ended for good (with the cause, if any). */
    readonly closed: Promise<Error | undefined>;
    dispose(): void;
}

export interface TunnelConnection {
    /** A new byte stream to the tunnel's host. */
    openStream(): Promise<Duplex>;
    /** Resolves when the relay connection ended. */
    readonly closed: Promise<void>;
    dispose(): void;
}

/** The tunnel service, abstracted for tests. */
export interface TunnelBackend {
    /** The tunnels of all hubs on the account. */
    list(): Promise<MeshTunnel[]>;
    /** Host the tunnel of `hubServiceId` (created on demand); each client connection arrives at `onStream`. */
    host(hubServiceId: string, onStream: (stream: Duplex) => void): Promise<TunnelHosting>;
    /** Connect to the tunnel's host; aborting `signal` cancels a pending connection. */
    connect(tunnel: MeshTunnel, signal: AbortSignal): Promise<TunnelConnection>;
}

/** Microsoft's first-party Dev Tunnels application, as used by VS Code and the devtunnel CLI. */
const DEV_TUNNELS_RESOURCE = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const MESH_LABEL = 'linkrpc-hub';
/** A virtual port: streams go to the daemon, not to a local listener. */
const HUB_PORT = 31547;
const PORT_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const AZURE_CLI_TIMEOUT_MS = 60_000;
/**
 * The relay is pinged this often; after a few unanswered pings the session is
 * closed, so a link that died silently (sleep, network change) ends instead of
 * hanging. The SDK's own reconnect is off: the mesh reconnects (and logs it).
 */
const SESSION_OPTIONS = { keepAliveIntervalInSeconds: 15, enableReconnect: false };
const MAX_KEEP_ALIVE_FAILURES = 3;

/**
 * Dev Tunnels through the official SDK. Tunnels are private (owner only) and
 * found by label; a tunnel's description is its hub service ID.
 */
export class DevTunnelsSdkBackend implements TunnelBackend {
    private readonly _management: TunnelManagementHttpClient;

    constructor(accessToken: () => Promise<string>) {
        this._management = new TunnelManagementHttpClient(
            'linkrpc-devtunnel',
            ManagementApiVersions.Version20230927preview,
            async () => `Bearer ${await accessToken()}`,
        );
    }

    public async list(): Promise<MeshTunnel[]> {
        const tunnels = await this._management.listTunnels(undefined, undefined, { labels: [MESH_LABEL], includePorts: true });
        return tunnels.flatMap(tunnel => {
            if (!tunnel.tunnelId || !tunnel.clusterId || !tunnel.description) return [];
            return [{
                tunnelId: tunnel.tunnelId,
                clusterId: tunnel.clusterId,
                hubServiceId: tunnel.description,
                online: _isHosted(tunnel),
            }];
        });
    }

    public async host(hubServiceId: string, onStream: (stream: Duplex) => void): Promise<TunnelHosting> {
        const tunnel = await this._ensureTunnel(hubServiceId);
        const host = new TunnelRelayTunnelHost(this._management);
        host.forwardConnectionsToLocalPorts = false;
        keepPortsOnTunnelRefresh(host, this._management);
        host.forwardedPortConnecting(e => {
            if (e.port === HUB_PORT) onStream(e.stream);
            else e.stream.destroy();
        });
        _closeWhenUnresponsive(host);
        const closed = _disconnected(host);
        try {
            await host.connect(tunnel, SESSION_OPTIONS);
        } catch (error) {
            void host.dispose();
            throw error;
        }
        return { tunnelId: tunnel.tunnelId!, closed, dispose: () => void host.dispose() };
    }

    public async connect(target: MeshTunnel, signal: AbortSignal): Promise<TunnelConnection> {
        const tunnel = await this._management.getTunnel(
            { tunnelId: target.tunnelId, clusterId: target.clusterId },
            { tokenScopes: ['connect'], includePorts: true },
        );
        if (!tunnel) throw new Error(`tunnel ${target.tunnelId} no longer exists`);
        signal.throwIfAborted();
        const client = new TunnelRelayTunnelClient(this._management);
        client.acceptLocalConnectionsForForwardedPorts = false;
        _closeWhenUnresponsive(client);
        const closed = _disconnected(client).then(() => undefined);
        // Disposing cancels `connect`, which otherwise retries network errors forever.
        const cancel = (): void => void client.dispose();
        signal.addEventListener('abort', cancel, { once: true });
        try {
            await client.connect(tunnel, SESSION_OPTIONS);
            await _withTimeout(client.waitForForwardedPort(HUB_PORT), PORT_TIMEOUT_MS, 'the hub port');
            signal.throwIfAborted();
        } catch (error) {
            void client.dispose();
            throw error;
        } finally {
            signal.removeEventListener('abort', cancel);
        }
        return {
            openStream: () => client.connectToForwardedPort(HUB_PORT) as Promise<Duplex>,
            closed,
            dispose: () => void client.dispose(),
        };
    }

    private async _ensureTunnel(hubServiceId: string): Promise<Tunnel> {
        const options = { tokenScopes: ['host'], includePorts: true };
        const existing = (await this._management.listTunnels(undefined, undefined, { labels: [MESH_LABEL] }))
            .find(tunnel => tunnel.description === hubServiceId);
        if (!existing) {
            return this._management.createTunnel({
                labels: [MESH_LABEL],
                description: hubServiceId,
                ports: [{ portNumber: HUB_PORT, protocol: 'auto' }],
            }, options);
        }
        const tunnel = await this._management.getTunnel(existing, options);
        if (!tunnel) throw new Error(`tunnel ${existing.tunnelId} disappeared`);
        if (!tunnel.ports?.some(port => port.portNumber === HUB_PORT)) {
            await this._management.createTunnelPort(tunnel, { portNumber: HUB_PORT, protocol: 'auto' });
        }
        return tunnel;
    }
}

/**
 * Dev Tunnels access tokens from the Azure CLI's sign-in (`az login`): no app
 * registration needed. Cached until shortly before they expire.
 */
export class AzureCliTokenSource {
    private _cached: { readonly token: string; readonly expiresAt: number; } | undefined;
    private _pending: Promise<string> | undefined;

    constructor(private readonly _azureCli: string) { }

    public get(): Promise<string> {
        if (this._cached && this._cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
            return Promise.resolve(this._cached.token);
        }
        this._pending ??= this._fetch().finally(() => { this._pending = undefined; });
        return this._pending;
    }

    private async _fetch(): Promise<string> {
        const { code, stdout, stderr } = await _run(this._azureCli, ['account', 'get-access-token', '--resource', DEV_TUNNELS_RESOURCE, '--output', 'json'], AZURE_CLI_TIMEOUT_MS);
        if (code !== 0) {
            throw new Error(`'${this._azureCli} account get-access-token' failed (sign in with 'az login'): ${(stderr || stdout).trim()}`);
        }
        const result = JSON.parse(stdout) as { accessToken: string; expires_on?: number; expiresOn?: string; };
        const expiresAt = result.expires_on !== undefined
            ? result.expires_on * 1000
            : result.expiresOn !== undefined ? Date.parse(result.expiresOn) : Date.now() + 30 * 60_000;
        this._cached = { token: result.accessToken, expiresAt };
        return result.accessToken;
    }
}

/**
 * Whether `error` is the Dev Tunnels SDK's `CancellationError`. When a relay
 * session is torn down, the SDK rejects pending stream reads with it, and some
 * of those reads are awaited inside the SDK without a handler.
 */
export function isSdkCancellation(error: unknown): boolean {
    return error instanceof Error && error.constructor.name === 'CancellationError';
}

function _isHosted(tunnel: Tunnel): boolean {
    if ((tunnel.endpoints?.length ?? 0) > 0) return true;
    const count = tunnel.status?.hostConnectionCount;
    return (typeof count === 'number' ? count : count?.current ?? 0) > 0;
}

/**
 * A host forwards only the ports of its tunnel object to clients. When the relay
 * rejects an expired access token (e.g. `connect` retried until the machine woke
 * up), the SDK re-fetches the tunnel without ports, so clients would never get
 * the hub port. This makes such refreshes include the ports.
 */
export function keepPortsOnTunnelRefresh(host: TunnelRelayTunnelHost, management: TunnelManagementClient): void {
    host.refreshingTunnel(e => {
        if (!e.tunnel) return;
        e.tunnelPromise = management.getTunnel(e.tunnel, { tokenScopes: [e.tunnelAccessScope], includePorts: true }, e.cancellation);
    });
}

/** The SDK only reports missed keep-alives; this ends the session after a few. */
function _closeWhenUnresponsive(session: TunnelRelayTunnelHost | TunnelRelayTunnelClient): void {
    session.keepAliveFailed(e => {
        if (e.count >= MAX_KEEP_ALIVE_FAILURES) void session.dispose();
    });
}

function _disconnected(session: TunnelRelayTunnelHost | TunnelRelayTunnelClient): Promise<Error | undefined> {
    return new Promise(resolve => {
        session.connectionStatusChanged(e => {
            if (e.status === ConnectionStatus.Disconnected) resolve(e.disconnectError ?? session.disconnectError);
        });
    });
}

function _withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs `file`; one that does not exit within `timeoutMs` is killed and reported as failed. */
function _run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; }> {
    return new Promise(resolve => {
        const child = crossSpawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            stderr += `\ntimed out after ${timeoutMs / 1000} s`;
            child.kill();
        }, timeoutMs);
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', error => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: error.message });
        });
        child.once('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}
