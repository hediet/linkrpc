/**
 * The v2 consent host: serves `hubAccess::{request,extend,requestAccess}` at the
 * **connection root** of a participant's overlay (root form, no serviceId
 * prefix). The root is never forwarded, so the consent front door is reached
 * directly and needs no capability of its own.
 *
 * In v1 this lived inside the hub core (`hub.ts:_handleAccessRequest` &c.) with
 * the hub signing capabilities itself. In v2 the hub is identity-free, so the
 * consent engine is layered on top:
 *
 * - **identity**: the consumer's PrincipalId is taken **directly from
 *   `params.consumer.principal`** (no longer derived from a verified call signer).
 *   That PrincipalId becomes the capability `audience`. A cap minted for a nodeId is
 *   only usable by the holder of that node's key (enforced at call time by
 *   `permits`, which checks `audience === call.signer`).
 * - **candidate resolution**: done outside the hub against the directory
 *   interface object via {@link resolveAccessCandidates} + an injected
 *   {@link RegisterHubAccessOptions.fetchDirectory}.
 * - **consent + issuance**: delegated to injected {@link HubAccessHandlers}.
 *   The host owns the wire shape and candidate plumbing; the handler owns the
 *   UI, the policy and the {@link mintCapability} calls.
 *
 * The result shapes match {@link hubAccessInterface} byte-for-byte so existing
 * consumers (web-editors) keep working.
 */

import {
    type PrincipalId,
    type Pattern,
    type Permission,
    type SignedCapability,
    type HubRpcConnection,
} from '@vscode/hubrpc';
import { hubAccessInterface } from '@vscode/hubrpc/hub/common';
import {
    resolveAccessCandidates,
    type AccessSlotRequest,
    type DirectoryEntry,
    type ResolvedAccessSlot,
} from './accessCandidates';
import type { AccessDurationName } from './capabilityProposal';

// ---- handler-facing types -----------------------------------------------

export interface AccessConsumer {
    readonly name: string;
    readonly origin?: string;
    readonly purpose?: string;
}

export type AccessDuration = AccessDurationName;

export interface AccessSlotBinding {
    readonly serviceId: string;
    /** Interface ids (of the slot's requested interfaces) the grant covers. */
    readonly interfaces: readonly string[];
}

export interface AccessRequestArgs {
    readonly consumer: AccessConsumer;
    /** Verified signer of the `hubAccess::request` call; the capability audience. */
    readonly consumerPrincipalId: PrincipalId;
    readonly dependencies: Readonly<Record<string, ResolvedAccessSlot>>;
    readonly duration: AccessDuration | undefined;
}

export type AccessDecision =
    | {
        readonly granted: true;
        readonly resolvedSlots: Readonly<Record<string, AccessSlotBinding>>;
        readonly capabilities: readonly SignedCapability[];
    }
    | { readonly granted: false; readonly reason?: string };

export interface AccessExtendMember {
    readonly interfaceId: string;
    readonly member: Pattern;
    /** Defaults to true. */
    readonly required: boolean;
}

export interface AccessExtendArgs {
    readonly consumer: AccessConsumer;
    readonly consumerPrincipalId: PrincipalId;
    readonly serviceId: string;
    readonly added: readonly AccessExtendMember[];
    readonly duration: AccessDuration | undefined;
}

export type AccessExtendDecision =
    | {
        readonly granted: true;
        readonly serviceId: string;
        readonly grantedMembers: readonly { interfaceId: string; member: Pattern }[];
        readonly capabilities?: readonly SignedCapability[];
    }
    | { readonly granted: false; readonly reason?: string };

/**
 * Optional per-permission invocation preview the consumer attaches to a
 * direct ({@link HubAccessHandlers.onAccessRequestDirect}) request. It is
 * **not** a signed authority constraint — it is the data the consent host
 * needs to render an honest "Allow once" prompt and to pre-compute the
 * `callBind.payloadHash` that binds a one-shot capability to exactly this
 * call. `nonce`/`signedAtMs`/`interfaceHash` are the values the consumer
 * will sign with when it actually issues the call.
 */
export interface AccessCallIntent {
    /** Fully-qualified method name the consumer intends to call. */
    readonly method: string;
    /** Params the consumer intends to send (shown to the user, hashed into callBind). */
    readonly params?: unknown;
    /** Schema-version assertion the call will carry. */
    readonly interfaceHash?: string;
    /** base64url nonce bytes the consumer will sign with. */
    readonly nonce: string;
    /** Unix milliseconds the consumer will sign with. */
    readonly signedAtMs: number;
    /** One-line summary for the prompt. */
    readonly summary?: string;
    /** Consumer's suggested default consent action. */
    readonly suggestion?: AccessDuration;
}

/**
 * An {@link AccessDirectArgs} permission, carrying the verbatim signed
 * {@link Permission} the consumer asked for plus the optional
 * {@link AccessCallIntent} that enables "Allow once" byte-binding.
 */
export interface AccessDirectPermission extends Permission {
    readonly callIntent?: AccessCallIntent;
}

export interface AccessDirectArgs {
    readonly consumer: AccessConsumer;
    readonly consumerPrincipalId: PrincipalId;
    readonly permissions: readonly AccessDirectPermission[];
    readonly duration: AccessDuration | undefined;
}

export type AccessDirectDecision =
    | { readonly granted: true; readonly capabilities: readonly SignedCapability[] }
    | { readonly granted: false; readonly reason?: string };

export interface HubAccessHandlers {
    /** Service-discovery grant: pick a service per slot and mint scoped caps. */
    onAccessRequest(args: AccessRequestArgs): Promise<AccessDecision>;
    /** Service-pinned widening of an existing grant. */
    onAccessExtend(args: AccessExtendArgs): Promise<AccessExtendDecision>;
    /** Verbatim attenuation grant (no discovery). */
    onAccessRequestDirect(args: AccessDirectArgs): Promise<AccessDirectDecision>;
}

export interface RegisterHubAccessOptions {
    /** Consent + capability-issuance callbacks. */
    readonly handlers: HubAccessHandlers;
    /** Provides the directory snapshot for candidate resolution. */
    fetchDirectory(): Promise<readonly DirectoryEntry[]>;
}

/**
 * Install `hubAccess::{request,extend,requestAccess}` at the **connection
 * root** of a participant's overlay (root form, no serviceId prefix). The root
 * is never forwarded, so the consent front door is reached directly and needs
 * no capability of its own.
 *
 * The capability `audience` is taken **directly from `params.consumer.principal`**
 * — no longer derived from a verified call signer. A cap minted for a nodeId is
 * only usable by the holder of that node's key (enforced at call time by
 * `permits`, which checks `audience === call.signer`), so a self-asserted
 * audience grants no usable authority to a caller who does not hold the key.
 */
export function registerHubAccessService(
    connection: HubRpcConnection<unknown>,
    options: RegisterHubAccessOptions,
): void {
    const { handlers } = options;

    connection.register(hubAccessInterface, {
        request: async (params) => {
            const consumerPrincipalId = params.consumer.principal as PrincipalId;

            const slots: Record<string, AccessSlotRequest> = {};
            for (const [slotId, raw] of Object.entries(params.dependencies)) {
                slots[slotId] = normalizeSlot(raw);
            }

            const directory = await options.fetchDirectory();
            const { dependencies, noCandidateSlots } = resolveAccessCandidates(slots, [...directory]);
            if (noCandidateSlots.length > 0) {
                return { status: 'noCandidates', slots: [...noCandidateSlots] };
            }

            const decision = await handlers.onAccessRequest({
                consumer: params.consumer,
                consumerPrincipalId,
                dependencies,
                duration: params.duration,
            });

            if (!decision.granted) {
                return decision.reason !== undefined
                    ? { status: 'denied', reason: decision.reason }
                    : { status: 'denied' };
            }

            // Defense-in-depth: refuse bindings to services the candidate
            // resolver didn't surface for that slot.
            const responseSlots: Record<string, { serviceId: string; satisfiedInterfaces: string[] }> = {};
            for (const [slotId, binding] of Object.entries(decision.resolvedSlots)) {
                const resolved = dependencies[slotId];
                if (!resolved) {
                    continue;
                }
                const candidate = resolved.candidates.find((c) => c.serviceId === binding.serviceId);
                if (!candidate) {
                    continue;
                }
                responseSlots[slotId] = {
                    serviceId: binding.serviceId,
                    satisfiedInterfaces: [...binding.interfaces],
                };
            }

            return {
                status: 'granted',
                slots: responseSlots,
                capabilities: [...decision.capabilities] as SignedCapability[],
            };
        },

        extend: async (params) => {
            const consumerPrincipalId = params.consumer.principal as PrincipalId;

            const added: AccessExtendMember[] = params.added.map((a) => ({
                interfaceId: a.interfaceId,
                member: a.member,
                required: a.required !== false,
            }));

            const decision = await handlers.onAccessExtend({
                consumer: params.consumer,
                consumerPrincipalId,
                serviceId: params.serviceId,
                added,
                duration: params.duration,
            });

            if (!decision.granted) {
                return decision.reason !== undefined
                    ? { status: 'denied', reason: decision.reason }
                    : { status: 'denied' };
            }

            const grantedMembers = decision.grantedMembers.map((g) => ({
                interfaceId: g.interfaceId,
                member: g.member,
            }));
            return decision.capabilities !== undefined
                ? {
                    status: 'granted',
                    serviceId: decision.serviceId,
                    granted: grantedMembers,
                    capabilities: [...decision.capabilities] as SignedCapability[],
                }
                : {
                    status: 'granted',
                    serviceId: decision.serviceId,
                    granted: grantedMembers,
                };
        },

        requestAccess: async (params) => {
            const consumerPrincipalId = params.consumer.principal as PrincipalId;

            const decision = await handlers.onAccessRequestDirect({
                consumer: params.consumer,
                consumerPrincipalId,
                permissions: params.permissions as AccessDirectPermission[],
                duration: params.duration,
            });

            if (!decision.granted) {
                return decision.reason !== undefined
                    ? { status: 'denied', reason: decision.reason }
                    : { status: 'denied' };
            }
            return {
                status: 'granted',
                capabilities: [...decision.capabilities] as SignedCapability[],
            };
        },
    });
}

function normalizeSlot(raw: {
    interfaces: { id: string; hash?: string; required?: boolean }[];
    members?: { interfaceId: string; member: Pattern; required?: boolean }[];
}): AccessSlotRequest {
    return {
        interfaces: raw.interfaces.map((i) => ({
            id: i.id,
            required: i.required !== false,
            ...(i.hash !== undefined ? { hash: i.hash } : {}),
        })),
        members: (raw.members ?? []).map((m) => ({
            interfaceId: m.interfaceId,
            member: m.member,
            required: m.required !== false,
        })),
    };
}
