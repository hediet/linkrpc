/**
 * `createHubAccessConfig` — the adapter from the imperative `hubAccess` front
 * door to a single {@link AccessDecider} callback.
 *
 * The `hubAccess::{request,extend,requestAccess}` interface has three shapes;
 * this adapter normalizes all of them into one {@link AccessRequestContext}
 * (resolving discovery candidates for `request`, building permissions for
 * `extend`) and hands them to `decide`. The decider supplies the
 * approver-signed capabilities to relay (it never mints here). Two deciders
 * exist:
 *
 *  - {@link HubAccessManifestHost.park} — parks the request as a manifest entry
 *    and awaits a remote approver.
 *  - {@link HubAccessGrantSigner.decide} — decides + mints in-process with a
 *    held signing identity (the simple "hub grants locally" case).
 *
 * `fetchDirectory` is the candidate-resolution source for `request`; it is a
 * property of *this* front-door registration, not of any decider. Defaults to
 * an empty directory (every `request` slot then resolves to `noCandidates`).
 */
import { type Pattern, type Permission } from '@vscode/hubrpc';
import {
    type AccessConsumer,
    type AccessDirectPermission,
    type AccessDuration,
    type AccessSlotBinding,
    type DirectoryEntry,
    type HubAccessConfig,
    type HubAccessHandlers,
} from '../hub/server';
import { type ConsentDecision, describePermissions } from './consent';
import type { SignedCapability } from '@vscode/hubrpc';

/** The normalized request every `hubAccess` shape collapses to before deciding. */
export interface AccessRequestContext {
    readonly kind: 'request' | 'extend' | 'requestAccess';
    readonly consumer: AccessConsumer;
    /** Capability audience — the consumer's own PrincipalId. */
    readonly consumerPrincipalId: string;
    /** The requested authority; permissions may carry a consent-only `callIntent`. */
    readonly permissions: readonly AccessDirectPermission[];
    readonly duration: AccessDuration | undefined;
}

/** Decides one normalized request, returning the approver-signed capabilities to relay. */
export type AccessDecider = (ctx: AccessRequestContext) => Promise<ConsentDecision>;

/**
 * Build the `hubAccess` front-door config from a single {@link AccessDecider}.
 * The returned {@link HubAccessConfig} is what `registerHubAccessService`
 * installs at a participant's overlay root.
 */
export function createHubAccessConfig(
    decide: AccessDecider,
    fetchDirectory: () => Promise<readonly DirectoryEntry[]> = async () => [],
): HubAccessConfig {
    const handlers: HubAccessHandlers = {
        onAccessRequest: async (args) => {
            const slotIds = Object.keys(args.dependencies);
            if (slotIds.length === 0) {
                return { granted: false, reason: 'no slots requested' };
            }
            const resolvedSlots: Record<string, AccessSlotBinding> = {};
            const permissions: Permission[] = [];
            for (const [slotId, slot] of Object.entries(args.dependencies)) {
                const candidate = slot.candidates[0];
                if (!candidate) {
                    return { granted: false, reason: `no candidate for slot '${slotId}'` };
                }
                const present = new Set(candidate.satisfiedInterfaces.map((i) => i.id));
                resolvedSlots[slotId] = {
                    serviceId: candidate.serviceId,
                    interfaces: candidate.satisfiedInterfaces.map((i) => i.id),
                };
                permissions.push(
                    ...buildSlotPermissions(candidate.serviceId, slot.request.interfaces, slot.request.members, present),
                );
            }
            const decision = await decide({
                kind: 'request',
                consumer: args.consumer,
                consumerPrincipalId: args.consumerPrincipalId,
                permissions,
                duration: args.duration,
            });
            if (!decision.grant) {
                return { granted: false, reason: decision.reason ?? 'user denied' };
            }
            return { granted: true, resolvedSlots, capabilities: capsFromDecision(decision) };
        },

        onAccessExtend: async (args) => {
            const byIface = new Map<string, Pattern[]>();
            for (const a of args.added) {
                const members = byIface.get(a.interfaceId) ?? [];
                members.push(a.member);
                byIface.set(a.interfaceId, members);
            }
            const permissions: Permission[] = [...byIface.entries()].map(([interfaceId, members]) => ({
                target: { serviceId: { exact: args.serviceId }, interfaceId: { exact: interfaceId }, members },
                canInvoke: true,
            }));
            if (permissions.length === 0) {
                return { granted: false, reason: 'no members requested' };
            }
            const decision = await decide({
                kind: 'extend',
                consumer: args.consumer,
                consumerPrincipalId: args.consumerPrincipalId,
                permissions,
                duration: args.duration,
            });
            if (!decision.grant) {
                return { granted: false, reason: decision.reason ?? 'user denied' };
            }
            return {
                granted: true,
                serviceId: args.serviceId,
                grantedMembers: args.added.map((a) => ({ interfaceId: a.interfaceId, member: a.member })),
                capabilities: capsFromDecision(decision),
            };
        },

        onAccessRequestDirect: async (args) => {
            if (args.permissions.length === 0) {
                return { granted: false, reason: 'no permissions requested' };
            }
            const decision = await decide({
                kind: 'requestAccess',
                consumer: args.consumer,
                consumerPrincipalId: args.consumerPrincipalId,
                permissions: args.permissions,
                duration: args.duration,
            });
            if (!decision.grant) {
                return { granted: false, reason: decision.reason ?? 'user denied' };
            }
            return { granted: true, capabilities: capsFromDecision(decision) };
        },
    };

    return {
        handlers,
        fetchDirectory: async () => [...(await fetchDirectory())],
    };
}

/** A one-line human summary of a request, for a decider's log. */
export function describeRequest(ctx: AccessRequestContext): string {
    return `"${ctx.consumer.name}" (node=${ctx.consumerPrincipalId}) requests `
        + `[${describePermissions(ctx.permissions).join(', ')}]${ctx.duration ? ` for '${ctx.duration}'` : ''}`;
}

/**
 * Extract the approver-supplied capabilities from an approved decision. The
 * adapter never mints — an approval that carries no capabilities is a contract
 * violation by the decider.
 */
function capsFromDecision(
    decision: { readonly grant: true; readonly capabilities?: readonly SignedCapability[]; },
): SignedCapability[] {
    if (decision.capabilities === undefined || decision.capabilities.length === 0) {
        throw new Error(
            'hubAccess: a grant decision carried no capabilities to relay — the '
            + 'decider must supply approver-signed capabilities (the adapter never mints).',
        );
    }
    return [...decision.capabilities];
}

/** Build one permission per requested interface, scoped to `serviceId`. */
export function buildSlotPermissions(
    serviceId: string,
    interfaces: readonly { id: string; hash?: string; }[],
    members: readonly { interfaceId: string; member: Pattern; }[],
    present: ReadonlySet<string>,
): Permission[] {
    const hashByIface = new Map(interfaces.map((i) => [i.id, i.hash]));
    const buckets = new Map<string, { interfaceId: string; hash: string | undefined; members: Pattern[]; }>();
    for (const m of members) {
        if (!present.has(m.interfaceId)) continue;
        const hash = hashByIface.get(m.interfaceId);
        const key = `${m.interfaceId}\u0000${hash ?? ''}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { interfaceId: m.interfaceId, hash, members: [] };
            buckets.set(key, bucket);
        }
        bucket.members.push(m.member);
    }
    // No member-level requests: grant the whole interface (any member).
    if (buckets.size === 0) {
        return [...present].map((interfaceId) => {
            const hash = hashByIface.get(interfaceId);
            const target: Permission['target'] = {
                serviceId: { exact: serviceId },
                interfaceId: { exact: interfaceId },
                members: [{ prefix: '' }],
            };
            if (hash !== undefined) (target as { interfaceHash?: string }).interfaceHash = hash;
            return { target, canInvoke: true };
        });
    }
    return [...buckets.values()].map((b) => {
        const target: Permission['target'] = {
            serviceId: { exact: serviceId },
            interfaceId: { exact: b.interfaceId },
            members: b.members,
        };
        if (b.hash !== undefined) (target as { interfaceHash?: string }).interfaceHash = b.hash;
        return { target, canInvoke: true };
    });
}
