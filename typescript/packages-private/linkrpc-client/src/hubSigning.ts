import {
    type CapProvider,
    type CapProviderResult,
    type CallTarget,
    permissionMatchesTarget,
    capabilityFreshAt,
    type IRequestSender,
    type Principal,
    type SignedCapability,
    type SigningCallCtx,
} from '@hediet/linkrpc';
import {
    type HubAccessDuration,
    type HubAccessRequest,
    type HubAccessResult,
} from '@hediet/linkrpc/hub/common';
import { hubAccessInterface } from '@hediet/linkrpc/hub/common';
import type { CliSigning } from './connect';
import { type PrincipalSource, type PrincipalSpec, resolvePrincipal } from './principal';

/** How long before expiry to refresh a capability (2 seconds = transit + skew). */
const CAP_FRESHNESS_MARGIN_MS = 2000;

/**
 * The reflection interfaces the CLI walks for `ls` / `schema` / `defaults`
 * / the TUI bus walk. We request all of them, across every service, in a
 * single up-front consent prompt so exploration doesn't re-prompt per
 * service id. See {@link requestReflectionAccess}.
 */
const REFLECTION_INTERFACE_IDS = [
    'linkrpc.directory',
    'linkrpc.schemas',
    'linkrpc.defaults',
] as const;
const TOPOLOGY_INTERFACE_ID = 'linkrpc.topology';

type HubCapProviderResult = Pick<CapProviderResult, 'capabilities' | 'interfaceHash' | 'signedAtMs'>;

export interface SigningSession {
    /** The identity installed on the channel for this session. */
    readonly principal: Principal;
    /** Which identity actually ended up signing (managed vs. local, etc.). */
    readonly principalSource: PrincipalSource;
    /**
     * The resolved wire method for `hubAccess::requestAccess` on this endpoint
     * (form-3 `<hubServiceId>::hubAccess::requestAccess` for hub endpoints, or
     * the form-2 fallback otherwise).
     */
    readonly hubAccessMethod: string;
    /**
     * Snapshot of the durable capabilities this connection currently holds —
     * the bootstrapped `hubAccess` cap plus anything granted via
     * {@link requestAccess}.
     */
    listGrants(): readonly SignedCapability[];
    /**
     * Explicitly request one or more capabilities from the hub in a single
     * consent prompt. Any durable (non-one-shot) caps the hub mints are added
     * to the connection's cap bag so subsequent calls present them
     * automatically. Use this instead of relying on per-call auto-negotiation.
     */
    requestAccess(req: HubAccessRequest): Promise<HubAccessResult>;
}

/**
 * Install signing on `signing` for any endpoint. Resolves the
 * {@link PrincipalSpec} into a concrete {@link Principal} (managed-with-
 * fallback, a user slot, or a file-backed keypair) and points the channel's
 * `SigningSender` at it so every outbound call is signed.
 *
 * When `negotiateHubCaps` is set (hub endpoints), it also ensures a persistent
 * `hubAccess` capability is cached on the principal's {@link CapBag} — requesting
 * one with a single signed round-trip on first run / cache miss. For hub
 * endpoints, it also installs a sign-time capability provider.
 *
 * By default (`autoNegotiatePerCall !== false`) that provider negotiates
 * per-call authority lazily using `callIntent` (method + params + nonce +
 * signedAtMs + optional interfaceHash), so one-shot grants can be pinned to the
 * exact call bytes being signed. Set `autoNegotiatePerCall: false` to disable
 * that: the provider then only presents caps already in the bag, and the caller
 * is expected to request access explicitly via
 * {@link SigningSession.requestAccess}.
 */
export async function setupSigning(
    channel: IRequestSender<SigningCallCtx>,
    signing: CliSigning,
    principalSpec: PrincipalSpec,
    opts: { negotiateHubCaps: boolean; autoNegotiatePerCall?: boolean; },
): Promise<SigningSession> {
    const { principal, source: principalSource } = await resolvePrincipal(principalSpec, channel);

    signing.principal = principal;
    signing.oneShotCaps = undefined;
    signing.capProvider = undefined;

    // The hub serves `hubAccess::*` at the connection root (root form, never
    // forwarded → never gated), so the wire address is simply
    // `hubAccess::requestAccess`. No prefix discovery or bootstrap cap is
    // needed to reach the consent front door.
    const hubAccessMethod = `${hubAccessInterface.info.id}::requestAccess`;
    const consumerPrincipalId = principal.id;

    if (opts.negotiateHubCaps) {
        let inAccessNegotiation = false;
        const provider: CapProvider = async ({ method, params, nonce, signedAtMs, interfaceHash }) => {
            let presentCaps = principal.capBag.capabilities;
            // Drop any cached cap that is expired (or expiring within the
            // safety margin) at this call's sign time. Without this, a stale
            // persisted cap from a previous session would be presented and the
            // gate would reject the call with `expired`. Filtering per-cap (not
            // whole-bag) keeps still-valid caps such as the `hubAccess` grant.
            presentCaps = presentCaps.filter((c) =>
                capabilityFreshAt(c, signedAtMs, CAP_FRESHNESS_MARGIN_MS),
            );
            const present: HubCapProviderResult = presentCaps.length > 0 ? { capabilities: presentCaps } : {};
            if (inAccessNegotiation) return {} satisfies HubCapProviderResult;

            const call = _wireMethodToCall(method);
            if (!call) return present;
            if (call.serviceId === '' || call.interfaceId === hubAccessInterface.info.id) return present;
            if (_capBagCovers(presentCaps, call)) return present;

            // Per-call auto-negotiation is opt-out. When disabled, never trigger
            // a `requestAccess` round-trip behind a call — just present whatever
            // is already in the bag and let the call surface `permissionRequired`
            // if it is gated. The consumer is expected to call
            // `SigningSession.requestAccess` ahead of time.
            if (opts.autoNegotiatePerCall === false) return present;

            inAccessNegotiation = true;
            try {
                const granted = await _requestAccessForCall(channel, hubAccessMethod, consumerPrincipalId, {
                    call,
                    method,
                    params,
                    nonce,
                    signedAtMs,
                    interfaceHash,
                });

                if (granted.length === 0) return present;

                const oneShot = granted.filter(_isOneShotCap);
                const persistent = granted.filter((c) => !_isOneShotCap(c));
                if (persistent.length > 0) await principal.capBag.add(...persistent);

                // Re-read the bag and again drop any stale caps so a freshly
                // attached one-shot is never paired with an expired durable cap.
                const durable = principal.capBag.capabilities.filter((c) =>
                    capabilityFreshAt(c, signedAtMs, CAP_FRESHNESS_MARGIN_MS),
                );
                if (oneShot.length > 0) {
                    return { capabilities: [...durable, ...oneShot] };
                }
                return durable.length > 0
                    ? { capabilities: durable }
                    : ({} satisfies HubCapProviderResult);
            } catch (err) {
                process.stderr.write(
                    `linkrpc: capability negotiation skipped (${(err as Error).message})\n`,
                );
                return present;
            } finally {
                inAccessNegotiation = false;
            }
        };
        signing.capProvider = provider;
    }

    return {
        principal,
        principalSource,
        hubAccessMethod,
        listGrants: () => principal.capBag.capabilities,
        requestAccess: (req) => _sessionRequestAccess(channel, hubAccessMethod, principal, req),
    };
}

/**
 * Up-front, explicit batched request for reflection access across *every*
 * service: `linkrpc.directory` / `linkrpc.schemas` / `linkrpc.defaults` with a
 * wildcard `serviceId` (`{ prefix: '' }`). One consent prompt covers the whole
 * bus, so `ls` / `schema` / `defaults` / the TUI walk stop re-prompting per
 * service id.
 *
 * Best-effort and fail-soft: a `denied` decision (or an open hub with no access
 * handler that rejects the call) is swallowed. Per-call auto-cap negotiation in
 * {@link setupSigning} then remains the fallback for individual gated calls.
 *
 * Returns the granted status so callers can log it; never throws.
 */
export async function requestReflectionAccess(
    session: SigningSession,
    opts: { duration?: HubAccessDuration } = {},
): Promise<'granted' | 'denied' | 'skipped'> {
    if (REFLECTION_INTERFACE_IDS.every((interfaceId) =>
        _hasInterfaceAccess(session, interfaceId, { prefix: '' })
    )) return 'granted';
    try {
        const result = await session.requestAccess({
            consumer: {
                name: 'linkrpc-cli',
                purpose: 'Reflect on every service exposed by the hub (ls / schema / defaults).',
            },
            permissions: REFLECTION_INTERFACE_IDS.map((id) => ({
                target: {
                    serviceId: { prefix: '' },
                    interfaceId: { exact: id },
                    members: [{ prefix: '' }],
                },
                canInvoke: true,
            })),
            duration: opts.duration ?? 'persistent',
        });
        return result.status === 'granted' ? 'granted' : 'denied';
    } catch {
        // Open hub / no access handler / unreachable consent door: fall back to
        // per-call auto-cap negotiation.
        return 'skipped';
    }

}

/**
 * Request topology access in one consent operation before fan-out begins.
 * Discovery mode needs both directory traversal and topology calls across the
 * bus; fixed-source mode requests topology only for those exact service ids.
 */
export async function requestTopologyAccess(
    session: SigningSession,
    opts: {
        readonly sourceServiceIds?: readonly string[];
        readonly duration?: HubAccessDuration;
    } = {},
): Promise<'granted' | 'denied' | 'skipped'> {
    const sourceServiceIds = opts.sourceServiceIds === undefined
        ? undefined
        : [...new Set(opts.sourceServiceIds)].sort();
    const targets = sourceServiceIds === undefined
        ? [{ prefix: '' } as const]
        : sourceServiceIds.map((serviceId) => ({ exact: serviceId } as const));
    const needsDirectory = sourceServiceIds === undefined;
    const alreadyGranted = (!needsDirectory
        || _hasInterfaceAccess(session, 'linkrpc.directory', { prefix: '' }))
        && targets.every((target) =>
            _hasInterfaceAccess(session, TOPOLOGY_INTERFACE_ID, target));
    if (alreadyGranted) return 'granted';

    const permissions: Array<HubAccessRequest['permissions'][number]> = [];
    if (needsDirectory) {
        permissions.push({
            target: {
                serviceId: { prefix: '' },
                interfaceId: { exact: 'linkrpc.directory' },
                members: [{ prefix: '' }],
            },
            canInvoke: true,
        });
    }
    for (const serviceId of targets) {
        permissions.push({
            target: {
                serviceId,
                interfaceId: { exact: TOPOLOGY_INTERFACE_ID },
                members: [{ prefix: '' }],
            },
            canInvoke: true,
        });
    }

    try {
        const result = await session.requestAccess({
            consumer: {
                name: 'linkrpc-cli',
                purpose: sourceServiceIds === undefined
                    ? 'Discover and inspect the topology exposed by every service on the hub.'
                    : 'Inspect topology for the selected services.',
            },
            permissions,
            duration: opts.duration ?? 'persistent',
        });
        return result.status === 'granted' ? 'granted' : 'denied';
    } catch {
        return 'skipped';
    }
}

function _hasInterfaceAccess(
    session: SigningSession,
    interfaceId: string,
    requestedServiceId: { readonly exact: string } | { readonly prefix: '' },
): boolean {
    const now = Date.now();
    return session.listGrants().some((capability) =>
        capability.audience === session.principal.id
        && capabilityFreshAt(capability, now, CAP_FRESHNESS_MARGIN_MS)
        && capability.permissions.some((permission) => {
            if (
                permission.canInvoke !== true
                || permission.callBind !== undefined
                || permission.params !== undefined
                || permission.target.interfaceHash !== undefined
                || !permission.target.members.some((member) =>
                    'prefix' in member && member.prefix === '')
            ) {
                return false;
            }
            if ('prefix' in requestedServiceId) {
                const grantedServiceId = permission.target.serviceId;
                return 'prefix' in grantedServiceId
                    && grantedServiceId.prefix === ''
                    && permissionMatchesTarget(
                        { serviceId: '', interfaceId, member: '' },
                        permission,
                    );
            }
            return permissionMatchesTarget(
                { serviceId: requestedServiceId.exact, interfaceId, member: '' },
                permission,
            );
        })
    );
}

/** Parse a wire method into a {@link CallTarget}, or `undefined` for form-1/2. */
function _wireMethodToCall(wireMethod: string): CallTarget | undefined {
    const parts = wireMethod.split('::');
    if (parts.length !== 3) return undefined;
    const [serviceId, interfaceId, member] = parts;
    return { serviceId, interfaceId, member };
}

/** A cap is one-shot when any permission is pinned to a single call via `callBind`. */
function _isOneShotCap(sc: SignedCapability): boolean {
    return sc.permissions.some((p) => p.callBind !== undefined);
}

/** True when a durable (non-one-shot) cap in the bag authorises `target`. */
function _capBagCovers(caps: readonly SignedCapability[], target: CallTarget): boolean {
    return caps.some((sc) => !_isOneShotCap(sc) && sc.permissions.some((p) => permissionMatchesTarget(target, p)));
}

interface AccessCallRequest {
    readonly call: CallTarget;
    readonly method: string;
    readonly params: unknown;
    readonly nonce: string;
    readonly signedAtMs: number;
    readonly interfaceHash?: string;
}

async function _requestAccessForCall(
    channel: IRequestSender<SigningCallCtx>,
    hubAccessMethod: string,
    consumerPrincipalId: string,
    req: AccessCallRequest,
): Promise<SignedCapability[]> {
    const result = await _sendRequestAccess(channel, hubAccessMethod, {
        consumer: {
            name: 'linkrpc-cli',
            principal: consumerPrincipalId,
            purpose: `Invoke ${req.method}.`,
        },
        permissions: [{
            target: {
                serviceId: { exact: req.call.serviceId },
                interfaceId: { exact: req.call.interfaceId },
                members: [{ exact: req.call.member }],
            },
            canInvoke: true,
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
        // only nudges the default selection. The user's choice decides whether
        // the granted cap is one-shot or durable.
        duration: 'once',
    });
    if (result.status !== 'granted') return [];
    return result.capabilities ?? [];
}

async function _sendRequestAccess(
    channel: IRequestSender<SigningCallCtx>,
    hubAccessMethod: string,
    params: unknown,
): Promise<{ status: string; capabilities?: SignedCapability[]; reason?: string; }> {
    const raw = await _awaitWithApprovalNotice(channel.sendRequest(hubAccessMethod, params as never));
    return raw as unknown as {
        status: string;
        capabilities?: SignedCapability[];
        reason?: string;
    };
}

/** Delay before we tell the user an access request is parked awaiting approval. */
const APPROVAL_NOTICE_DELAY_MS = 750;

/**
 * Await a `hubAccess::requestAccess` round-trip, printing a one-line hint to
 * stderr if it doesn't resolve quickly. Access requests park at the hub until a
 * human approver (admin) decides them, so without this notice the CLI looks
 * hung — it blocks with no output until approval. Fast requests (auto-approved
 * / open hub) stay silent because the notice only fires after
 * {@link APPROVAL_NOTICE_DELAY_MS}.
 */
async function _awaitWithApprovalNotice<T>(pending: Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
        process.stderr.write(
            'linkrpc: access request sent — waiting for the hub admin to approve it...\n',
        );
    }, APPROVAL_NOTICE_DELAY_MS);
    timer.unref?.();
    try {
        return await pending;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Backs {@link SigningSession.requestAccess}. Sends a batched
 * `hubAccess::requestAccess`, then adds any durable (non-one-shot) caps the hub
 * minted to the principal's cap bag so later calls present them automatically.
 */
async function _sessionRequestAccess(
    channel: IRequestSender<SigningCallCtx>,
    hubAccessMethod: string,
    principal: Principal,
    req: HubAccessRequest,
): Promise<HubAccessResult> {
    const result = await _sendRequestAccess(channel, hubAccessMethod, {
        consumer: { ...req.consumer, principal: principal.id },
        permissions: req.permissions,
        ...(req.duration !== undefined ? { duration: req.duration } : {}),
    });
    if (result.status === 'granted') {
        const capabilities = result.capabilities ?? [];
        const durable = capabilities.filter((c) => !_isOneShotCap(c));
        if (durable.length > 0) await principal.capBag.add(...durable);
        return { status: 'granted', capabilities, addedDurable: durable.length };
    }
    return { status: result.status, reason: result.reason };
}
