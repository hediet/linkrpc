import type { LinkRpcConnection } from '../connection/linkRpcConnection';
import type { SignedCapability } from '../identity/capability';
import type { SigningCallCtx } from '../identity/signingSender';
import type { Keypair, PrincipalId } from '../crypto/cryptoProvider';
import { signParams } from '../identity/metaEnvelope';
import { KeypairSigningIdentity } from '../identity/identity';
import { ErrorCode } from '../protocol/jsonRpc';
import {
    connectToHub,
    type HubClientHandle,
    loadOrCreateIdentity,
    loadPersistedRegisterCap,
    persistRegisterCap,
    registerHubPrefix,
} from './hubClient';

export interface ServeOverHubIdentityOptions {
    /**
     * Stable slot id for the on-disk keypair. Typically the caller's
     * `import.meta.filename`. Same id always loads the same keypair, so
     * persistent capabilities keep working across runs.
     */
    readonly slot: string;

    /**
     * Override the on-disk identity / capability store directory (defaults
     * to a per-user folder, see `loadOrCreateIdentity`).
     */
    readonly storeDir?: string;
    /**
     * Override the form-3 method the helper uses to request a register
     * capability when the hub rejects an unsigned / un-capped register.
     * Defaults to
     * `hub-admin::hub-admin.capabilities::issueRegisterCap`. Setting this
     * to `null` disables the fallback (the helper just propagates the
     * `permissionRequired` error).
     */
    readonly issuerMethod?: string | null;
    /**
     * Optional human-friendly purpose string passed to the issuer service.
     * Surfaced in the user-facing approval prompt.
     */
    readonly purpose?: string;
}

export interface ServeOverHubOptions {
    /** Service prefix to register with the hub. */
    readonly prefix: string;
    /**
     * Wires handlers onto the connection (registers interfaces, enables
     * reflection, etc). Called once per successful connection attempt,
     * after the prefix has been registered. Must not retain references to
     * the connection across calls — a fresh connection is passed every
     * reconnect.
     */
    readonly setup: (connection: LinkRpcConnection<undefined, SigningCallCtx>) => void | Promise<void>;
    /**
     * Optional human-readable name used in log lines (defaults to `prefix`).
     */
    readonly name?: string;
    /** When set, prints connect/disconnect/retry lines to this sink. */
    readonly log?: ((line: string) => void) | true;
    /**
     * Initial retry delay in ms (capped doubling on each consecutive
     * failure). Defaults to 200 ms.
     */
    readonly initialBackoffMs?: number;
    /** Cap on backoff in ms. Defaults to 5000 ms. */
    readonly maxBackoffMs?: number;
    /**
     * Abort the loop. When the signal is aborted, the current handle is
     * closed and the loop exits. The returned promise resolves once the
     * loop has finished.
     */
    readonly signal?: AbortSignal;
    /**
     * When set, registration is performed against a secure-mode hub: the
     * caller's `$linkrpc`-signed `hubServiceIdRegistry::registerServiceId` carries a
     * presented capability. The first attempt loads any cached cap from
     * disk; on `permissionRequired` the helper calls the hub-admin issuer
     * service to obtain a fresh cap, persists it, and retries. Subsequent
     * reconnects reuse the cached cap. Omit to use the legacy unsigned
     * path (only works against an openMode hub).
     */
    readonly identity?: ServeOverHubIdentityOptions;
}

export interface ServeOverHubController {
    /** Stops the loop and closes the current handle, if any. */
    stop(): void;
    /**
     * Resolves when the loop exits (signal aborted or `stop()` called).
     * Rejects only on programmer errors thrown by `setup`.
     */
    readonly done: Promise<void>;
}

/**
 * Connect to the hub, register `prefix`, run `setup`, and keep the
 * connection alive across hub restarts. When the socket closes, retries
 * with exponential backoff (re-reading `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN`
 * from `process.env` on each attempt so rotated tokens published by the
 * hub host get picked up if the parent shell re-exports them).
 *
 * The hub keeps recently-rotated tokens accepted for a grace window, so
 * even processes that captured the env at spawn time can usually reconnect
 * after a host reload without the parent re-exporting anything.
 */
export function serveOverHubWithReconnect(
    options: ServeOverHubOptions,
): ServeOverHubController {
    const log = _makeLog(options.log, options.name ?? options.prefix);
    const initial = options.initialBackoffMs ?? 200;
    const max = options.maxBackoffMs ?? 5000;
    let stopped = false;
    let current: HubClientHandle | undefined;

    const stop = () => {
        if (stopped) return;
        stopped = true;
        current?.close();
        current = undefined;
    };
    options.signal?.addEventListener('abort', stop, { once: true });

    const claimer = options.identity ?
        createHubPrefixClaimer({ prefix: options.prefix, identity: options.identity, log }) :
        undefined;

    const done = (async () => {
        let attempt = 0;
        let backoff = initial;
        while (!stopped) {
            try {
                if (attempt > 0) log(`reconnecting (attempt ${attempt + 1})…`);
                const handle = await connectToHub();
                current = handle;
                if (claimer) {
                    await claimer.claim(handle);
                } else {
                    await registerHubPrefix({ handle, prefix: options.prefix });
                }
                await options.setup(handle.connection);
                log(
                    attempt === 0 ?
                        `connected to hub at ${handle.endpoint} (prefix "${options.prefix}")` :
                        `reconnected to hub (prefix "${options.prefix}")`,
                );
                attempt = 0;
                backoff = initial;
                await new Promise<void>((resolve) => {
                    handle.onClose(() => resolve());
                });
                if (stopped) break;
                log(`disconnected from hub`);
                current = undefined;
            } catch (err) {
                if (stopped) break;
                current?.close();
                current = undefined;
                const msg = err instanceof Error ? err.message : String(err);
                log(`connect failed: ${msg}; retrying in ${backoff} ms`);
                await _delay(backoff, options.signal);
                attempt++;
                backoff = Math.min(max, backoff * 2);
            }
        }
    })();

    return { stop, done };
}

export interface HubPrefixClaimerOptions {
    /** Service prefix to register with the hub. */
    readonly prefix: string;
    /** Identity + capability-issuance options (see {@link ServeOverHubIdentityOptions}). */
    readonly identity: ServeOverHubIdentityOptions;
    /** When set, prints register/capability lines to this sink. */
    readonly log?: (line: string) => void;
}

export interface HubPrefixClaimer {
    /**
     * Register the configured prefix on `handle`'s hub, performing the
     * `$linkrpc`-signed register plus capability dance: presents the cached
     * cap, and on `permissionRequired` mints a fresh one via the hub-admin
     * issuer, persists it, and retries. Call once per (re)connect, before
     * serving handlers. The loaded identity and cap are cached across calls.
     */
    claim(handle: HubClientHandle): Promise<void>;
}

/**
 * Build a reusable, stateful claimer for the signed register + capability
 * flow. Use this with {@link connectService}'s `reconnecting` connector to
 * claim a prefix on each (re)connect:
 *
 * ```ts
 * const claimer = createHubPrefixClaimer({ prefix, identity: { slot } });
 * connectService({
 *   connector: reconnecting(async () => {
 *     const handle = await connectToHub();
 *     try { await claimer.claim(handle); } catch (e) { handle.close(); throw e; }
 *     return handle;
 *   }),
 *   onConnect: ({ connection }) => registerService(connection),
 * });
 * ```
 */
export function createHubPrefixClaimer(opts: HubPrefixClaimerOptions): HubPrefixClaimer {
    const log = opts.log ?? (() => { });
    let identity: { principal: PrincipalId; keypair: Keypair; } | undefined;
    let cachedCap: SignedCapability | undefined;
    let capLoaded = false;
    return {
        async claim(handle) {
            if (!identity) {
                const loaded = await loadOrCreateIdentity({
                    id: opts.identity.slot,
                    ...(opts.identity.storeDir !== undefined ?
                        { storeDir: opts.identity.storeDir } :
                        {}),
                });
                identity = { principal: loaded.principal, keypair: loaded.keypair };
            }
            if (!capLoaded) {
                const persisted = await loadPersistedRegisterCap({
                    identityId: opts.identity.slot,
                    prefix: opts.prefix,
                    ...(opts.identity.storeDir !== undefined ?
                        { storeDir: opts.identity.storeDir } :
                        {}),
                });
                cachedCap = persisted?.capability;
                capLoaded = true;
            }
            cachedCap = await _registerSigned(
                handle,
                opts.prefix,
                identity,
                cachedCap,
                opts.identity,
                log,
            );
        },
    };
}

const DEFAULT_ISSUER_METHOD = 'hub-admin::hub-admin.capabilities::issueRegisterCap';

/**
 * Try `registerHubPrefix` with `cachedCap`. On `permissionRequired`, call
 * the hub-admin issuer to mint a fresh cap, persist it, retry. Returns the
 * cap that actually worked (caller stores it for the next reconnect).
 */
async function _registerSigned(
    handle: HubClientHandle,
    prefix: string,
    identity: { principal: PrincipalId; keypair: Keypair; },
    cachedCap: SignedCapability | undefined,
    identityOpts: ServeOverHubIdentityOptions,
    log: (line: string) => void,
): Promise<SignedCapability | undefined> {
    try {
        await registerHubPrefix({
            handle,
            prefix,
            identity,
            ...(cachedCap ? { capabilities: [cachedCap] } : {}),
        });
        return cachedCap;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!_isPermissionRequired(e) || identityOpts.issuerMethod === null) {
            throw e;
        }
        log(`register denied (${msg}); requesting capability from hub-admin issuer…`);
    }

    const issuerMethod = identityOpts.issuerMethod ?? DEFAULT_ISSUER_METHOD;
    const signer = new KeypairSigningIdentity(
        identity.principal,
        identity.keypair.privateKey,
    );
    const signedIssueParams = await signParams({
        method: issuerMethod,
        params: {
            audience: identity.principal,
            prefix,
            ...(identityOpts.purpose !== undefined ? { purpose: identityOpts.purpose } : {}),
        },
        signingIdentity: signer,
    });
    const issueRespRaw = await handle.connection.channel.sendRequest(
        issuerMethod,
        signedIssueParams,
    );
    const issueResp = issueRespRaw as unknown as { capability?: SignedCapability; };
    if (!issueResp?.capability) {
        throw new Error('hub-admin issuer returned no capability');
    }
    const fresh = issueResp.capability;
    await persistRegisterCap({
        identityId: identityOpts.slot,
        prefix,
        capability: fresh,
        ...(identityOpts.storeDir !== undefined ? { storeDir: identityOpts.storeDir } : {}),
    });

    await registerHubPrefix({
        handle,
        prefix,
        identity,
        capabilities: [fresh],
    });
    return fresh;
}

function _isPermissionRequired(e: unknown): boolean {
    if (e === null || typeof e !== 'object') return false;
    const rec = e as { code?: unknown; };
    if (typeof rec.code === 'number') return rec.code === ErrorCode.permissionRequired;
    const msg = (e as Error).message ?? '';
    return /permission required/i.test(msg);
}

function _makeLog(
    sink: ((line: string) => void) | true | undefined,
    name: string,
): (line: string) => void {
    if (!sink) return () => { };
    const write = sink === true ?
        (line: string) => {
            process.stderr.write(line + '\n');
        } :
        sink;
    return (line) => write(`[linkrpc:${name}] ${line}`);
}

function _delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
