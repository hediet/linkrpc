import type {
    CapProvider,
    CapProviderResult,
    CallTarget,
    Channel,
    IRequestSender,
    ManagedSigningChannel,
    Principal,
    SignedCapability,
    SigningCallCtx,
    SigningSenderConfig,
} from '../../index';
import {
    capabilityFreshAt,
    createManagedPrincipal,
    matchParams,
    methodNameToTarget,
    permissionMatchesTarget,
    SigningSender,
} from '../../index';
import { hubAccessInterface } from './hub.interfaces';

/** How long before expiry a cap is considered stale (transit + clock skew). */
const CAP_FRESHNESS_MARGIN_MS = 2000;

/** Who is asking — surfaced in the hub's consent prompt. */
export interface AutoNegotiateConsumer {
    readonly name: string;
    readonly origin?: string;
    readonly purpose?: string;
}

/** Options for {@link createManagedSigningChannel}. */
export interface ManagedSigningOptions {
    /**
     * When set, install a sign-time {@link CapProvider} that lazily negotiates
     * the capability each gated call needs through the hub's `hubAccess`
     * consent front door. Durable grants are absorbed into the principal's cap
     * bag so later calls present them automatically; one-shot grants are
     * attached to just the call that prompted them.
     *
     * Without it, the channel signs every call but presents no capabilities —
     * gated calls then fail with `permissionRequired` unless the caller has
     * arranged a capability some other way.
     */
    readonly autoNegotiateCaps?: boolean;
    /** Consumer identity shown in the consent prompt. */
    readonly consumer?: AutoNegotiateConsumer;
}

/**
 * Build a managed-identity signing {@link Channel} from a raw channel, with
 * optional per-call capability auto-negotiation.
 *
 * Like {@link SigningSender.fromChannelWithManagedPrincipal}, the
 * `identity::*` bootstrap rides the raw (unsigned) sender, and the returned
 * signing channel is what callers hand to `HubRpcConnection`. When
 * {@link ManagedSigningOptions.autoNegotiateCaps} is set, the returned
 * channel additionally negotiates capabilities on demand — the browser-safe
 * equivalent of the CLI's `setupSigning({ autoNegotiatePerCall: true })`.
 */
export async function createManagedSigningChannel(
    channel: Channel<undefined>,
    opts?: ManagedSigningOptions,
): Promise<ManagedSigningChannel<undefined>> {
    const principal = await createManagedPrincipal(channel.sender);

    // Mutable config: the SigningSender reads its fields fresh per call, so we
    // can install the cap provider *after* the signing sender exists (the
    // provider needs to issue its `hubAccess` calls through that same signed
    // sender).
    const config: { principal: Principal; capProvider?: CapProvider } = { principal };
    const signing = SigningSender.wrapChannel(channel, config as SigningSenderConfig);

    if (opts?.autoNegotiateCaps) {
        config.capProvider = createAutoNegotiatingCapProvider({
            sender: signing.sender,
            principal,
            consumer: opts.consumer ?? { name: 'hubrpc client' },
        });
    }

    return { channel: signing, principal };
}

/**
 * A sign-time {@link CapProvider} that negotiates access per gated call.
 *
 * For each outbound call it: presents any fresh caps already in the bag; if
 * none cover the call, bootstraps the root `hubAccess` capability (once), then
 * asks `hubAccess::requestAccess` for a grant scoped to exactly this call
 * (`callIntent` pinned to the method/params/nonce). Durable grants are added to
 * the bag; a one-shot grant is attached to just this call.
 *
 * Fail-soft: any negotiation error (open hub, denied consent, unreachable front
 * door) falls back to presenting the current bag, letting the call surface
 * `permissionRequired` if it is truly gated.
 */
export function createAutoNegotiatingCapProvider(opts: {
    readonly sender: IRequestSender<SigningCallCtx>;
    readonly principal: Principal;
    readonly consumer: AutoNegotiateConsumer;
}): CapProvider {
    const { sender, principal, consumer } = opts;
    let inAccessNegotiation = false;

    // `hubAccess` is served at the connection root (never forwarded, never
    // gated), so it is addressed in root form with no serviceId prefix and no
    // bootstrap capability.
    const hubAccessMethod = `${hubAccessInterface.info.id}::requestAccess`;

    return async ({ method, params, nonce, signedAtMs, interfaceHash }) => {
        const fresh = principal.capBag.capabilities.filter((c) =>
            capabilityFreshAt(c, signedAtMs, CAP_FRESHNESS_MARGIN_MS),
        );
        const present: CapProviderResult = fresh.length > 0 ? { capabilities: fresh } : {};

        // Reentrancy guard: the `hubAccess` calls this provider issues are
        // themselves signed through the same sender, which re-enters here.
        // Present only what is in the bag for those.
        if (inAccessNegotiation) return present;

        let call: CallTarget;
        try {
            call = {
                ...methodNameToTarget(method),
                ...(interfaceHash !== undefined ? { interfaceHash } : {}),
            };
        } catch {
            return present;
        }
        // Never negotiate for the root or the hub's own consent front door.
        if (call.serviceId === '' || call.interfaceId === hubAccessInterface.info.id) {
            return present;
        }
        if (capBagCovers(fresh, call, params)) return present;

        inAccessNegotiation = true;
        try {
            const granted = await requestAccessForCall(sender, hubAccessMethod, {
                ...consumer,
                principal: principal.id,
            }, {
                call,
                method,
                params,
                nonce,
                signedAtMs,
                interfaceHash,
            });
            if (granted.length === 0) return present;

            const oneShot = granted.filter(isOneShotCap);
            const persistent = granted.filter((c) => !isOneShotCap(c));
            if (persistent.length > 0) await principal.capBag.add(...persistent);

            const durable = principal.capBag.capabilities.filter((c) =>
                capabilityFreshAt(c, signedAtMs, CAP_FRESHNESS_MARGIN_MS),
            );
            if (oneShot.length > 0) return { capabilities: [...durable, ...oneShot] };
            return durable.length > 0 ? { capabilities: durable } : {};
        } catch {
            return present;
        } finally {
            inAccessNegotiation = false;
        }
    };
}

/** A cap is one-shot when any permission pins it to a single call via `callBind`. */
function isOneShotCap(sc: SignedCapability): boolean {
    return sc.permissions.some((p) => p.callBind !== undefined);
}

/** True when a durable (non-one-shot) cap in the bag authorises this call. */
function capBagCovers(caps: readonly SignedCapability[], target: CallTarget, params: unknown): boolean {
    return caps.some((sc) =>
        !isOneShotCap(sc) &&
        sc.permissions.some((p) =>
            permissionMatchesTarget(target, p) &&
            (p.params === undefined || matchParams(p.params, params).ok),
        ),
    );
}

interface AccessCallRequest {
    readonly call: CallTarget;
    readonly method: string;
    readonly params: unknown;
    readonly nonce: string;
    readonly signedAtMs: number;
    readonly interfaceHash?: string;
}

async function requestAccessForCall(
    sender: IRequestSender<SigningCallCtx>,
    hubAccessMethod: string,
    consumer: AutoNegotiateConsumer & { readonly principal: string },
    req: AccessCallRequest,
): Promise<SignedCapability[]> {
    const raw = await sender.sendRequest(hubAccessMethod, {
        consumer: { ...consumer, purpose: consumer.purpose ?? `Invoke ${req.method}.` },
        permissions: [{
            target: {
                serviceId: { exact: req.call.serviceId },
                interfaceId: { exact: req.call.interfaceId },
                members: [{ exact: req.call.member }],
            },
            canInvoke: true,
            params: exactParamMatchers(req.params),
            callIntent: {
                method: req.method,
                params: req.params,
                nonce: req.nonce,
                signedAtMs: req.signedAtMs,
                ...(req.interfaceHash !== undefined ? { interfaceHash: req.interfaceHash } : {}),
                suggestion: 'once' as const,
            },
        }],
        // The hub mints both a once and an always proposal regardless; this
        // only nudges the default. The user's choice decides one-shot vs durable.
        duration: 'once',
    } as never);
    const result = raw as unknown as { status: string; capabilities?: SignedCapability[] };
    if (result.status !== 'granted') return [];
    return result.capabilities ?? [];
}

function exactParamMatchers(params: unknown): Record<string, { exact: unknown }> {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return {};
    return Object.fromEntries(
        Object.entries(params as Record<string, unknown>).map(([key, value]) => [key, { exact: value }]),
    );
}
