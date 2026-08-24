import { array, boolean, discriminatedUnion, enum as zEnum, extend, literal, minLength, number, object, optional, record, string, union, unknown } from 'zod/mini';
import { defineInterface, requestType, type InterfaceClient } from '../../index';

const zMemberPattern = union([
    object({ exact: string() }),
    object({ prefix: string() }),
]);

/**
 * Optional per-permission invocation preview the requester suggests for
 * "Allow once" consent UX. When present, the user can bind the resulting
 * capability to this exact (method, params, interfaceHash) tuple.
 *
 * `nonce` and `signedAtMs` are consumer-chosen and identify the exact call
 * attempt the cap will authorise. The host hashes the same canonical
 * bytes the consumer will sign; the gate re-derives the hash from the
 * inbound call and compares. The consumer MUST use the same
 * nonce+signedAtMs when it actually issues the call (`@hediet/linkrpc`'s
 * {@link JsonRpcChannel.setCapProvider} hook does this automatically).
 *
 * Everything in `params` is shown to the user verbatim.
 */
const zCallIntent = object({
    /** Fully-qualified method name the requester intends to call. */
    method: string(),
    /** Exact params the requester intends to send. */
    params: optional(unknown()),
    /** Optional schema hash assertion the call carries inside the signed payload. */
    interfaceHash: optional(string()),
    /** base64url-encoded nonce bytes the consumer will sign with. */
    nonce: string(),
    /** Unix milliseconds the consumer will sign with. */
    signedAtMs: number(),
    /** Optional one-line summary the shell displays next to params. */
    summary: optional(string()),
    /** Requester's preferred default action (`once` if omitted). */
    suggestion: optional(zEnum(['once', 'shortLived', 'longLived', 'persistent'])),
});

const zParamMatcher = union([
    object({ exact: unknown() }),
    object({ enum: array(unknown()) }),
    object({ prefix: string() }),
    object({ subsetOf: array(string()) }),
    object({ any: literal(true) }),
]);

const zCallBindHash = object({
    alg: literal('sha256'),
    payloadHash: string(),
});

/** Wire shape of `TargetPattern` from `@hediet/linkrpc`. */
const zTargetPattern = object({
    serviceId: zMemberPattern,
    interfaceId: zMemberPattern,
    interfaceHash: optional(string()),
    members: array(zMemberPattern),
});

/**
 * Wire shape of `Permission` from `@hediet/linkrpc/identity/capability`.
 * Used by `hubAccess::requestAccess` so the consumer can describe exactly
 * what authority it wants — including wildcard service ids
 * (`target.serviceId: { prefix: "" }`). `canInvoke`/`canDelegate` default
 * to `false` (fail closed).
 */
const zPermission = object({
    target: zTargetPattern,
    canInvoke: optional(boolean()),
    canDelegate: optional(boolean()),
    params: optional(record(string(), zParamMatcher)),
    callBind: optional(zCallBindHash),
});

/**
 * A `requestAccess` permission carrying the consent-only {@link zCallIntent}
 * preview alongside the authority it requests. The host strips `callIntent`
 * before minting the signed capability.
 */
const zRequestPermission = extend(zPermission, {
    callIntent: optional(zCallIntent),
});

/**
 * Who is asking, plus the `principal` that becomes the minted capability's
 * `audience`/target. The hub uses `principal` directly (it is no longer derived
 * from the call's verified signer): a cap minted for a `principal` is only usable
 * by the holder of that principal's key, enforced at call time
 * (`permits` checks `audience === call.signer`).
 */
const zConsumer = object({
    name: string(),
    /** Capability audience/target — the consumer's own PrincipalId. */
    principal: string(),
    origin: optional(string()),
    purpose: optional(string()),
});

/**
 * Wire shape of `SignedCapability` from `@hediet/linkrpc`. Mirrors the
 * structural type without pulling zod into the identity package. Keep in
 * sync with `Capability` / `SignedCapability` there.
 *
 * A capability is now a flat object (its fields) plus a `$linkrpcSignature`
 * map carrying the issuer's `capability` signature. Delegation links to a
 * single `parentHash` (the parent's `signedHash("capability", ...)`).
 */
const zSignedCapability = object({
    issuer: string(),
    audience: string(),
    permissions: array(zPermission),
    expiresAtMs: optional(number()),
    parentHash: optional(string()),
    nonce: string(),
    $linkrpcSignature: object({
        capability: optional(object({ keyId: string(), sig: string() })),
        call: optional(object({ keyId: string(), sig: string() })),
    }),
});

/** Lifetime hint for a minted capability. Shared across hubAccess + the manifest. */
const zDuration = zEnum(['once', 'shortLived', 'longLived', 'persistent']);

// ---- discovery slot shapes (shared by hubAccess.request and hubAccessManifest) ----

/** One interface a slot's chosen service must implement. */
const zInterfaceRef = object({
    id: string(),
    hash: optional(string()),
    /** Default true. */
    required: optional(boolean()),
});

/** One member (method) the consumer intends to call on a slot's interface. */
const zMemberRequest = object({
    interfaceId: string(),
    member: zMemberPattern,
    /** Default true. */
    required: optional(boolean()),
});

/**
 * A consumer's need for ONE service: the interfaces it must speak and the
 * members it intends to call. The discovery side of both `hubAccess::request`
 * (sent as a call param) and `hubAccessManifest` (published as state).
 */
const zSlotRequest = object({
    interfaces: array(zInterfaceRef),
    members: optional(array(zMemberRequest)),
});

/** The resolution of one slot: exactly one chosen service. */
const zResolvedSlot = object({
    serviceId: string(),
    satisfiedInterfaces: array(string()),
});

/**
 * Minimal JSON-document patch op, addressed by an RFC 6901 JSON Pointer.
 * `path: ""` targets the whole document; a pointer like `/granted/secretStore`
 * targets one entry. Used by `hubAccessManifest::setCurrent` to replace the
 * entire granted document or a single entry.
 */
const zManifestPatch = discriminatedUnion('op', [
    object({ op: literal('set'), path: string(), value: unknown() }),
    object({ op: literal('remove'), path: string() }),
]);

/**
 * `hubServiceIdRegistry::registerServiceId` — a participant claims a prefix
 * **outside** its provenance-granted namespace.
 *
 * Reached under the hub's own service id (form-3
 * `<hubServiceId>::hubServiceIdRegistry::registerServiceId`) and gated by an
 * admin-rooted capability. For claims **within** the connection's granted
 * namespace, use the cheaper, capability-free `hubGrantedServiceId::register`
 * instead.
 */
export const hubServiceIdRegistryInterface = defineInterface(
    {
        id: 'hubServiceIdRegistry',
        description: 'Claim a serviceId prefix on the hub.',
    },
    {
        registerServiceId: requestType(
            object({
                requestedPrefix: string().check(minLength(1)),
            }),
            object({}),
        ),
    },
);


/**
 * `hubGrantedServiceId` — the ungated connection surface, served at the
 * connection root on each participant's overlay (so it is reachable directly,
 * never forwarded, and needs no capability of its own). Two jobs:
 *
 *  - `get` (unsigned) reports the topology facts the hub decided for this
 *    connection — where it is and what it may claim.
 *  - `register` (provenance-gated) claims a prefix **within**
 *    this connection's granted namespace — the capability-free claim path.
 *    Claims outside the namespace go through the admin-gated
 *    `<hubServiceId>::hubServiceIdRegistry::registerServiceId` door instead.
 *  - `getHubServiceId` (unsigned) reports the serviceId prefix the hub mounts
 *    its own global services under — the prefix to address the admin-gated
 *    registry and reflection endpoints through. Served at the connection root
 *    so a participant can discover it **before** it knows where the hub lives.
 *
 * The hub's consent front door (`hubAccess::*`) is served at the connection
 * root too, so it needs no bootstrap capability and is reached directly.
 */
export const hubGrantedServiceIdInterface = defineInterface(
    {
        id: 'hubGrantedServiceId',
        description: 'Connection facts and capability-free serviceId claims.',
    },
    {
        /**
         * Connection facts (unsigned). The participant pulls, on each
         * (re)connect, the topology facts the hub has decided for this
         * connection:
         *
         *  - `grantedServiceIdNamespace` — the absolute serviceId region this
         *    connection's provenance may claim (anything at/under it). May be
         *    the empty string, meaning "claim nothing freely".
         */
        get: requestType(
            object({}),
            object({
                grantedServiceIdNamespace: string(),
            }),
        ),

        /**
         * The serviceId prefix the hub mounts its own global services under
         * (default `'hub'`). Use it to address the admin-gated
         * `<hubServiceId>::hubServiceIdRegistry::registerServiceId` door and the
         * hub's reflection endpoints. Served at the connection root (unsigned),
         * so a participant can learn it without first knowing where the hub
         * lives.
         */
        getHubServiceId: requestType(
            object({}),
            object({
                hubServiceId: string(),
            }),
        ),

        /**
         * Claim a serviceId prefix **within** this connection's provenance-
         * granted namespace (see `get().grantedServiceIdNamespace`). No
         * capability needed — the grant already happened out-of-band at attach
         * time. The requested `serviceId` must equal the granted namespace or be
         * nested beneath it; anything else is rejected (claim it through the
         * admin-gated `<hubServiceId>::hubServiceIdRegistry::registerServiceId`
         * door instead).
         */
        register: requestType(
            object({ serviceId: string().check(minLength(1)) }),
            object({}),
        ),
    },
);

/**
 * `hubAccess::request` — a consumer (e.g. a sandboxed web editor) asks the
 * hub for scoped access to one or more services.
 *
 * Consumers describe their needs as named *dependencies* ("slots"): each
 * slot lists the interfaces the chosen service must implement and the
 * methods the consumer wants to call. The hub resolves candidate services
 * from its participant directory, then forwards the bundle to a host-
 * supplied handler (see `Hub` options) that shows the user a single
 * prompt. The handler picks a concrete service per slot and approves a
 * subset of the requested methods.
 *
 * In v1 the response carries only the resolution (which serviceId was
 * chosen per slot). Once the hub holds a signing identity it will also
 * return a `SignedCapability` the consumer attaches to subsequent calls.
 * Until then, dispatch is not gated on the grant — see plan-access.md.
 */
export const hubAccessInterface = defineInterface(
    {
        id: 'hubAccess',
        description: 'Consumer requests scoped access to services on the hub.',
    },
    {
        request: requestType(
            object({
                consumer: zConsumer,
                dependencies: record(string(), zSlotRequest),
                duration: optional(zDuration),
            }),
            discriminatedUnion('status', [
                object({
                    status: literal('granted'),
                    slots: record(string(), zResolvedSlot),
                    /**
                     * One or more `SignedCapability`s issued by the hub
                     * (audience = consumer NodeId). Consumers attach them
                     * via `$hubrpc.capabilities` on subsequent calls. Empty
                     * array is legal (hub with no signing identity / tests).
                     *
                     * Plural so a handler can return per-slot caps with
                     * different `exp`/caveats; typical handlers return a
                     * single cap covering every granted member.
                     */
                    capabilities: array(zSignedCapability),
                }),
                object({
                    status: literal('denied'),
                    reason: optional(string()),
                }),
                object({
                    status: literal('noCandidates'),
                    /** Slot ids that have zero matching candidates. */
                    slots: array(string()),
                }),
            ]),
        ),

        /**
         * Service-pinned widening of an existing grant. The consumer asks
         * the hub for additional members on a `serviceId` they already
         * deal with — same audience (their NodeId) and (intended) same
         * `rootIssuer` as the prior grant. The hub never picks the service
         * for the consumer here: `serviceId` is an input, not a result.
         *
         * On grant the response carries a fresh `SignedCapability` whose
         * attenuations cover **only** the granted delta. Bag-compatible
         * with the prior cap; combine via `merge` (when it exists) or
         * just keep both in `$hubrpc.capabilities`.
         *
         * Distinguished from `request` so the consent UI can render a
         * different affordance ("X already has read access on `github`,
         * grant `update` as well?" instead of from-zero selection).
         *
         * TODO(hub-ledger): enforce "consumer has prior history on this
         * service" — see `hub.ts:_handleAccessExtend`. v1 forwards
         * directly to the host's `onAccessExtend` without consulting the
         * `_grants` ledger; this is by design while we settle on the
         * persistence model.
         */
        extend: requestType(
            object({
                consumer: zConsumer,
                /**
                 * Service to widen the grant on. MUST equal the
                 * `serviceId` of a previously-issued attenuation for this
                 * consumer NodeId. v1 does not validate this.
                 */
                serviceId: string(),
                /**
                 * The delta. Same shape as `request`'s slot.members. Each
                 * entry MUST refer to an interface the consumer has been
                 * introduced to on `serviceId` via a prior `request`.
                 */
                added: array(zMemberRequest),
                duration: optional(zDuration),
            }),
            discriminatedUnion('status', [
                object({
                    status: literal('granted'),
                    serviceId: string(),
                    /** Members actually granted (handler may approve a subset). */
                    granted: array(
                        object({
                            interfaceId: string(),
                            member: zMemberPattern,
                        }),
                    ),
                    /**
                     * Capability covering only the granted delta. Audience
                     * = consumer NodeId. Bag-compatible with the prior
                     * cap on this service.
                     */
                    capabilities: optional(array(zSignedCapability)),
                }),
                object({
                    status: literal('denied'),
                    reason: optional(string()),
                }),
                // TODO(hub-ledger): additional variants once the host's
                // grant ledger is persisted:
                //   - { status: "unknownService", serviceId }
                //   - { status: "unknownInterface", serviceId, interfaceIds }
                // Reject without ever prompting the user when the consumer
                // is asking to widen a service it has no prior grant on.
            ]),
        ),

        /**
         * `hubAccess::requestAccess` — direct capability request. The
         * consumer specifies the exact attenuations it wants. No
         * service-discovery, no candidate resolution: the consumer
         * already knows which `(serviceId, interfaceId, members)` it
         * needs, including wildcards (e.g. `serviceId: { prefix: "" }`
         * to ask for an interface anywhere).
         *
         * Compared to `request`:
         *   - `request` does directory-based discovery, picks one service
         *     per slot, and returns a cap pinned to that service. Use
         *     when the consumer says "give me SOME service that does X".
         *   - `requestAccess` is verbatim. Use when the consumer says
         *     "give me exactly these attenuations". Especially useful for
         *     reflection (`linkrpc.directory::list` on any service) and
         *     for on-demand per-method grants from an explorer-style UI.
         *
         * The user prompt shows the exact `Capability` the hub will sign
         * on Allow, same byte-equality guarantee as `request`/`extend`.
         */
        requestAccess: requestType(
            object({
                consumer: zConsumer,
                permissions: array(zRequestPermission).check(minLength(1)),
                duration: optional(zDuration),
            }),
            discriminatedUnion('status', [
                object({
                    status: literal('granted'),
                    capabilities: array(zSignedCapability),
                }),
                object({
                    status: literal('denied'),
                    reason: optional(string()),
                }),
            ]),
        ),
    },
);

// ════════════════════════════════════════════════════════════════════════
// hubAccessManifest — the declarative twin of `hubAccess`.
// ════════════════════════════════════════════════════════════════════════

/**
 * The root issuer(s) whose signature the participant will accept on the minted
 * capability. A capability is only usable by its holder if it chains to a root
 * that the *target* service trusts — and not every service trusts every root.
 * So the participant declares, per entry, which minting root(s) would produce a
 * cap it can actually use; the admin must mint with one of them (or decline).
 *
 * Tri-state, by design:
 *  - **omitted** (`undefined`) — unspecified. The participant doesn't know /
 *    doesn't constrain the root; the admin picks. (The common, lenient default.)
 *  - **non-empty** (`["id:abc", …]`) — mint with one of *these* roots; a cap
 *    rooted elsewhere is useless to the participant.
 *  - **empty** (`[]`) — "no root is acceptable", i.e. nothing can satisfy this.
 *    Almost certainly a bug (it can never be granted); kept representable so a
 *    tool can detect and flag it rather than silently treating it as "any".
 */
const zAcceptableRootIds = array(string());

/**
 * A desired access entry the participant publishes. Two kinds, mirroring the
 * two discovery-vs-verbatim halves of `hubAccess`:
 *
 *  - `discover` — "find me a service implementing X" (same shape as a
 *    `hubAccess::request` slot). The admin resolves one concrete service.
 *  - `direct`   — "grant exactly these permissions" (same shape as
 *    `hubAccess::requestAccess`). The serviceId is already in each permission's
 *    target; no discovery.
 */
const zManifestRequest = discriminatedUnion('kind', [
    extend(zSlotRequest, {
        kind: literal('discover'),
        /** Who is asking; `principal` is the audience minted caps must target. */
        consumer: zConsumer,
        /** Human rationale shown to the admin ("seal tokens at rest"). */
        reason: optional(string()),
        duration: optional(zDuration),
        /** Root issuer(s) that must mint this cap. See {@link zAcceptableRootIds}. */
        acceptableRootIds: optional(zAcceptableRootIds),
        /**
         * Host-authored provenance bag, stamped at `registerHubAccessAtRoot`
         * (NOT taken from the consumer's request params — so it cannot be
         * spoofed). An open `record<string, unknown>` so a host can attach
         * whatever origin info it observed about the requesting transport (e.g.
         * `{ sourceTransportId }` to route a local consent UI). Meaningful only
         * to a consumer that KNOWS this manifest is local; an aggregating
         * manifest MUST re-scope or omit it.
         */
        origin: optional(record(string(), unknown())),
    }),
    object({
        kind: literal('direct'),
        /** Who is asking; `principal` is the audience minted caps must target. */
        consumer: zConsumer,
        reason: optional(string()),
        permissions: array(zRequestPermission).check(minLength(1)),
        duration: optional(zDuration),
        /** Root issuer(s) that must mint this cap. See {@link zAcceptableRootIds}. */
        acceptableRootIds: optional(zAcceptableRootIds),
        /** Host-authored provenance bag. See the `discover` variant. */
        origin: optional(record(string(), unknown())),
    }),
]);

/**
 * The current (granted) value of one entry. For `discover` it carries the single
 * chosen service (mirroring `hubAccess::request`'s resolved slot) plus the caps;
 * for `direct` just the caps (the serviceId is in each permission's target).
 */
const zGrantedEntry = discriminatedUnion('kind', [
    extend(zResolvedSlot, {
        kind: literal('discover'),
        capabilities: array(zSignedCapability),
    }),
    object({
        kind: literal('direct'),
        capabilities: array(zSignedCapability),
    }),
]);

/**
 * The current value of one entry: `granted` (caps, plus the chosen service for
 * `discover`) or `denied` (with an optional reason). An entry *absent* from the
 * current document is **undecided** — distinct from a terminal `denied`, which
 * lets an approver say "no" (and why) instead of silently withholding.
 */
const zCurrentEntry = discriminatedUnion('status', [
    object({ status: literal('granted'), granted: zGrantedEntry }),
    object({ status: literal('denied'), reason: optional(string()) }),
]);

/**
 * `hubAccessManifest` — the declarative twin of {@link hubAccessInterface}.
 *
 * Where `hubAccess` is the imperative, just-in-time door a consumer *calls* (and
 * the hub serves at the connection root), `hubAccessManifest` is **served by the
 * participant** under its own serviceId, so it appears in `linkrpc.directory::list`
 * — its very presence is the request. A participant publishes its DESIRED access
 * entries (keyed by id, like `request`'s `dependencies`); an admin discovers
 * them via the directory, mints capabilities **with its own identity** (a
 * configured hub capability root), and writes the CURRENT/granted state back via
 * patches. The participant reads the granted entries and attaches the caps to
 * its later calls.
 *
 * Reconcile model (desired vs. current), aligned with the hub's other surfaces:
 *  - `getDesired` / `watchDesired` — the participant's declared needs.
 *  - `getCurrent` / `setCurrent` / `watchCurrent` — the admin-written grants.
 *
 * `watch*` follows the coarse empty-tick convention of `linkrpc.directory::watch`:
 * a tick means "re-`get` now", keeping the server stateless (no per-item deltas).
 */
export const hubAccessManifestInterface = defineInterface(
    {
        id: 'hubAccessManifest',
        description:
            'Participant-served declarative access: publish DESIRED access entries '
            + '(discover | direct), an admin mints capabilities and writes the CURRENT '
            + 'granted state back. The reconcile twin of hubAccess::{request,requestAccess}.',
    },
    {
        // ---- desired (participant-authored; the admin reads) ----------------
        /** The full desired document: who is asking and the entries it wants. */
        getDesired: requestType(
            object({}),
            object({
                /**
                 * entryId → desired entry, each carrying its own `consumer`. A
                 * per-participant manifest's entries all share one consumer; a hub
                 * broker aggregates entries from many consumers in one flat map.
                 */
                requested: record(string(), zManifestRequest),
                /** Bumped whenever `requested` changes; lets watchers dedupe ticks. */
                revision: number(),
            }),
        ),
        /**
         * Coarse change tap on the desired document. Emits an empty tick when
         * `requested` may have changed; the caller re-`getDesired`. Resolves when
         * the caller cancels. Mirrors `linkrpc.directory::watch`.
         */
        watchDesired: requestType(
            object({}),
            object({}),
        ).withStream({ server: object({}) }),

        // ---- current / granted (admin-authored; the participant reads) ------
        /** The full current document: entryId → granted/denied (absent ⇒ undecided). */
        getCurrent: requestType(
            object({}),
            object({
                /** entryId → current value (granted | denied). */
                current: record(string(), zCurrentEntry),
                /** Bumped on every successful `setCurrent`. */
                revision: number(),
            }),
        ),
        /**
         * Apply patches to the current document. Replace the whole document with
         * `{ op: 'set', path: '', value }`, or a single entry with
         * `{ op: 'set', path: '/current/<entryId>', value }` (a `zCurrentEntry`:
         * granted or denied). Admin-only in practice (gated by a capability
         * rooted at an accepted issuer).
         */
        setCurrent: requestType(
            object({ patches: array(zManifestPatch) }),
            object({ revision: number() }),
        ),
        /**
         * Coarse change tap on the current document. Emits an empty tick when
         * `current` may have changed; the participant re-`getCurrent` and applies
         * any new capabilities. Resolves when the caller cancels.
         */
        watchCurrent: requestType(
            object({}),
            object({}),
        ).withStream({ server: object({}) }),
    },
);

/**
 * The typed client shape of {@link hubAccessManifestInterface} — the exact
 * object `connection.get(hubAccessManifestInterface)` (or
 * `connection.service(id).get(...)`) returns. Approvers depend on this contract,
 * not on a concrete connection: the same approver runs against a local in-memory
 * host (loopback connection), a remote hub's served manifest, or a future
 * aggregating implementation with no code change.
 */
export type IHubAccessManifest = InterfaceClient<typeof hubAccessManifestInterface>;

/** One typed entry from `hubAccessManifest::getDesired().requested`. */
export type HubAccessManifestRequest =
    Awaited<ReturnType<IHubAccessManifest['getDesired']>>['requested'][string];

/** One typed value accepted at `/current/<entryId>` by `setCurrent`. */
export type HubAccessManifestDecision =
    Awaited<ReturnType<IHubAccessManifest['getCurrent']>>['current'][string];
