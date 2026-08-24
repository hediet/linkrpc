/**
 * `runManifestApprover` — a connection-based consumer of `hubAccessManifest`.
 *
 * This is the approver side of the consent surface, factored out of the hub: it
 * reaches a manifest **only over an {@link HubRpcConnection}** (`hubAccessManifest::
 * {getDesired,watchDesired,setCurrent}`), never by touching the in-process
 * {@link HubAccessManifestHost}. That indirection is deliberate — the exact same
 * approver runs against a *remote* hub's (or a participant's) manifest with no
 * code change. The hub stays keyless park-and-relay; the approver owns the UI,
 * the signing identity **and** (for `discover` entries) the candidate
 * resolution.
 *
 * Per desired entry it: skips entries whose `acceptableRootIds` it cannot
 * satisfy; for a `discover` entry resolves candidates against the directory
 * (fetched over its own connection) and picks a service; prompts the operator
 * (default: terminal y/N); mints a capability with its own
 * {@link CapabilityProposalIssuer} (honoring "Allow once" `callIntent`
 * byte-binding); and writes the decision back via `setCurrent`. Prompts run
 * serially. If an entry disappears from `getDesired` while its prompt is open
 * (decided elsewhere / consumer cancelled) the prompt is aborted.
 */
import {
    type SignedCapability,
} from '@vscode/hubrpc';
import {
    type HubAccessManifestDecision,
    type HubAccessManifestRequest,
    type IHubAccessManifest,
} from '@vscode/hubrpc/hub/common';
import { autorun } from '@vscode/observables';
import {
    type AccessDurationName,
    type AccessSlotRequest,
    type CapabilityProposalIssuer,
    candidatesForSlot,
    type DirectoryEntry,
    durationToExp,
} from '../hub/server';
import { buildSlotPermissions } from './hubAccessConfig';
import {
    type ConsentPrompt,
    createTerminalConsentPrompt,
    describePermissions,
    toSignedPermissions,
} from './consent';
import type { AccessDirectPermission } from '../hub/server';
import { ApproveClient } from './approveClient';

export interface ManifestApproverOptions {
    /**
     * The manifest to consume. Just the typed client of
     * {@link hubAccessManifestInterface} — obtained over any connection
     * (`connection.service(id).get(hubAccessManifestInterface)`), in-memory or
     * remote. The approver never touches a raw connection for the manifest
     * surface.
     */
    readonly manifest: IHubAccessManifest;
    /**
     * Resolve `discover` entries against the participant directory. Supplied by
     * the caller because directory access needs the approver's own signed
     * connection (the approver holds the key). Omit if this approver never
     * expects `discover` entries — such entries are then denied.
     */
    readonly fetchDirectory?: () => Promise<readonly DirectoryEntry[]>;
    /** Mints the approver's own capabilities (audience = the entry's consumer). */
    readonly issuer: CapabilityProposalIssuer;
    /**
     * This approver's own root principal. An entry is acted on only if its
     * `acceptableRootIds` is absent or includes this id —
     * otherwise the approver's signature would be useless to the consumer.
     * Defaults to the issuer's principal.
     */
    readonly ownPrincipalId?: string;
    /** Decision source. Defaults to a terminal y/N prompt on stdin. */
    readonly prompt?: ConsentPrompt;
    /** Human log sink. Defaults to stderr. */
    readonly log?: (line: string) => void;
}

export interface ManifestApprover {
    /** Stop watching and abort any in-flight prompt. */
    dispose(): void;
}

/** What the approver resolves an entry to before prompting: perms + optional chosen service. */
interface ResolvedEntry {
    readonly permissions: readonly AccessDirectPermission[];
    /** Present for `discover`: the service the approver picked + its satisfied interfaces. */
    readonly resolvedSlot?: { readonly serviceId: string; readonly satisfiedInterfaces: readonly string[]; };
}

/**
 * Start consuming the manifest at `options.serviceId` over `options.connection`.
 * Runs until {@link ManifestApprover.dispose}.
 */
export function runManifestApprover(options: ManifestApproverOptions): ManifestApprover {
    const prompt = options.prompt ?? createTerminalConsentPrompt();
    const rawLog = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
    const log = (line: string): void => { try { rawLog(line); } catch { /* ignore */ } };
    const ownPrincipalId = options.ownPrincipalId ?? options.issuer.issuerPrincipalId;
    /** entryIds currently being prompted, with their abort handle. */
    const inFlight = new Map<string, AbortController>();
    let disposed = false;
    let tail: Promise<void> = Promise.resolve();
    const client = new ApproveClient({
        manifest: options.manifest,
        ownPrincipalId,
        log,
    });

    /** Resolve an entry to permissions (+ chosen service for discover). */
    const resolveEntry = async (entry: HubAccessManifestRequest): Promise<ResolvedEntry | { denied: string }> => {
        if (entry.kind === 'direct') {
            return { permissions: entry.permissions };
        }
        // discover: pick a candidate service from the directory.
        if (options.fetchDirectory === undefined) {
            return { denied: 'no directory available to resolve discover candidates' };
        }
        const directory = await options.fetchDirectory();
        const slot: AccessSlotRequest = {
            interfaces: entry.interfaces.map((i) => ({ id: i.id, required: i.required !== false, ...(i.hash !== undefined ? { hash: i.hash } : {}) })),
            members: entry.members.map((m) => ({ interfaceId: m.interfaceId, member: m.member, required: m.required !== false })),
        };
        const candidate = candidatesForSlot(slot, directory as DirectoryEntry[])[0];
        if (!candidate) {
            return { denied: 'no candidate service satisfies the requested interfaces' };
        }
        const present = new Set(candidate.satisfiedInterfaces.map((i) => i.id));
        const permissions = buildSlotPermissions(candidate.serviceId, slot.interfaces, slot.members, present) as AccessDirectPermission[];
        return {
            permissions,
            resolvedSlot: {
                serviceId: candidate.serviceId,
                satisfiedInterfaces: candidate.satisfiedInterfaces.map((i) => i.id),
            },
        };
    };

    const mint = async (
        consumerPrincipalId: string,
        permissions: readonly AccessDirectPermission[],
        duration: string | undefined,
    ): Promise<SignedCapability> => {
        const signed = await toSignedPermissions(permissions, consumerPrincipalId, duration);
        return options.issuer.mint({
            audience: consumerPrincipalId,
            permissions: signed,
            expiresAtMs: durationToExp(duration as AccessDurationName | undefined),
        });
    };

    const processEntry = (
        entryId: string,
        entry: HubAccessManifestRequest,
        ac: AbortController,
    ) => async (): Promise<void> => {
        if (ac.signal.aborted) {
            inFlight.delete(entryId);
            return;
        }
        try {
            const resolved = await resolveEntry(entry);
            if ('denied' in resolved) {
                await client.decide(entryId, { status: 'denied', reason: resolved.denied });
                return;
            }
            if (ac.signal.aborted) return;

            const decision = await prompt({
                requestId: entryId,
                kind: entry.kind === 'discover' ? 'request' : 'requestAccess',
                consumer: entry.consumer,
                consumerPrincipalId: entry.consumer.principal,
                permissions: resolved.permissions,
                grants: describePermissions(resolved.permissions),
                duration: entry.duration,
                signal: ac.signal,
            });
            if (ac.signal.aborted) return;

            if (!decision.grant) {
                await client.decide(entryId, decision.reason !== undefined
                    ? { status: 'denied', reason: decision.reason }
                    : { status: 'denied' });
                return;
            }

            const capabilities = decision.capabilities !== undefined && decision.capabilities.length > 0
                ? [...decision.capabilities]
                : [await mint(entry.consumer.principal, resolved.permissions, entry.duration)];

            const granted = resolved.resolvedSlot !== undefined
                ? {
                    kind: 'discover' as const,
                    serviceId: resolved.resolvedSlot.serviceId,
                    satisfiedInterfaces: [...resolved.resolvedSlot.satisfiedInterfaces],
                    capabilities,
                }
                : { kind: 'direct' as const, capabilities };
            await client.decide(entryId, { status: 'granted', granted } satisfies HubAccessManifestDecision);
        } catch (e) {
            log(`hubAccess approver: failed to decide ${entryId}: ${(e as Error).message}`);
        } finally {
            inFlight.delete(entryId);
        }
    };

    const subscription = autorun((reader) => {
        const requests = client.requests.read(reader);
        const present = new Set(requests.map((entry) => entry.id));
        // Abort prompts whose entry is gone (decided elsewhere / consumer left).
        for (const [entryId, ac] of inFlight) {
            if (!present.has(entryId)) ac.abort();
        }
        for (const { id: entryId, request: entry } of requests) {
            if (inFlight.has(entryId)) continue;
            const ac = new AbortController();
            inFlight.set(entryId, ac);
            // Serialize so only one terminal prompt is open at a time.
            tail = tail.then(processEntry(entryId, entry, ac));
        }
    });

    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const ac of inFlight.values()) ac.abort();
            subscription.dispose();
            client.dispose();
        },
    };
}
