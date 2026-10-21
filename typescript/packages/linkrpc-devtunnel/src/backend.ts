import type { Duplex } from 'node:stream';
import crossSpawn from 'cross-spawn';
import { ConnectionStatus, TunnelRelayTunnelClient, TunnelRelayTunnelHost } from '@microsoft/dev-tunnels-connections';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { ManagementApiVersions, TunnelManagementHttpClient } from '@microsoft/dev-tunnels-management';

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
    connect(tunnel: MeshTunnel): Promise<TunnelConnection>;
}

/** Microsoft's first-party Dev Tunnels application, as used by VS Code and the devtunnel CLI. */
const DEV_TUNNELS_RESOURCE = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const MESH_LABEL = 'linkrpc-hub';
/** A virtual port: streams go to the daemon, not to a local listener. */
const HUB_PORT = 31547;
const PORT_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

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
        host.forwardedPortConnecting(e => {
            if (e.port === HUB_PORT) onStream(e.stream);
            else e.stream.destroy();
        });
        const closed = _disconnected(host);
        try {
            await host.connect(tunnel);
        } catch (error) {
            void host.dispose();
            throw error;
        }
        return { tunnelId: tunnel.tunnelId!, closed, dispose: () => void host.dispose() };
    }

    public async connect(target: MeshTunnel): Promise<TunnelConnection> {
        const tunnel = await this._management.getTunnel(
            { tunnelId: target.tunnelId, clusterId: target.clusterId },
            { tokenScopes: ['connect'], includePorts: true },
        );
        if (!tunnel) throw new Error(`tunnel ${target.tunnelId} no longer exists`);
        const client = new TunnelRelayTunnelClient(this._management);
        client.acceptLocalConnectionsForForwardedPorts = false;
        const closed = _disconnected(client).then(() => undefined);
        try {
            await client.connect(tunnel);
            await _withTimeout(client.waitForForwardedPort(HUB_PORT), PORT_TIMEOUT_MS, 'the hub port');
        } catch (error) {
            void client.dispose();
            throw error;
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
        const { code, stdout, stderr } = await _run(this._azureCli, ['account', 'get-access-token', '--resource', DEV_TUNNELS_RESOURCE, '--output', 'json']);
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

function _run(file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string; }> {
    return new Promise(resolve => {
        const child = crossSpawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', error => resolve({ code: -1, stdout, stderr: error.message }));
        child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    });
}
