/**
 * Portable access-candidate resolution for the v2 consent engine.
 *
 * In v1 the hub resolved slot candidates internally inside
 * `_handleAccessRequest` by snapshotting the full interface directory and
 * matching each requested slot against it (`hub/hub.ts:_candidatesForSlot`).
 *
 * In v2 the hub is identity-free and has no consent surface. The consent
 * engine lives outside the hub (in the extension host) and resolves
 * candidates against the **directory interface object**. The reusable walker
 * follows only the referrals explicitly exposed by each directory and returns
 * the resulting interface inventory, so the candidate resolver here remains a
 * pure function over that snapshot.
 *
 * The wire shapes (`AccessSlotRequest`, `AccessSlotCandidate`, ...) match the
 * v1 `hubAccess` protocol so existing consumers (web-editors) keep working.
 */

import { type Pattern, type HubRpcConnection, type RootPrincipalSet } from '@vscode/hubrpc';
import { walkHubDetailed } from '@vscode/hubrpc/hub/common';

/** A single entry of the aggregated interface directory. */
export interface DirectoryEntry {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly serviceDescription?: string;
    readonly rootPrincipalSets?: readonly RootPrincipalSet[];
}

export interface AccessInterfaceRequirement {
    readonly id: string;
    /** Optional schema-version pin; when set the candidate's hash must match. */
    readonly hash?: string;
    /** Defaults to true. */
    readonly required: boolean;
}

export interface AccessMemberRequirement {
    readonly interfaceId: string;
    /** Member name matcher (`{ exact }` or `{ prefix }`). */
    readonly member: Pattern;
    /** Defaults to true. */
    readonly required: boolean;
}

export interface AccessSlotRequest {
    readonly interfaces: readonly AccessInterfaceRequirement[];
    readonly members: readonly AccessMemberRequirement[];
}

export interface AccessSlotCandidate {
    readonly serviceId: string;
    readonly serviceDescription?: string;
    /** Subset of the slot's requested interfaces actually present on this candidate. */
    readonly satisfiedInterfaces: readonly AccessInterfaceRequirement[];
    /**
     * Requested interfaces the candidate does NOT satisfy. By construction
     * every entry here is `required: false` — a required-but-missing
     * interface filters the candidate out before it is emitted.
     */
    readonly unsatisfiedInterfaces: readonly AccessInterfaceRequirement[];
}

export interface ResolvedAccessSlot {
    readonly request: AccessSlotRequest;
    /** Empty = no service satisfies every required interface. */
    readonly candidates: readonly AccessSlotCandidate[];
}

export interface ResolvedCandidates {
    readonly dependencies: Readonly<Record<string, ResolvedAccessSlot>>;
    /** Slot ids for which no candidate satisfied every required interface. */
    readonly noCandidateSlots: readonly string[];
}

/**
 * Fetch the full interface directory by recursively walking the hub's
 * **referral** directory graph. {@link walkHubDetailed} follows explicit
 * `hubrpc.directory` listings to collect leaf interfaces (folding transitive
 * root-node-id requirements onto descendants along the way). Routing claims do
 * not create referrals. This is the v2 replacement for the hub-internal
 * `_fullDirectory()`.
 */
export async function fetchFullDirectory(
    connection: HubRpcConnection,
    hubServiceId = 'hub',
): Promise<DirectoryEntry[]> {
    const { listings } = await walkHubDetailed(connection.channel, { rootTarget: hubServiceId });
    return listings.map((it) => ({
        serviceId: it.serviceId,
        interfaceId: it.interfaceId,
        hash: it.hash,
        ...(it.serviceDescription !== undefined ? { serviceDescription: it.serviceDescription } : {}),
        ...(it.rootPrincipalSets !== undefined ? { rootPrincipalSets: it.rootPrincipalSets } : {}),
    }));
}

/**
 * Resolve every dependency slot against a directory snapshot. Pure port of
 * the v1 hub's per-request candidate resolution loop + `_candidatesForSlot`.
 */
export function resolveAccessCandidates(
    slots: Readonly<Record<string, AccessSlotRequest>>,
    directory: readonly DirectoryEntry[],
): ResolvedCandidates {
    const dependencies: Record<string, ResolvedAccessSlot> = {};
    const noCandidateSlots: string[] = [];

    for (const [slotId, slot] of Object.entries(slots)) {
        const candidates = candidatesForSlot(slot, directory);
        dependencies[slotId] = { request: slot, candidates };
        if (candidates.length === 0) {
            noCandidateSlots.push(slotId);
        }
    }

    return { dependencies, noCandidateSlots };
}

/**
 * Match one slot against the directory snapshot. A service is a candidate iff
 * it satisfies every `required` interface (by id, and by hash when pinned).
 */
export function candidatesForSlot(
    slot: AccessSlotRequest,
    directory: readonly DirectoryEntry[],
): AccessSlotCandidate[] {
    // Group directory entries by prefix (serviceId).
    const byPrefix = new Map<
        string,
        { interfaces: { id: string; hash: string }[]; serviceDescription?: string }
    >();
    for (const it of directory) {
        let entry = byPrefix.get(it.serviceId);
        if (!entry) {
            entry = { interfaces: [] };
            byPrefix.set(it.serviceId, entry);
        }
        entry.interfaces.push({ id: it.interfaceId, hash: it.hash });
        if (entry.serviceDescription === undefined && it.serviceDescription !== undefined) {
            entry.serviceDescription = it.serviceDescription;
        }
    }

    const out: AccessSlotCandidate[] = [];
    for (const [prefix, entry] of byPrefix) {
        const ifaces = entry.interfaces;
        const satisfied: AccessInterfaceRequirement[] = [];
        const unsatisfied: AccessInterfaceRequirement[] = [];
        let missingRequired = false;
        for (const req of slot.interfaces) {
            const present = ifaces.some(
                (i) => i.id === req.id && (req.hash === undefined || i.hash === req.hash),
            );
            if (present) {
                satisfied.push(req);
            } else {
                unsatisfied.push(req);
                if (req.required) {
                    missingRequired = true;
                }
            }
        }
        if (missingRequired) {
            continue;
        }
        out.push({
            serviceId: prefix,
            ...(entry.serviceDescription !== undefined
                ? { serviceDescription: entry.serviceDescription }
                : {}),
            satisfiedInterfaces: satisfied,
            unsatisfiedInterfaces: unsatisfied,
        });
    }
    return out;
}
