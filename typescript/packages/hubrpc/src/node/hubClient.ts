import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Channel } from '../connection/channel';
import { HubRpcConnection } from '../connection/hubRpcConnection';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import {
    OneShotCapStaging,
    Principal, SigningSender,
    type SigningCallCtx,
    type SigningSenderConfig
} from '../identity/signingSender';
import type { SignedCapability } from '../identity/capability';
import {
    base64UrlToBytes,
    bytesToBase64Url,
    type Keypair,
    type PrincipalId,
    principalForPublicKey,
    type X25519Keypair,
} from '../crypto/cryptoProvider';
import * as crypto from '../crypto/crypto';
import { signParams } from '../identity/metaEnvelope';
import { KeypairSigningIdentity } from '../identity/identity';
import type { JsonValue } from '../protocol/jsonValue';
import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { sha256 } from '../crypto/sha256';
import type { IMessageTransport } from '../transport/messageTransport';
import { connectNdjson, runInitializeHandshake } from './initialize';
import { openWebSocket, WebSocketTransport } from './webSocketClientTransport';
import { IDisposable } from '../disposable';
import { Hub, hubFromConnection } from '../hub/client/hubFacade';

/** Env var the hub publishes for its endpoint (named pipe / UDS path). */
export const HUBRPC_ENDPOINT_VAR = 'HUBRPC_ENDPOINT';
/** Env var the hub publishes for its shared attribution token. */
export const HUBRPC_TOKEN_VAR = 'HUBRPC_TOKEN';

export interface ConnectToHubOptions {
    /** Defaults to `process.env.HUBRPC_ENDPOINT`. */
    readonly endpoint?: string;
    /** Defaults to `process.env.HUBRPC_TOKEN`. */
    readonly token?: string;
    /**
     * Initial {@link Principal} (identity + persistent caps) for outbound
     * calls. Stored on the returned handle's {@link HubClientHandle.signing}
     * config; mutate that later to install or swap. `undefined` leaves the
     * connection unsigned (plain JSON-RPC) until a principal is installed.
     */
    readonly principal?: Principal;
    /**
     * Initial one-shot capability staging policy. Same lifecycle as
     * {@link principal}; drained per outbound signed call.
     */
    readonly oneShotCaps?: OneShotCapStaging;
}

/**
 * Mutable signing config consulted per-call by the {@link SigningSender}
 * wrapping a {@link HubClientHandle.connection}. Mutating either field
 * takes effect on the next outbound call. No setter on the sender
 * itself — it is a plain caller-owned {@link SigningSenderConfig}.
 */
export type HubSigningHolder = {
    principal?: Principal;
    capProvider?: SigningSenderConfig['capProvider'];
    oneShotCaps?: OneShotCapStaging;
};

export interface HubClientHandle {
    /** Full hubrpc connection wrapping the same transport. */
    readonly connection: HubRpcConnection<undefined, SigningCallCtx>;
    /**
     * Façade over the hub's own serviceId-routed services (`hubGrantedServiceId`,
     * `hubAccess`, …) on this {@link connection}. Use it to read connection
     * facts ({@link Hub.getConnectionInfo}) or claim this connection's granted
     * serviceId namespace ({@link Hub.claimGrantedServiceIdNamespace}) without
     * hand-routing the interface clients.
     */
    readonly hub: Hub;
    /** Configured endpoint + token (in case the caller defaulted from env). */
    readonly endpoint: string;
    readonly token: string;
    /**
     * Mutable signing config. Starts empty (every call goes out
     * unsigned). `installManagedIdentitySigner` and `setupHubSigning`
     * populate this; user code can also drive it directly.
     */
    readonly signing: HubSigningHolder;
    /**
     * Register a callback that fires when the underlying socket closes
     * (peer end, error, or explicit {@link close}). Fires at most once.
     * Returns an unsubscribe function.
     */
    onClose(listener: () => void): IDisposable;
    /** Close the underlying socket and tear everything down. */
    close(): void;
}

/**
 * Open a connection to a running hubrpc hub. Reads `HUBRPC_ENDPOINT` and
 * `HUBRPC_TOKEN` from the environment unless overridden. Sends the single-
 * line `{"hello":1,"token":"..."}` preamble that the hub's socket server
 * requires, then wraps the socket in an `HubRpcConnection`.
 *
 * Throws if env vars are missing, if the socket cannot be opened, or if the
 * hub refuses the preamble (the socket simply closes — callers should treat
 * an immediate close of the channel as an auth failure).
 */
export async function connectToHub(options: ConnectToHubOptions = {}): Promise<HubClientHandle> {
    const hubChannel = await openHubChannel(options);
    const signing: HubSigningHolder = {
        principal: options.principal,
        oneShotCaps: options.oneShotCaps,
    };
    const channel = SigningSender.wrapChannel(hubChannel, signing);
    const connection = new HubRpcConnection(channel);
    return {
        connection,
        hub: hubFromConnection(connection),
        endpoint: hubChannel.endpoint,
        token: hubChannel.token,
        signing,
        onClose: hubChannel.onClose,
        close: () => {
            connection.close();
            hubChannel.close();
        },
    };
}

/** Options for {@link openHubChannel}. Subset of {@link ConnectToHubOptions}. */
export interface OpenHubChannelOptions {
    /** Defaults to `process.env.HUBRPC_ENDPOINT`. */
    readonly endpoint?: string;
    /**
     * Defaults to `process.env.HUBRPC_TOKEN`, or `''` when unset. The token
     * is sent in the hello preamble; provenance-authenticated hubs (hubv2)
     * ignore it, so an empty token is valid there.
     */
    readonly token?: string;
}

/**
 * A raw, unsigned hub channel: the socket transport wrapped only in a
 * {@link JsonRpcChannel}, with no signing applied. It *is* a {@link Channel}
 * (so it plugs straight into {@link SigningSender.wrapChannel} /
 * `new HubRpcConnection`), augmented with the hub endpoint/token and the
 * socket lifecycle. Identity/signing is composed on top by the caller;
 * {@link connectToHub} is the batteries-included version that adds a
 * mutable signing holder.
 */
export type HubChannel = Channel<undefined, unknown> & {
    readonly endpoint: string;
    readonly token: string;
    /**
     * Register a callback that fires when the socket closes. Fires at most
     * once. Returns an unsubscribe function.
     */
    onClose(listener: () => void): IDisposable;
    /** Close the underlying socket. */
    close(): void;
};

/**
 * Open the hub socket and send the preamble, returning the raw
 * {@link HubChannel} without any signing. Use this when you want to
 * compose identity yourself; otherwise prefer {@link connectToHub}.
 */
export async function openHubChannel(
    options: OpenHubChannelOptions = {},
): Promise<HubChannel> {
    const endpoint = options.endpoint ?? process.env[HUBRPC_ENDPOINT_VAR];
    const token = options.token ?? process.env[HUBRPC_TOKEN_VAR] ?? '';
    if (!endpoint) {
        throw new Error(`${HUBRPC_ENDPOINT_VAR} is not set; cannot connect to hubrpc hub.`);
    }

    const closeListeners = new Set<() => void>();
    let closed = false;
    let closeChannel: (() => void) | undefined;
    const fireClose = () => {
        if (closed) return;
        closed = true;
        closeChannel?.();
        for (const l of closeListeners) {
            try {
                l();
            } catch { /* ignore */ }
        }
        closeListeners.clear();
    };

    const { transport, destroy } = await _openHubTransport(endpoint, token, fireClose);
    const rpc = JsonRpcChannel.createWithClose(transport);
    closeChannel = rpc.close;
    if (closed) rpc.close();
    return Object.assign(rpc.channel, {
        endpoint,
        token,
        onClose: (listener: () => void) => {
            if (closed) {
                queueMicrotask(listener);
                return { dispose: () => { } };
            }
            closeListeners.add(listener);
            return { dispose: () => closeListeners.delete(listener) };
        },
        close: () => {
            destroy();
            fireClose();
        },
    });
}

/** True for `ws://` / `wss://` endpoints (case-insensitive). */
function _isWebSocketEndpoint(endpoint: string): boolean {
    return /^wss?:\/\//i.test(endpoint);
}

/**
 * Open the underlying transport for {@link openHubChannel}, picking the
 * scheme from the endpoint:
 *  - `ws://` / `wss://` → WebSocket; the token is presented via the
 *    `hubrpc::initialize` handshake (browsers cannot set request headers).
 *  - anything else → named pipe / UDS; the token is presented via the
 *    `hubrpc::initialize` handshake the socket server requires.
 *
 * `onClose` fires once when the peer ends the transport.
 */
async function _openHubTransport(
    endpoint: string,
    token: string,
    onClose: () => void,
): Promise<{ transport: IMessageTransport<JsonRpcMessage, JsonRpcMessage>; destroy: () => void; }> {
    if (_isWebSocketEndpoint(endpoint)) {
        const ws = await openWebSocket(endpoint);
        const transport = new WebSocketTransport(ws, onClose);
        const destroy = () => {
            try {
                ws.close();
            } catch { /* ignore */ }
        };
        try {
            await runInitializeHandshake(transport, { kind: 'client', token });
        } catch (err) {
            transport.dispose();
            destroy();
            throw err;
        }
        return { transport, destroy };
    }
    const socket = await _openSocket(endpoint);
    const { transport } = await connectNdjson({
        input: socket,
        output: socket,
        onClose: () => {
            socket.destroy();
            onClose();
        },
        initialize: { kind: 'client', token },
    });
    return { transport, destroy: () => socket.destroy() };
}

/**
 * Send the `hubrpc.hub::hubServiceIdRegistry::registerServiceId` call on an open
 * hub connection. In `openMode` the hub accepts the unsigned call directly —
 * pass no `identity`. Outside `openMode` the caller must sign the params
 * with their `identity` keypair (via `signParams`) and present a
 * capability that authorizes the claim — unless the signer is already an
 * admin on the hub, in which case `capabilities` may be omitted.
 *
 * Resolves once the hub has registered the prefix; rejects on denial.
 */
export interface RegisterHubPrefixOptions {
    readonly handle: HubClientHandle;
    readonly prefix: string;
    /**
     * Caller's signing identity. Required when the hub is not in openMode.
     * The `principal` must encode the `publicKey` (round-tripped through
     * `principalForPublicKey`). Bound to this transport on first successful
     * `register` — subsequent calls on the same socket may not switch
     * identity.
     */
    readonly identity?: { readonly principal: PrincipalId; readonly keypair: Keypair; };
    /**
     * Capabilities to present. Each must be issued (directly or
     * transitively) by an admin and permit
     * `<prefix>::hubServiceIdRegistry::registerServiceId`. Omit when the signer
     * is already an admin.
     */
    readonly capabilities?: readonly SignedCapability[];
}

export async function registerHubPrefix(
    opts: RegisterHubPrefixOptions,
): Promise<void> {
    let params: Record<string, unknown>;
    if (opts.identity) {
        const signer = new KeypairSigningIdentity(
            opts.identity.principal,
            opts.identity.keypair.privateKey,
        );
        params = await signParams({
            method: 'hubServiceIdRegistry::registerServiceId',
            params: { requestedPrefix: opts.prefix },
            signingIdentity: signer,
            ...(opts.capabilities && opts.capabilities.length > 0 ?
                { capabilities: [...opts.capabilities] } :
                {}),
        });
    } else {
        if (opts.capabilities && opts.capabilities.length > 0) {
            throw new Error('registerHubPrefix: capabilities require identity to be set');
        }
        params = { requestedPrefix: opts.prefix };
    }
    await opts.handle.connection.channel.sendRequest(
        'hubServiceIdRegistry::registerServiceId',
        params as JsonValue,
    );
}

// ---- Identity persistence -----------------------------------------------

export interface LoadOrCreateIdentityOptions {
    /**
     * Stable string that identifies this identity slot. Typically the calling
     * module's `import.meta.filename` — each service then automatically gets
     * its own slot.
     */
    readonly id: string;
    /** Override the storage directory (defaults to a per-user folder). */
    readonly storeDir?: string;
    /**
     * Use this exact on-disk path for the keypair file instead of deriving one
     * from `id` (and `storeDir`). Takes precedence over `storeDir`; the parent
     * directory is created if missing.
     */
    readonly file?: string;
}

export interface PersistedIdentity {
    readonly principal: PrincipalId;
    readonly keypair: Keypair;
    /** Long-lived X25519 keypair used for HPKE wrap/unwrap. */
    readonly wrapKeypair: X25519Keypair;
    /** Absolute path of the on-disk file. */
    readonly file: string;
}

/**
 * Load the Ed25519 + X25519 keypairs for `id` from disk, or
 * generate-and-persist them on first call. The slot is keyed by SHA-256 of
 * `id` so callers can pass any stable string (e.g. `import.meta.filename`)
 * without worrying about filesystem-safe characters.
 *
 * Identity files written before wrapping support carried only the Ed25519
 * keypair; on load they are transparently migrated — the Ed25519 keypair
 * (and therefore the `nodeId`) is preserved and a fresh X25519 wrap keypair
 * is generated and written back.
 *
 * NOTE: keys are stored unencrypted. Only suitable for local development
 * identities — not for anything that must resist file-system attackers.
 */
export async function loadOrCreateIdentity(
    opts: LoadOrCreateIdentityOptions,
): Promise<PersistedIdentity> {
    const file = opts.file ??
        path.join(opts.storeDir ?? _defaultStoreDir(), `${_slotName(opts.id)}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(raw) as {
            privateKey?: string;
            publicKey?: string;
            wrapPrivateKey?: string;
            wrapPublicKey?: string;
        };
        if (typeof parsed.privateKey !== 'string' || typeof parsed.publicKey !== 'string') {
            throw new Error('malformed identity file');
        }
        const privateKey = base64UrlToBytes(parsed.privateKey);
        const publicKey = base64UrlToBytes(parsed.publicKey);
        const keypair: Keypair = { privateKey, publicKey };
        let wrapKeypair: X25519Keypair;
        if (typeof parsed.wrapPrivateKey === 'string' && typeof parsed.wrapPublicKey === 'string') {
            wrapKeypair = {
                privateKey: base64UrlToBytes(parsed.wrapPrivateKey),
                publicKey: base64UrlToBytes(parsed.wrapPublicKey),
            };
        } else {
            // Pre-wrapping identity file: keep the Ed25519 keypair (stable
            // principal) and add a fresh X25519 wrap keypair, written back.
            wrapKeypair = await crypto.generateX25519Keypair();
            await _writeIdentityFile(file, keypair, wrapKeypair, opts.id);
        }
        return { keypair, wrapKeypair, principal: principalForPublicKey(publicKey), file };
    } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw e;
    }
    const keypair = await crypto.generateKeypair();
    const wrapKeypair = await crypto.generateX25519Keypair();
    await _writeIdentityFile(file, keypair, wrapKeypair, opts.id);
    return { keypair, wrapKeypair, principal: principalForPublicKey(keypair.publicKey), file };
}

async function _writeIdentityFile(
    file: string,
    keypair: Keypair,
    wrapKeypair: X25519Keypair,
    id: string,
): Promise<void> {
    const payload = {
        privateKey: bytesToBase64Url(keypair.privateKey),
        publicKey: bytesToBase64Url(keypair.publicKey),
        wrapPrivateKey: bytesToBase64Url(wrapKeypair.privateKey),
        wrapPublicKey: bytesToBase64Url(wrapKeypair.publicKey),
        id,
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function _defaultStoreDir(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
        const appdata = process.env.APPDATA;
        if (appdata) return path.join(appdata, 'hubrpc', 'identities');
        return path.join(home, 'AppData', 'Roaming', 'hubrpc', 'identities');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'hubrpc', 'identities');
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return path.join(xdg, 'hubrpc', 'identities');
    return path.join(home, '.config', 'hubrpc', 'identities');
}

function _slotName(id: string): string {
    const digest = sha256(new TextEncoder().encode(id));
    let out = '';
    for (let i = 0; i < 16; i++) {
        out += digest[i].toString(16).padStart(2, '0');
    }
    return out;
}

// ---- Capability persistence ---------------------------------------------

/**
 * On-disk capability cache, keyed by `(identity slot, prefix)`. Lives next
 * to the identity files so the lifecycle is the same: lose the dir, get a
 * fresh prompt next time. Caps are not secret; the cache is read/write
 * mode 0o600 anyway for consistency.
 */
export interface PersistedRegisterCap {
    readonly capability: SignedCapability;
    /** Absolute path of the on-disk file. */
    readonly file: string;
}

export async function loadPersistedRegisterCap(args: {
    readonly identityId: string;
    readonly prefix: string;
    readonly storeDir?: string;
}): Promise<PersistedRegisterCap | undefined> {
    const file = _capFilePath(args.identityId, args.prefix, args.storeDir);
    try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(raw) as { capability?: SignedCapability; };
        if (!parsed.capability) return undefined;
        // Drop the cap if it expired so the caller re-acquires.
        if (
            parsed.capability.expiresAtMs !== undefined &&
            parsed.capability.expiresAtMs < Date.now()
        ) {
            return undefined;
        }
        return { capability: parsed.capability, file };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        return undefined;
    }
}

export async function persistRegisterCap(args: {
    readonly identityId: string;
    readonly prefix: string;
    readonly capability: SignedCapability;
    readonly storeDir?: string;
}): Promise<string> {
    const file = _capFilePath(args.identityId, args.prefix, args.storeDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
        file,
        JSON.stringify({ capability: args.capability }, null, 2),
        { mode: 0o600 },
    );
    return file;
}

function _capFilePath(
    identityId: string,
    prefix: string,
    storeDir: string | undefined,
): string {
    const dir = storeDir ?? _defaultStoreDir();
    const slot = _slotName(identityId);
    return path.join(dir, `${slot}-cap-${_slotName(prefix)}.json`);
}

function _openSocket(endpoint: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        const onError = (err: Error) => {
            socket.removeListener('connect', onConnect);
            reject(err);
        };
        const onConnect = () => {
            socket.removeListener('error', onError);
            resolve(socket);
        };
        socket.once('error', onError);
        socket.once('connect', onConnect);
    });
}
