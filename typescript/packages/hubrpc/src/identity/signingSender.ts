import type { SignedCapability } from './capability';
import { bytesToBase64Url, type PrincipalId } from '../crypto/cryptoProvider';
import { attachCapabilities, signRpcCall } from './signedRpcEnvelope';
import type { SigningIdentity } from './identity';
import { Principal } from './principal';
import type { JsonValue } from '../protocol/jsonRpc';
import {
    Channel,
    isInspectionCall,
    markInspectionCall,
    type IRequestSender,
    type RawStreamingCall,
    type SendOpts,
    type StreamSendOpts,
} from '../connection/channel';
import type { IMessageTransport } from '../transport/messageTransport';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import { createManagedPrincipal, type PrincipalWithStore } from './managedPrincipal';

/**
 * Per-outbound-call hook. Sees every signed call this sender makes,
 * and gets a chance to:
 *   - attach capabilities (the common case),
 *   - override `method` / `params` / `interfaceHash` (rewriting,
 *     auditing, schema-pinning),
 *   - advance `signedAtMs` (e.g. after a slow consent prompt that needs
 *     to issue a cap bound to a fresher timestamp than the sender's
 *     initial wall-clock).
 *
 * `signer` and `nonce` are NOT overridable. `signer` is the call's
 * identity; `nonce` ties any cap to this specific call attempt and must
 * not drift between the cap-issuance request and the call itself.
 */
export type CapProvider = (req: {
    readonly method: string;
    readonly params: JsonValue | undefined;
    readonly signer: PrincipalId;
    readonly nonce: string;
    readonly signedAtMs: number;
    readonly interfaceHash?: string;
}) => Promise<CapProviderResult>;

export interface CapProviderResult {
    readonly capabilities?: readonly SignedCapability[];
    /** Override the wire method this sender signs. Default: the original. */
    readonly method?: string;
    /** Override the params this sender signs. Default: the original. */
    readonly params?: JsonValue;
    /** Override the interfaceHash baked into the signed envelope. */
    readonly interfaceHash?: string;
    /** Advance the Unix-ms timestamp baked into the signed envelope. */
    readonly signedAtMs?: number;
}

interface BaseCallIntent {
    readonly method: string;
    readonly params: JsonValue | undefined;
    readonly interfaceHash?: string;
}

interface NegotiatedCallIntent {
    method: string;
    params: JsonValue | undefined;
    interfaceHash?: string;
    signedAtMs: number;
}

interface SigningCoordinates {
    readonly nonceBytes: Uint8Array;
    readonly nonce: string;
    readonly signedAtMs: number;
}

interface PreparedOutboundCall {
    readonly method: string;
    readonly params: JsonValue | undefined;
}

/**
 * Per-call ctx the {@link SigningSender} consumes. All fields are
 * optional; the sender's persistent {@link SigningSenderConfig.principal} is
 * the default.
 *
 * To install a signer after the sender is already constructed (e.g. a
 * managed-identity bootstrap), mutate the caller-owned config object — it is
 * read fresh on every call. No setter on the sender itself.
 */
export interface SigningCallCtx {
    /**
     * Override the signer for this call only. Pass `null` to skip
     * signing entirely (plain unsigned JSON-RPC). Bootstrap flows that
     * must talk to `identity::*` before a managed signer is available
     * use `signerOverride: null` for those calls.
     */
    readonly signerOverride?: SigningIdentity | null;
    /**
     * Replace whatever caps the persistent cap provider would attach.
     * Skips the persistent provider for this call.
     */
    readonly capsOverride?: readonly SignedCapability[];
    /**
     * Reserved for the perm-denied / consent retry path. Currently a
     * passthrough — sender does not act on it yet.
     */
    readonly requestPermissionWhenDenied?: boolean;
}

/**
 * Persistent config for a {@link SigningSender}.
 *
 * `principal` is the call identity plus its durable, extensible capability
 * set. `oneShotCaps` is an optional side-policy that may stage a single-use
 * capability onto the very next call without touching the principal. Both
 * fields are read fresh on every call, so callers may install or swap them
 * after the sender has been constructed.
 *
 * A missing `principal` means "no signing / no caps" for that call, unless
 * overridden via {@link SigningCallCtx}.
 */
export interface SigningSenderConfig {
    /** Identity + persistent (extensible) capabilities. */
    readonly principal?: Principal;
    /**
     * Optional per-call capability provider. Runs at sign-time with the
     * concrete method/params/nonce/timestamp and may return caps and/or
     * signing overrides.
     */
    readonly capProvider?: CapProvider;
    /**
     * Optional one-shot capability staging policy. Independent of the
     * principal; drained per outbound signed call.
     */
    readonly oneShotCaps?: OneShotCapStaging;
}

/**
 * A call identity bundled with its durable capability set — re-exported from
 * its own module so the `SigningSender` ⇄ managed-principal factory cycle never
 * runs through a top-level `class … extends Principal` (TDZ-safe).
 */
export { Principal };

/**
 * Side-policy for staging *one-shot* capabilities onto the next outbound
 * signed call, independent of any {@link Principal}. The {@link SigningSender}
 * drains the staged caps after attaching them once, so a spent cap never
 * leaks into a later call.
 *
 * Requesting the one-shot grant (prompting the user / hub) lives next to —
 * not inside — the principal: the principal owns identity and durable
 * capabilities; this owns the transient per-call grant.
 */
export class OneShotCapStaging {
    private _staged: readonly SignedCapability[] = [];

    /** Stage caps for the next signed call. Replaces any still-pending caps. */
    public stage(caps: readonly SignedCapability[]): void {
        this._staged = caps;
    }

    /**
     * Take (and clear) the staged caps. Called by {@link SigningSender} once
     * per outbound signed call.
     */
    public take(): readonly SignedCapability[] {
        const caps = this._staged;
        this._staged = [];
        return caps;
    }
}

/**
 * Outbound sender decorator that wraps every call in a `$hubrpc` signed
 * envelope and (optionally) attaches capabilities. Stateless w.r.t. signing
 * config — the {@link Principal} and {@link OneShotCapStaging} are resolved
 * per-call from {@link SigningSenderConfig}, so the caller can install or
 * swap them after construction by mutating that object.
 */
/**
 * The result of {@link SigningSender.fromChannelWithManagedPrincipal} /
 * {@link SigningSender.fromTransportWithManagedPrincipal}: a signing
 * {@link Channel} ready for `HubRpcConnection`, plus the executor-managed
 * {@link PrincipalWithStore} that drives it (caps, per-identity storage, nodeId).
 */
export interface ManagedSigningChannel<TInCtx = undefined> {
    readonly channel: Channel<TInCtx, SigningCallCtx>;
    readonly principal: PrincipalWithStore;
}

export class SigningSender<TInCtx = unknown> implements IRequestSender<SigningCallCtx> {
    /**
     * Wrap an inner channel with signing. Composes via {@link Channel.withSender}
     * so the resulting `Channel<TInCtx, SigningCallCtx>` plugs into
     * `HubRpcConnection`.
     */
    public static wrapChannel<TInCtx>(
        inner: Channel<TInCtx, unknown>,
        config: SigningSenderConfig,
    ): Channel<TInCtx, SigningCallCtx> {
        return inner.withSender((raw) => new SigningSender<TInCtx>(raw, config));
    }

    /**
     * Bootstrap an executor-managed {@link Principal} over the **unsigned**
     * `channel`, then wrap that same channel with signing driven by it.
     *
     * Crucially, the `identity::*` handshake that mints the managed principal
     * rides the *raw* channel (`channel.sender`), so those bootstrap calls are
     * themselves never signed — there is no "sign the sign call" recursion and
     * no reliance on threading `signerOverride: null` through every transport
     * layer. The returned signing {@link Channel} is what callers hand to
     * `HubRpcConnection`; the {@link PrincipalWithStore} is returned alongside
     * for caps / per-identity storage / nodeId.
     */
    public static async fromChannelWithManagedPrincipal<TInCtx>(
        channel: Channel<TInCtx, unknown>,
        config?: Omit<SigningSenderConfig, 'principal'>,
    ): Promise<ManagedSigningChannel<TInCtx>> {
        const principal = await createManagedPrincipal(channel.sender);
        const signing = SigningSender.wrapChannel(channel, { ...config, principal });
        return { channel: signing, principal };
    }

    /**
     * Convenience over {@link fromChannelWithManagedPrincipal}: build the
     * unsigned {@link JsonRpcChannel} from `transport` first. The common entry
     * point for app hosts / services that own a raw {@link IMessageTransport}.
     */
    public static fromTransportWithManagedPrincipal(
        transport: IMessageTransport,
        config?: Omit<SigningSenderConfig, 'principal'>,
    ): Promise<ManagedSigningChannel<undefined>> {
        return SigningSender.fromChannelWithManagedPrincipal(JsonRpcChannel.create(transport), config);
    }

    constructor(
        private readonly _inner: IRequestSender<unknown>,
        private readonly _config: SigningSenderConfig,
    ) { }

    public async sendRequest(method: string, params: JsonValue | undefined, opts?: SendOpts<SigningCallCtx>): Promise<JsonValue> {
        const out: PreparedOutboundCall = await this._prepareOutbound(method, params, opts);
        const innerOpts = inspectionOpts(opts);
        return this._inner.sendRequest(out.method, out.params, innerOpts);
    }

    public async sendNotification(
        method: string,
        params: JsonValue | undefined,
        opts?: SendOpts<SigningCallCtx>,
    ): Promise<void> {
        const out: PreparedOutboundCall = await this._prepareOutbound(method, params, opts);
        await this._inner.sendNotification(out.method, out.params, inspectionOpts(opts));
    }

    public sendRequestWithStream(
        method: string,
        params: JsonValue | undefined,
        opts?: StreamSendOpts<SigningCallCtx>,
    ): RawStreamingCall {
        const id$ = this._prepareOutbound(method, params, opts);
        // Result + stream send proxy. We can't allocate the wire id
        // synchronously when signing is async, so the inner call is
        // started after the sign completes. `requestId` is exposed as
        // a placeholder that flips to the real id once known; callers
        // who need synchronous correlation should not stream against a
        // signing sender, or should `await` the underlying inner call.
        let realCall: RawStreamingCall | undefined;
        let queuedSends: JsonValue[] | undefined = [];
        let resolveResult!: (v: JsonValue) => void;
        let rejectResult!: (e: Error) => void;
        const result = new Promise<JsonValue>((res, rej) => {
            resolveResult = res;
            rejectResult = rej;
        });
        let cancelled = false;
        let cancelReason: string | undefined;
        let disposedReason: string | undefined;
        id$.then((out) => {
            const inner = this._inner.sendRequestWithStream(out.method, out.params, opts);
            if (cancelled) {
                inner.cancel(cancelReason);
            }
            if (disposedReason !== undefined) {
                inner.dispose?.(disposedReason);
            }
            realCall = inner;
            inner.result.then(resolveResult, rejectResult);
            if (queuedSends && queuedSends.length > 0) {
                for (const p of queuedSends) void inner.send(p);
            }
            queuedSends = undefined;
        }, (err) => rejectResult(err instanceof Error ? err : new Error(String(err))));
        return {
            result,
            cancel: (reason) => {
                cancelled = true;
                cancelReason = reason;
                if (realCall) {
                    realCall.cancel(reason);
                }
            },
            dispose: (reason = 'streaming request disposed') => {
                if (disposedReason !== undefined) return;
                disposedReason = reason;
                queuedSends = undefined;
                if (realCall) {
                    realCall.dispose?.(reason);
                }
                rejectResult(new Error(reason));
            },
            send: async (payload) => {
                if (realCall) await realCall.send(payload);
                else queuedSends!.push(payload);
            },
            // The inner call (and its pinger) only exists after signing
            // completes; defer until then. Ordering: the `id$.then` that
            // assigns `realCall` is registered before this one, so it has
            // run by the time this continuation fires.
            ping: () => realCall ? realCall.ping() : id$.then(() => realCall!.ping()),
        };
    }

    public close(): void {
        this._inner.close();
    }

    private async _prepareOutbound(
        method: string,
        params: JsonValue | undefined,
        opts: SendOpts<SigningCallCtx> | undefined,
    ): Promise<PreparedOutboundCall> {
        const ctx = opts?.ctx;
        const signer = this._resolveSigner(ctx);
        if (signer === undefined) {
            return { method, params };
        }

        const baseIntent: BaseCallIntent = {
            method,
            params,
            ...(opts?.interfaceHash !== undefined ? { interfaceHash: opts.interfaceHash } : {}),
        };
        const coords = this._createSigningCoordinates();
        const { intent, capabilities } = await this._resolveIntentAndCapabilities(baseIntent, signer, coords, ctx);
        return this._signPreparedCall(intent, signer, coords.nonceBytes, capabilities);
    }

    // Per-call override beats persistent principal. `null` means explicit unsigned call.
    private _resolveSigner(ctx: SigningCallCtx | undefined): SigningIdentity | undefined {
        return ctx?.signerOverride === null
            ? undefined
            : ctx?.signerOverride ?? this._config.principal?.identity;
    }

    private _createSigningCoordinates(): SigningCoordinates {
        const nonceBytes = _randomNonceBytes();
        return {
            nonceBytes,
            nonce: bytesToBase64Url(nonceBytes),
            signedAtMs: Date.now(),
        };
    }

    private async _resolveIntentAndCapabilities(
        baseIntent: BaseCallIntent,
        signer: SigningIdentity,
        coords: SigningCoordinates,
        ctx: SigningCallCtx | undefined,
    ): Promise<{
        intent: NegotiatedCallIntent;
        capabilities: readonly SignedCapability[];
    }> {
        const intent: NegotiatedCallIntent = {
            method: baseIntent.method,
            params: baseIntent.params,
            ...(baseIntent.interfaceHash !== undefined ? { interfaceHash: baseIntent.interfaceHash } : {}),
            signedAtMs: coords.signedAtMs,
        };

        // Resolve the caps to attach. A per-call override wins outright;
        // otherwise take the principal's persistent caps and append any
        // one-shot caps the side-policy has staged for this call.
        let capabilities: readonly SignedCapability[];
        if (ctx?.capsOverride !== undefined) {
            capabilities = ctx.capsOverride;
        } else {
            const persistent = this._config.principal?.capBag.capabilities ?? [];
            const oneShot = this._config.oneShotCaps?.take() ?? [];
            capabilities = oneShot.length > 0 ? [...persistent, ...oneShot] : persistent;

            const provider = this._config.capProvider;
            if (provider) {
                const provided = await provider({
                    method: intent.method,
                    params: intent.params,
                    signer: signer.publicSigningIdentity.principal,
                    nonce: coords.nonce,
                    signedAtMs: intent.signedAtMs,
                    ...(intent.interfaceHash !== undefined ? { interfaceHash: intent.interfaceHash } : {}),
                });
                if (provided.method !== undefined) intent.method = provided.method;
                if (provided.params !== undefined) intent.params = provided.params;
                if (provided.interfaceHash !== undefined) intent.interfaceHash = provided.interfaceHash;
                if (provided.signedAtMs !== undefined) intent.signedAtMs = provided.signedAtMs;
                if (provided.capabilities !== undefined) capabilities = provided.capabilities;
            }
        }

        return { intent, capabilities };
    }

    private async _signPreparedCall(
        intent: NegotiatedCallIntent,
        signer: SigningIdentity,
        nonceBytes: Uint8Array,
        capabilities: readonly SignedCapability[],
    ): Promise<PreparedOutboundCall> {
        const signed = await signRpcCall({
            method: intent.method,
            params: intent.params,
            signingIdentity: signer,
            nonce: nonceBytes,
            nowMs: intent.signedAtMs,
            ...(intent.interfaceHash !== undefined ? { interfaceHash: intent.interfaceHash } : {}),
        });
        const outboundParams = capabilities.length > 0 ?
            attachCapabilities(signed.wireParams, capabilities) :
            signed.wireParams;
        return { method: intent.method, params: outboundParams as unknown as JsonValue };
    }
}

function inspectionOpts(
    opts: SendOpts<SigningCallCtx> | undefined,
): SendOpts<unknown> | undefined {
    return isInspectionCall(opts) ? markInspectionCall({}) : undefined;
}

function _randomNonceBytes(): Uint8Array {
    const out = new Uint8Array(16);
    crypto.getRandomValues(out);
    return out;
}
