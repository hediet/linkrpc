/**
 * `HubAccessManifestHost` — the hub's keyless consent **rendezvous**. It is the
 * inverse-of-control twin of the imperative `hubAccess` front door: it serves
 * the discoverable `hubAccessManifest`, and it registers `hubAccess` **directly**
 * ({@link registerHubAccessAtRoot}) rather than through the imperative
 * `registerHubAccessService` (which resolves discovery candidates hub-side and
 * mints hub-side). Mapping:
 *
 *  - `hubAccess::requestAccess` → a **direct** desired entry (verbatim perms).
 *  - `hubAccess::extend`        → a **direct** desired entry (widen on a service).
 *  - `hubAccess::request`       → one **discover** desired entry per dependency
 *    slot; the *approver* resolves candidates against the directory (over its
 *    own connection) and returns the chosen service. The blocked call unblocks
 *    when every slot is decided. **No hub-side directory** is consulted here.
 *
 * The host is **keyless**. A decision is a pure relay: the approver mints a
 * capability with its own accepted-root identity (audience = the entry's
 * consumer) and writes it into `current` via `setCurrent`; the host forwards it
 * verbatim as the blocked `hubAccess` call's result. The authority is the
 * signature, not the `setCurrent` call — reachable only behind the
 * forwarded-call gate. Each desired entry advertises `acceptableRootIds` (the
 * hub's accepted roots) so an approver can skip entries it cannot satisfy.
 */
import {
    type HubRpcConnection,
    type Pattern,
    type Permission,
    type SignedCapability,
} from '@vscode/hubrpc';
import { hubAccessInterface, hubAccessManifestInterface } from '@vscode/hubrpc/hub/common';
import { type AccessDirectPermission } from '../hub/server';
import { randomUUID } from 'node:crypto';
import { describePermissions } from './consent';

/** One interface a discover slot's chosen service must implement. */
export interface ManifestInterfaceReq {
    readonly id: string;
    readonly hash?: string;
    readonly required?: boolean;
}

/** One member a discover slot's consumer intends to call. */
export interface ManifestMemberReq {
    readonly interfaceId: string;
    readonly member: Pattern;
    readonly required?: boolean;
}

interface PendingBase {
    readonly requestId: string;
    readonly consumer: { readonly name: string; readonly origin?: string; readonly purpose?: string; };
    readonly consumerPrincipalId: string;
    readonly duration: string | undefined;
    /**
     * Host-authored provenance bag, bound per transport at
     * {@link HubAccessManifestHost.registerHubAccessAtRoot} — never read from the
     * request params. Relayed verbatim in `getDesired`; the host does not
     * interpret it.
     */
    readonly origin?: Record<string, unknown>;
}

/** A parked, undecided request — the host's view of one desired entry. */
export type PendingManifestEntry =
    | (PendingBase & {
        readonly kind: 'direct';
        /** Verbatim requested authority; permissions may carry a `callIntent`. */
        readonly permissions: readonly AccessDirectPermission[];
    })
    | (PendingBase & {
        readonly kind: 'discover';
        /** The interfaces the chosen service must implement (unresolved). */
        readonly interfaces: readonly ManifestInterfaceReq[];
        /** The members the consumer intends to call. */
        readonly members: readonly ManifestMemberReq[];
    });

/**
 * The approver's decision for one parked entry, delivered via `setCurrent`.
 * A `discover` grant additionally names the chosen service (`resolvedSlot`).
 */
export type ManifestEntryDecision =
    | { readonly grant: false; readonly reason?: string; }
    | {
        readonly grant: true;
        readonly capabilities: readonly SignedCapability[];
        /** Present for a `discover` grant: which service the approver picked. */
        readonly resolvedSlot?: { readonly serviceId: string; readonly satisfiedInterfaces: readonly string[]; };
    };

interface InternalEntry {
    readonly entry: PendingManifestEntry;
    readonly resolve: (decision: ManifestEntryDecision) => void;
}

/** Distributive `Omit` — preserves each union member (unlike the built-in `Omit`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface HubAccessManifestHostOptions {
    /**
     * Root issuer principals the hub's forwarded-call gate accepts. Published as
     * each desired entry's `acceptableRootIds`, so an approver only acts on
     * entries it can satisfy (it is — or chains to — one of these). Omit/empty to
     * leave the roots unspecified (approver decides).
     */
    readonly acceptableRootIds?: readonly string[];
    /** Human log sink for incoming requests. Defaults to stderr. */
    readonly log?: (line: string) => void;
}

export class HubAccessManifestHost {
    private readonly _pending = new Map<string, InternalEntry>();
    private readonly _listeners = new Set<() => void>();
    private readonly _acceptableRootIds: readonly string[];
    private readonly _log: (line: string) => void;
    private _revision = 0;

    constructor(options: HubAccessManifestHostOptions = {}) {
        this._acceptableRootIds = options.acceptableRootIds ?? [];
        this._log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
    }

    // ---- hubAccess in: registered DIRECTLY at the overlay root ------------

    /**
     * Register `hubAccess::{request,extend,requestAccess}` directly at a
     * participant's overlay root (root form, never forwarded → never gated).
     * Unlike `registerHubAccessService` this consults **no** hub-side directory:
     * `request` forwards raw slots as `discover` entries for the approver to
     * resolve.
     *
     * `options.origin` is a host-authored provenance bag bound to THIS
     * connection and stamped onto every entry parked here. It is bound
     * server-side (not read from the consumer's request params) so a consumer
     * cannot spoof another transport's origin. The host relays it verbatim; it
     * does not interpret it.
     */
    public registerHubAccessAtRoot(
        connection: HubRpcConnection<unknown>,
        options?: { readonly origin?: Record<string, unknown>; },
    ): void {
        const origin = options?.origin;
        connection.register(hubAccessInterface, {
            request: async (params, _ctx, stream) => {
                const consumerPrincipalId = params.consumer.principal;
                const consumer = plainConsumer(params.consumer);
                const slotIds = Object.keys(params.dependencies);
                if (slotIds.length === 0) {
                    return { status: 'denied', reason: 'no slots requested' };
                }
                this._log(
                    `hubAccess::request "${consumer.name}" (node=${consumerPrincipalId}) `
                    + `slots=[${slotIds.join(', ')}]${params.duration ? ` for '${params.duration}'` : ''}`,
                );
                const results = await Promise.all(slotIds.map((slotId) => {
                    const slot = params.dependencies[slotId]!;
                    return this._park({
                        kind: 'discover',
                        consumer,
                        consumerPrincipalId,
                        duration: params.duration,
                        interfaces: slot.interfaces,
                        members: slot.members ?? [],
                        origin,
                    }, stream.signal);
                }));

                const denied = results.find((r) => !r.grant);
                if (denied && !denied.grant) {
                    return denied.reason !== undefined
                        ? { status: 'denied', reason: denied.reason }
                        : { status: 'denied' };
                }
                const slots: Record<string, { serviceId: string; satisfiedInterfaces: string[]; }> = {};
                const capabilities: SignedCapability[] = [];
                slotIds.forEach((slotId, i) => {
                    const r = results[i]!;
                    if (!r.grant) return; // unreachable (denied handled above)
                    if (r.resolvedSlot) {
                        slots[slotId] = {
                            serviceId: r.resolvedSlot.serviceId,
                            satisfiedInterfaces: [...r.resolvedSlot.satisfiedInterfaces],
                        };
                    }
                    capabilities.push(...r.capabilities);
                });
                return { status: 'granted', slots, capabilities };
            },

            extend: async (params, _ctx, stream) => {
                const consumerPrincipalId = params.consumer.principal;
                const permissions = extendPermissions(params.serviceId, params.added);
                this._log(
                    `hubAccess::extend "${params.consumer.name}" (node=${consumerPrincipalId}) `
                    + `service=${params.serviceId}`,
                );
                const decision = await this._park({
                    kind: 'direct',
                    consumer: plainConsumer(params.consumer),
                    consumerPrincipalId,
                    duration: params.duration,
                    permissions,
                    origin,
                }, stream.signal);
                if (!decision.grant) {
                    return decision.reason !== undefined
                        ? { status: 'denied', reason: decision.reason }
                        : { status: 'denied' };
                }
                return {
                    status: 'granted',
                    serviceId: params.serviceId,
                    granted: params.added.map((a) => ({ interfaceId: a.interfaceId, member: a.member })),
                    capabilities: [...decision.capabilities],
                };
            },

            requestAccess: async (params, _ctx, stream) => {
                const consumerPrincipalId = params.consumer.principal;
                const permissions = params.permissions as AccessDirectPermission[];
                if (permissions.length === 0) {
                    return { status: 'denied', reason: 'no permissions requested' };
                }
                this._log(
                    `hubAccess::requestAccess "${params.consumer.name}" (node=${consumerPrincipalId}) `
                    + `[${describePermissions(permissions).join(', ')}]`
                    + `${params.duration ? ` for '${params.duration}'` : ''}`,
                );
                const decision = await this._park({
                    kind: 'direct',
                    consumer: plainConsumer(params.consumer),
                    consumerPrincipalId,
                    duration: params.duration,
                    permissions,
                    origin,
                }, stream.signal);
                if (!decision.grant) {
                    return decision.reason !== undefined
                        ? { status: 'denied', reason: decision.reason }
                        : { status: 'denied' };
                }
                return { status: 'granted', capabilities: [...decision.capabilities] };
            },
        });
    }

    /** Park a desired entry and await the approver's decision (via `setCurrent`). */
    private _park(
        entry: DistributiveOmit<PendingManifestEntry, 'requestId'>,
        signal?: AbortSignal,
    ): Promise<ManifestEntryDecision> {
        signal?.throwIfAborted();
        return new Promise<ManifestEntryDecision>((resolve, reject) => {
            const requestId = randomUUID();
            const full = { ...entry, requestId } as PendingManifestEntry;
            let done = false;
            const settle = (decision: ManifestEntryDecision) => {
                if (done) return;
                done = true;
                signal?.removeEventListener('abort', abort);
                this._pending.delete(requestId);
                this._bump();
                resolve(decision);
            };
            const abort = () => {
                if (done) return;
                done = true;
                this._pending.delete(requestId);
                this._bump();
                reject(signal?.reason ?? new Error('hubAccess request cancelled'));
            };
            this._pending.set(requestId, { entry: full, resolve: settle });
            this._bump();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    }

    // ---- manifest out: the served desired/current state -------------------

    /** Snapshot of the desired document (entryId → desired entry) + revision. */
    public getDesired(): { entries: PendingManifestEntry[]; acceptableRootIds: readonly string[]; revision: number; } {
        return {
            entries: [...this._pending.values()].map((e) => e.entry),
            acceptableRootIds: this._acceptableRootIds,
            revision: this._revision,
        };
    }

    /**
     * Resolve a parked entry from a `setCurrent` decision. Returns `false` when
     * no entry with that id is pending (already decided / cancelled).
     */
    public resolve(requestId: string, decision: ManifestEntryDecision): boolean {
        const found = this._pending.get(requestId);
        if (!found) return false;
        found.resolve(decision);
        return true;
    }

    /** Subscribe to coarse "desired set may have changed" notifications. */
    public onDidChange(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    private _bump(): void {
        this._revision += 1;
        for (const l of [...this._listeners]) {
            l();
        }
    }
}

type ManifestDuration = 'once' | 'shortLived' | 'longLived' | 'persistent';

function plainConsumer(c: { name: string; origin?: string; purpose?: string; }): { name: string; origin?: string; purpose?: string; } {
    return {
        name: c.name,
        ...(c.origin !== undefined ? { origin: c.origin } : {}),
        ...(c.purpose !== undefined ? { purpose: c.purpose } : {}),
    };
}

/** Group extend `added` members by interface into permissions scoped to `serviceId`. */
function extendPermissions(
    serviceId: string,
    added: readonly { interfaceId: string; member: Pattern; }[],
): AccessDirectPermission[] {
    const byIface = new Map<string, Pattern[]>();
    for (const a of added) {
        const members = byIface.get(a.interfaceId) ?? [];
        members.push(a.member);
        byIface.set(a.interfaceId, members);
    }
    return [...byIface.entries()].map(([interfaceId, members]) => ({
        target: { serviceId: { exact: serviceId }, interfaceId: { exact: interfaceId }, members },
        canInvoke: true,
    }));
}

/**
 * Serve `hubAccessManifest::*` on `connection`, mounted under `serviceId` (the
 * hub's own service prefix). Reachable only through the forwarded-call gate, so
 * authorization (an accepted-root capability) is enforced upstream — no gate is
 * applied here.
 *
 * `getCurrent`/`watchCurrent` are vestigial for the hub broker: granted caps are
 * delivered as the blocked `hubAccess` call's result, not read back through
 * `current`. They are served (empty) to satisfy the interface.
 */
export function registerHubAccessManifest(
    connection: HubRpcConnection<unknown>,
    host: HubAccessManifestHost,
    options: { readonly serviceId: string; },
): void {
    connection.register(hubAccessManifestInterface, {
        getDesired: () => {
            const { entries, acceptableRootIds, revision } = host.getDesired();
            const requested: Record<string, ManifestRequestWire> = {};
            const roots = acceptableRootIds.length > 0 ? [...acceptableRootIds] : undefined;
            for (const e of entries) {
                const consumer = { ...e.consumer, principal: e.consumerPrincipalId };
                const duration = e.duration as ManifestDuration | undefined;
                const originFields = e.origin !== undefined ? { origin: e.origin } : {};
                if (e.kind === 'direct') {
                    requested[e.requestId] = {
                        kind: 'direct',
                        consumer,
                        permissions: e.permissions as Permission[],
                        ...(duration !== undefined ? { duration } : {}),
                        ...(roots !== undefined ? { acceptableRootIds: roots } : {}),
                        ...originFields,
                    };
                } else {
                    requested[e.requestId] = {
                        kind: 'discover',
                        consumer,
                        interfaces: e.interfaces.map((i) => ({ id: i.id, ...(i.hash !== undefined ? { hash: i.hash } : {}), ...(i.required !== undefined ? { required: i.required } : {}) })),
                        members: e.members.map((m) => ({ interfaceId: m.interfaceId, member: m.member, ...(m.required !== undefined ? { required: m.required } : {}) })),
                        ...(duration !== undefined ? { duration } : {}),
                        ...(roots !== undefined ? { acceptableRootIds: roots } : {}),
                        ...originFields,
                    };
                }
            }
            return { requested, revision };
        },

        watchDesired: (_params, _ctx, stream) =>
            new Promise<Record<string, never>>((resolve) => {
                if (stream.signal.aborted) {
                    resolve({});
                    return;
                }
                const unsubscribe = host.onDidChange(() => {
                    if (stream.signal.aborted) return;
                    stream.send({});
                });
                stream.signal.addEventListener(
                    'abort',
                    () => {
                        unsubscribe();
                        resolve({});
                    },
                    { once: true },
                );
            }),

        getCurrent: () => ({ current: {}, revision: 0 }),

        setCurrent: (params) => {
            const unknown: string[] = [];
            for (const patch of params.patches) {
                if (patch.op !== 'set') continue;
                for (const [requestId, value] of currentEntriesOfPatch(patch.path, patch.value)) {
                    if (!host.resolve(requestId, currentEntryToDecision(value))) unknown.push(requestId);
                }
            }
            if (unknown.length > 0) {
                throw new Error(`manifest entries are no longer pending: ${unknown.join(', ')}`);
            }
            return { revision: 0 };
        },

        watchCurrent: (_params, _ctx, stream) =>
            new Promise<Record<string, never>>((resolve) => {
                stream.signal.addEventListener('abort', () => resolve({}), { once: true });
            }),
    }, { serviceId: options.serviceId });
}

interface ManifestConsumerWire { name: string; principal: string; origin?: string; purpose?: string; }
type ManifestRequestWire =
    | {
        kind: 'direct';
        consumer: ManifestConsumerWire;
        permissions: Permission[];
        duration?: ManifestDuration;
        acceptableRootIds?: string[];
        origin?: Record<string, unknown>;
    }
    | {
        kind: 'discover';
        consumer: ManifestConsumerWire;
        interfaces: { id: string; hash?: string; required?: boolean; }[];
        members: { interfaceId: string; member: Pattern; required?: boolean; }[];
        duration?: ManifestDuration;
        acceptableRootIds?: string[];
        origin?: Record<string, unknown>;
    };

/** A `zCurrentEntry` wire value. */
type CurrentEntryValue =
    | {
        status: 'granted';
        granted:
        | { kind: 'direct'; capabilities: SignedCapability[]; }
        | { kind: 'discover'; serviceId: string; satisfiedInterfaces: string[]; capabilities: SignedCapability[]; };
    }
    | { status: 'denied'; reason?: string; };

function currentEntryToDecision(value: CurrentEntryValue): ManifestEntryDecision {
    if (value.status !== 'granted') {
        return value.reason !== undefined ? { grant: false, reason: value.reason } : { grant: false };
    }
    if (value.granted.kind === 'discover') {
        return {
            grant: true,
            capabilities: value.granted.capabilities,
            resolvedSlot: { serviceId: value.granted.serviceId, satisfiedInterfaces: value.granted.satisfiedInterfaces },
        };
    }
    return { grant: true, capabilities: value.granted.capabilities };
}

/**
 * Yield `[entryId, currentEntry]` pairs a `setCurrent` patch targets. Supports
 * whole-document (`''` → `{ current: {...} }`), the `current` map
 * (`/current` → `{...}`), and a single entry (`/current/<id>`).
 */
function* currentEntriesOfPatch(path: string, value: unknown): Iterable<[string, CurrentEntryValue]> {
    const segments = path === '' ? [] : path.split('/').slice(1).map(unescapePointer);
    if (segments.length === 0) {
        const current = (value as { current?: Record<string, CurrentEntryValue>; }).current ?? {};
        yield* Object.entries(current);
        return;
    }
    if (segments[0] !== 'current') return;
    if (segments.length === 1) {
        yield* Object.entries((value as Record<string, CurrentEntryValue>) ?? {});
        return;
    }
    if (segments.length === 2) {
        yield [segments[1], value as CurrentEntryValue];
    }
}

function unescapePointer(segment: string): string {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
