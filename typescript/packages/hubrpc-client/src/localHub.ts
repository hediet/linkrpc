import { type Identity, InMemoryManagedIdentity, type IMessageTransport, TransportPair } from '@vscode/hubrpc';
import { Hub, HubConnectionAcceptor, anonymousHandler, createHubServiceInterfaces } from '@vscode/hubrpc-hub/hub/server/client';
import {
    type AttachedLink,
    registerHubServices,
    registerIdentityServices,
    RootOverlay,
} from '@vscode/hubrpc-hub/hub/server/client';
import { type NodeSocketTransport, SocketServer } from '@vscode/hubrpc-hub/hub/server/node';
import type { RootProvision } from '@vscode/hubrpc-hub/hub/server/client';
import { type EndpointCommand, loadOrCreateIdentity } from '@vscode/hubrpc/node';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnCommand } from '@vscode/hubrpc-hub/spawn';

/** Default serviceId namespace the local-hub child may claim (and sees via `hubGrantedServiceId::get`). */
const DEFAULT_LOCAL_NAMESPACE = 'local';

/** Re-export for backwards compatibility within the CLI. */
export const LOCAL_NAMESPACE = DEFAULT_LOCAL_NAMESPACE;

/** Subfolder (under the hubrpc data dir) holding provisioned identity slots. */
const PROVISION_SUBDIR = 'provisioned-identities';

/** Provisioned slots untouched for longer than this are swept on next run. */
const PROVISION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * A running in-process hub plus the child it spawned. The CLI connects to
 * `socketPath` (presenting `token`) exactly as it would to any socket hub, and
 * calls {@link dispose} to tear the child + server down.
 */
export interface LocalHub {
    readonly socketPath: string;
    readonly token: string;
    dispose(): void;
}

export interface StartLocalHubOptions {
    /** Command to spawn as the hub participant. */
    readonly command: EndpointCommand;
    /**
     * When set, the hub serves a *persistent* managed identity loaded from this
     * slot id (reused across runs). Omitted → a fresh ephemeral identity.
     */
    readonly provisionSlot: string | undefined;
    /** Extra env vars injected into the child (the hub's HUBRPC_* vars win). */
    readonly env?: Readonly<Record<string, string>>;
    /** Working directory for the spawned child. */
    readonly cwd?: string;
    /** Max time to wait for the child to claim its namespace. Default 30s. */
    readonly readyTimeoutMs?: number;
}

/**
 * Start an in-process hub on a private socket, spawn `command` as a participant
 * (handing it the socket + token via `HUBRPC_ENDPOINT` / `HUBRPC_TOKEN`), and
 * resolve once the child has registered a service under {@link LOCAL_NAMESPACE}.
 *
 * The hub is single-tenant and local: no claim policy (every well-formed claim
 * is allowed) and no provenance. Identity is either ephemeral (fresh per run)
 * or, when `provisionSlot` is set, a persisted managed identity so the child's
 * HPKE wrap/unwrap keys survive across runs.
 */
export async function startLocalHub(opts: StartLocalHubOptions): Promise<LocalHub> {
    const resolveIdentity = _makeIdentityResolver(opts.provisionSlot);
    const grantedNs = DEFAULT_LOCAL_NAMESPACE;

    const hub = new Hub();
    createHubServiceInterfaces(hub);

    const socketPath = SocketServer.allocSocketPath();
    const token = randomBytes(16).toString('hex');

    const socketServer = await SocketServer.start({
        endpoint: socketPath,
    });

    const acceptor = new HubConnectionAcceptor<NodeSocketTransport>({
        server: socketServer,
        hub,
        // No policy → allow every well-formed claim (single-tenant local hub).
        // A single anonymous handler admits the child and provisions its granted
        // namespace and (optionally) a persisted managed identity.
        handlers: [
            anonymousHandler({
                grantedServiceIdNamespace: grantedNs,
                ...(resolveIdentity ? { resolveIdentity } : {}),
            } satisfies RootProvision),
        ],
    });

    const child = spawnCommand(opts.command, {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, ...opts.env, HUBRPC_ENDPOINT: socketPath, HUBRPC_TOKEN: token },
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    let childExited = false;
    child.once('exit', () => {
        childExited = true;
    });

    const dispose = (): void => {
        if (!child.killed) child.kill();
        acceptor.dispose();
        socketServer.dispose();
        if (process.platform !== 'win32') {
            try {
                fs.unlinkSync(socketPath);
            } catch { /* ignore */ }
        }
    };

    try {
        await _waitForClaim(hub, grantedNs, () => childExited, opts.readyTimeoutMs ?? 30_000);
    } catch (e) {
        dispose();
        throw e;
    }

    return { socketPath, token, dispose };
}

/**
 * A **RootOverlay** fronting a spawned `cmd-env` child, without a routing hub.
 * The child's root-form calls (`identity::*`, `hubGrantedServiceId::*`,
 * `hubrpc.directory`, `hubAccess`) are served locally on {@link RootOverlay.root};
 * every prefixed request/response is relayed verbatim over {@link uplink}.
 *
 * This is the tunnel's target front end: the tunnel drives {@link uplink} as the
 * "parent" so forwarded requests reach the child directly through the overlay
 * splitter. Unlike {@link startLocalHub} there is no hub, no `hub` service id,
 * and no claim to wait for — a plain service target works without the hub-claim
 * dance — while `--provision-identity` still gets `identity::*` served locally.
 */
export interface LocalOverlay {
    /** Transport carrying forwarded (prefixed) traffic to/from the participant. */
    readonly uplink: IMessageTransport;
    dispose(): void;
}

export interface StartLocalOverlayOptions {
    /** Command to spawn as the participant. */
    readonly command: EndpointCommand;
    /**
     * When set, `identity::*` is served from a persistent managed identity
     * loaded from this slot (reused across runs). Omitted → no identity served.
     */
    readonly provisionSlot: string | undefined;
    /** Extra env vars injected into the child. */
    readonly env?: Readonly<Record<string, string>>;
    /** Working directory for the spawned child. */
    readonly cwd?: string;
    /**
     * ServiceId namespace surfaced to the child via `hubGrantedServiceId::get`
     * and freely claimable through `hubGrantedServiceId::register`.
     */
    readonly grantedNamespace: string;
}

/**
 * The overlay's claim front door has no routing table to write: the tunnel owns
 * the real claim on the source hub, and the splitter relays every uplink request
 * to the child regardless. So `hubGrantedServiceId::register` succeeds as a
 * no-op through this stub link.
 */
const _noopUpstream: AttachedLink = {
    claimPrefix: () => { },
    releasePrefix: () => false,
    edgeId: 'overlay-uplink',
    dispose: () => { },
};

export async function startLocalOverlay(opts: StartLocalOverlayOptions): Promise<LocalOverlay> {
    const resolveIdentity = _makeIdentityResolver(opts.provisionSlot);

    const socketPath = SocketServer.allocSocketPath();
    const token = randomBytes(16).toString('hex');
    const socketServer = await SocketServer.start({ endpoint: socketPath });

    const accepted = new Promise<NodeSocketTransport>((resolve) => {
        socketServer.setConnectionHandler((t) => resolve(t));
    });

    const child = spawnCommand(opts.command, {
        // The child speaks hubrpc over the socket, so its stdio stays free for
        // diagnostics — inherit it so a child that fails to start is visible.
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, ...opts.env, HUBRPC_ENDPOINT: socketPath, HUBRPC_TOKEN: token },
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });

    const pair = new TransportPair();
    const overlay = new RootOverlay({ uplink: pair.a });
    registerHubServices(overlay.root, _noopUpstream, { grantedServiceIdNamespace: opts.grantedNamespace });
    if (resolveIdentity !== undefined) {
        registerIdentityServices(overlay.root, { resolveIdentity });
    }

    const dispose = (): void => {
        if (!child.killed) child.kill();
        overlay.dispose();
        pair.a.dispose();
        pair.b.dispose();
        socketServer.dispose();
        if (process.platform !== 'win32') {
            try {
                fs.unlinkSync(socketPath);
            } catch { /* ignore */ }
        }
    };

    const childTransport = await Promise.race([
        accepted,
        new Promise<never>((_resolve, reject) => {
            child.once('exit', (code) =>
                reject(new Error(`overlay: cmd-env child exited (code ${code ?? '?'}) before connecting`)),
            );
        }),
    ]).catch((err: unknown) => {
        dispose();
        throw err;
    });

    overlay.connectParticipant(childTransport);
    return { uplink: pair.b, dispose };
}

/**
 * Build the hub's `resolveIdentity`, or `undefined` when no identity should be
 * provided. Without `provisionSlot` the hub serves no identity at all — a child
 * that needs `identity::*` will fail. With it, a single persisted managed
 * identity is shared by all connections (stale slots swept first), so the
 * child's HPKE wrap/unwrap keys survive across runs.
 */
function _makeIdentityResolver(
    provisionSlot: string | undefined,
): (() => Promise<Identity>) | undefined {
    if (provisionSlot === undefined) {
        return undefined;
    }

    const dir = _provisionDir();
    _sweepProvisionedIdentities(dir);
    let shared: Promise<Identity> | undefined;
    return () => {
        if (!shared) {
            shared = (async () => {
                const persisted = await loadOrCreateIdentity({ id: provisionSlot, storeDir: dir });
                return new InMemoryManagedIdentity(persisted.keypair, persisted.wrapKeypair);
            })();
        }
        return shared;
    };
}

/** Resolve the slot id for a `--provision-identity` / `--provision-identity-slot` run. */
export function resolveProvisionSlot(
    explicitSlot: string | undefined,
    provisionIdentity: boolean,
    commandString: string,
): string | undefined {
    if (explicitSlot !== undefined) {
        return explicitSlot;
    }
    if (provisionIdentity) {
        return JSON.stringify({ cwd: process.cwd(), cmdStr: commandString });
    }
    return undefined;
}

/** Dedicated provisioned-identity folder (sibling of hubrpc's user identities). */
function _provisionDir(): string {
    const home = os.homedir();
    let base: string;
    if (process.platform === 'win32') {
        base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
        base = path.join(home, 'Library', 'Application Support');
    } else {
        base = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
    }
    return path.join(base, 'hubrpc', PROVISION_SUBDIR);
}

/** Delete provisioned identity files whose mtime is older than the max age. */
function _sweepProvisionedIdentities(dir: string): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return; // dir absent → nothing to sweep
    }
    const cutoff = Date.now() - PROVISION_MAX_AGE_MS;
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
            if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
        } catch { /* ignore */ }
    }
}

/** Resolve once the child claims `prefix` (or a sub-prefix), else reject. */
function _waitForClaim(
    hub: Hub,
    prefix: string,
    childExited: () => boolean,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
        const check = (): void => {
            if (hub.claimedPrefixes().some((p) => p === prefix || p.startsWith(`${prefix}/`))) {
                resolve();
                return;
            }
            if (childExited()) {
                reject(new Error('connect: command exited before registering a service'));
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`connect: timed out waiting for command to register a service under '${prefix}'`));
                return;
            }
            setTimeout(check, 50);
        };
        check();
    });
}
