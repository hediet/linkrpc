/**
 * Capability **semantics**: the authorization layer over the pure
 * protocol syntax in `../protocol/capability`. This module answers the
 * single question "may this concrete signed call proceed?" via
 * {@link permits}, built from the chain verifier {@link verifyChain} and
 * the membership predicate {@link capabilityPermits}. Signing lives here
 * too, since it needs a {@link SigningIdentity}.
 */

import {
    bytesToBase64Url,
    resolveSigningKey,
    type PrincipalId,
} from "../crypto/cryptoProvider";
import {
    Call,
    capabilityPermits,
    hasSignedCapabilityShape,
    type Capability, type ParamMatcher, type Permission, type SignedCapability
} from "../protocol/capability";
import { signObject, signedHash, verifyObject, readSignature } from "./signedObject";
import type { InterfaceDefinition, MemberMap } from "../connection/interfaceDefinition";
import type { RequestType } from "../schema/memberTypes";
import type { PublicSigningIdentity, SigningIdentity } from "./identity";

// Re-export protocol-level types and pure helpers so existing consumers
// keep working through `@vscode/hubrpc`'s identity barrel.
export {
    permissionMatchesTarget,
    matchParams,
    type Call,
    type CallBind,
    type CallTarget,
    type Capability,
    type ParamMatcher,
    type Pattern,
    type Permission,
    type SignedCapability,
    type TargetPattern,
} from "../protocol/capability";
export { type Base64Sha256, signedHash } from "../protocol/signedObject";


// ---- freshness -----------------------------------------------------------

/**
 * Pure freshness check for a single capability link: `true` when the cap never
 * expires, or its `expiresAtMs` is still in the future at `now + marginMs`.
 *
 * Mirrors the gate's expiry rule in {@link verifyChain}'s link check
 * (`expiresAtMs < nowMs` ⇒ expired) so a producer can decide, *before signing*,
 * whether to re-acquire a cap rather than attach one the gate will reject as
 * `expired`. The `marginMs` safety window absorbs in-flight transit time and
 * client/hub clock skew — pass the call's `signedAtMs` as `now` so the check
 * evaluates expiry against the same instant baked into the envelope.
 *
 * This checks ONE link. Effective authority requires every link in a
 * delegation chain to be unexpired, so a producer attaching a bag should apply
 * this to every cap it would attach (see {@link capBagFreshAt}).
 */
export function capabilityFreshAt(
    cap: Capability,
    now: number,
    marginMs = 0,
): boolean {
    return cap.expiresAtMs === undefined || cap.expiresAtMs > now + marginMs;
}

/**
 * Freshness over a whole presented bag: `true` only when every cap is fresh at
 * `now + marginMs` (see {@link capabilityFreshAt}). An empty bag is trivially
 * fresh. Use this at the cap-production point to decide whether to re-acquire.
 */
export function capBagFreshAt(
    caps: readonly Capability[],
    now: number,
    marginMs = 0,
): boolean {
    return caps.every((cap) => capabilityFreshAt(cap, now, marginMs));
}


// ---- chain verification --------------------------------------------------

/** Result of {@link verifyChain}; not part of the public API ({@link permits} is). */
type ChainResult =
    | { ok: true; rootIssuer: PrincipalId; leafNonce: string }
    | { ok: false; reason: string; verifiedRootIssuer?: PrincipalId };

type LinkResult =
    | { ok: true; rootIssuer: PrincipalId }
    | { ok: false; reason: string };

/** Options for {@link verifyChain}; not part of the public API ({@link permits} is). */
interface VerifyChainOptions {
    /** The leaf cap's `audience` must equal this. Usually the signer of the request. */
    expectedAudience: PrincipalId;
    /** Unix milliseconds. */
    nowMs: number;
    /**
     * Optional terminal trust check. A chain only succeeds if its root issuer
     * passes; when it does not, the verifier keeps trying other presented
     * leaves. This lets a caller present several capabilities (e.g. a
     * self-issued one and an admin-issued one) and have the trusted chain win.
     */
    acceptRoot?: (rootIssuer: PrincipalId) => boolean;
    /** Hard cap on recursion to bound work and prevent cycles. */
    maxDepth?: number;
}

/**
 * Verify that some delegation chain among the presented `capabilities`
 * authorizes `call`, and return the issuer at its top (the trust anchor the
 * caller then judges). The bag's topology is inferred: any capability whose
 * `audience` is the caller is tried as a leaf, and parents are resolved out
 * of the same bag by content hash (`parentHash`).
 *
 * Each link must be authentic (signature), unexpired, and bound to the next
 * link's issuer; the **leaf** must grant `invoke` for the call and every
 * **parent** must grant `delegate`. Effective authority is therefore the
 * intersection over the chain — a delegate can only narrow.
 *
 * @internal Chain *authenticity* only — it makes **no** trust decision. The
 * public authorization entry point is {@link permits}, which layers the
 * accepted-root policy on top.
 */
async function verifyChain(
    capabilities: readonly SignedCapability[],
    call: Call,
    opts: VerifyChainOptions,
): Promise<ChainResult> {
    // Content-address the bag once; parents resolve out of it by hash.
    const byHash = new Map<string, SignedCapability>();
    for (const c of capabilities) byHash.set(signedHash("capability", c), c);
    const resolveParent = (h: string) => byHash.get(h);
    const maxDepth = opts.maxDepth ?? 16;

    // Try each presented capability as a leaf. The reason we surface on total
    // failure prefers a cap the caller actually holds (audience === caller),
    // so a single rejected cap reports *its* fault rather than "no leaf".
    let leafReason: string | undefined;
    let anyReason = "no presented capability addresses this call";
    let unacceptedRoot: PrincipalId | undefined;
    for (const leaf of capabilities) {
        const r = await _verifyLink(leaf, call, opts.expectedAudience, opts.nowMs, maxDepth, true, resolveParent);
        if (!r.ok) {
            anyReason = r.reason;
            if (leaf.audience === opts.expectedAudience) leafReason = r.reason;
            continue;
        }
        if (opts.acceptRoot !== undefined && !opts.acceptRoot(r.rootIssuer)) {
            unacceptedRoot = r.rootIssuer;
            continue;
        }
        return { ok: true, rootIssuer: r.rootIssuer, leafNonce: leaf.nonce };
    }
    if (unacceptedRoot !== undefined) {
        return { ok: false, reason: "no chain roots at an accepted issuer", verifiedRootIssuer: unacceptedRoot };
    }
    return { ok: false, reason: leafReason ?? anyReason };
}

async function _verifyLink(
    link: SignedCapability,
    call: Call,
    expectedAudience: PrincipalId,
    nowMs: number,
    depthLeft: number,
    isLeaf: boolean,
    resolveParent: (parentHash: string) => SignedCapability | undefined,
): Promise<LinkResult> {
    if (depthLeft <= 0) return { ok: false, reason: "chain too deep" };

    if (link.audience !== expectedAudience) {
        return { ok: false, reason: `audience mismatch (expected ${expectedAudience}, got ${link.audience})` };
    }
    if (link.expiresAtMs !== undefined && link.expiresAtMs < nowMs) {
        return { ok: false, reason: "expired" };
    }
    const permitted = capabilityPermits(call, link, isLeaf ? "invoke" : "delegate");
    if (!permitted.ok) {
        return { ok: false, reason: permitted.reason };
    }

    let issuerKey: Uint8Array;
    const resolved = resolveSigningKey({
        principal: link.issuer,
        keyId: readSignature(link, "capability")?.keyId ?? "",
        timeMs: nowMs,
    });
    if (resolved === undefined) {
        return { ok: false, reason: "unresolvable issuer key" };
    }
    issuerKey = resolved.publicKey;
    const sigOk = await verifyObject("capability", link, issuerKey);
    if (!sigOk) return { ok: false, reason: "bad signature" };

    if (link.parentHash === undefined) {
        return { ok: true, rootIssuer: link.issuer };
    }

    const parent = resolveParent(link.parentHash);
    if (parent === undefined) {
        return { ok: false, reason: "parent capability not presented" };
    }
    if (signedHash("capability", parent) !== link.parentHash) {
        return { ok: false, reason: "parent hash mismatch" };
    }
    return _verifyLink(parent, call, link.issuer, nowMs, depthLeft - 1, false, resolveParent);
}

// ---- authorization: the single entry point -------------------------------

export type PermitResult =
    | { ok: true; capabilityNonce: string; rootIssuer: PrincipalId }
    | { ok: false; reason: string };

/**
 * A trust anchor accepted as a capability-chain root, plus whether it may be
 * named in authorization error messages.
 */
export interface AcceptedRootIssuer {
    /** The principal accepted as a chain root for the queried service. */
    principal: PrincipalId;
    /**
     * Whether this issuer may be disclosed in `permits` rejection reasons.
     * Public anchors (e.g. a hub's well-known admin identity) are surfaced to
     * help diagnose "wrong root" failures; private ones are withheld so the
     * error never leaks the set of trusted issuers.
     */
    isPublic: boolean;
}

/**
 * **The** authorization predicate. A call is permitted iff some presented
 * capability (1) addresses the call, (2) has a genuine, well-delegated
 * chain whose leaf audience is the caller (`call.signer`), and (3) roots
 * at an issuer the verifier accepts **for the call's service**.
 *
 * Pure: it reports the verdict (and the `capabilityNonce` / `rootIssuer`
 * for audit) but performs no consumption. Replay is the caller's job — the
 * gate dedups `call.nonce`, so `callBind` grants are single-use for free.
 *
 * `acceptedRootIssuers` is consulted with the call's `serviceId` and returns
 * the accepted {@link AcceptedRootIssuer} anchors; an empty result rejects
 * every capability (fail closed) — trust is the verifier's, never the
 * token's. Anchors flagged `isPublic` are named in the rejection reason when
 * a chain roots at an unaccepted issuer.
 */
export async function permits(
    call: Call,
    capabilities: readonly SignedCapability[],
    acceptedRootIssuers: (serviceId: string) => readonly AcceptedRootIssuer[],
    nowMs: number,
    opts?: { maxDepth?: number },
): Promise<PermitResult> {
    if (capabilities.length === 0) {
        return { ok: false, reason: "no capabilities were presented with this call" };
    }
    if (!capabilities.every(hasSignedCapabilityShape)) {
        return { ok: false, reason: "malformed capability" };
    }

    const accepted = acceptedRootIssuers(call.target.serviceId);
    const acceptedIds = new Set(accepted.map((a) => a.principal));
    const chain = await verifyChain(capabilities, call, {
        expectedAudience: call.signer,
        nowMs,
        acceptRoot: (rootIssuer) => acceptedIds.has(rootIssuer),
        ...(opts?.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    });
    if (chain.ok) {
        return { ok: true, capabilityNonce: chain.leafNonce, rootIssuer: chain.rootIssuer };
    }
    if (chain.verifiedRootIssuer !== undefined) {
        return { ok: false, reason: _rootIssuerRejectedReason(call.target.serviceId, chain.verifiedRootIssuer, accepted) };
    }
    return { ok: false, reason: chain.reason };
}

/**
 * Reason string for a chain that verified but rooted at an unaccepted issuer.
 * Names the (caller-owned) `rootIssuer` it actually rooted at, plus the
 * `isPublic` accepted anchors to point the caller at the right root.
 */
function _rootIssuerRejectedReason(
    serviceId: string,
    rootIssuer: PrincipalId,
    accepted: readonly AcceptedRootIssuer[],
): string {
    const head = `capability root issuer ${rootIssuer} is not accepted for service "${serviceId}"`;
    if (accepted.length === 0) {
        return `${head} (no root issuers are accepted for this service)`;
    }
    const publicIds = accepted.filter((a) => a.isPublic).map((a) => a.principal);
    if (publicIds.length === 0) {
        return head;
    }
    return `${head}; accepted root issuer(s): ${publicIds.join(", ")}`;
}

// ---- signing ------------------------------------------------------------

/**
 * Sign a `Capability` with a {@link SigningIdentity}. The private key never
 * leaves the identity. The result verifies via {@link verifyChain}.
 */
export async function signCapability(capability: Capability, issuer: SigningIdentity): Promise<SignedCapability> {
    return await signObject("capability", capability, issuer);
}

export interface IssueCapabilityOptions {
    /** Identity allowed to present the capability. */
    readonly audience: PublicSigningIdentity;
    /** Authority granted to the audience. */
    readonly permissions: readonly Permission[];
    /** Optional expiration time as Unix milliseconds. */
    readonly expiresAtMs?: number;
    /** Optional parent whose authority this capability narrows. */
    readonly parent?: SignedCapability;
}

/**
 * Issue and sign a capability, deriving its issuer, nonce, and optional parent
 * hash. The result is plain JSON data and survives a JSON stringify/parse
 * round-trip without reconstruction.
 */
export async function issueCapability(
    issuer: SigningIdentity,
    options: IssueCapabilityOptions,
): Promise<SignedCapability> {
    const capability: Capability = {
        issuer: issuer.publicSigningIdentity.principal,
        audience: options.audience.principal,
        permissions: [...options.permissions],
        nonce: _randomCapabilityNonce(),
        ...(options.expiresAtMs !== undefined ? { expiresAtMs: options.expiresAtMs } : {}),
        ...(options.parent !== undefined
            ? { parentHash: signedHash("capability", options.parent) }
            : {}),
    };
    return signCapability(capability, issuer);
}

export type ParamMatcherFor<T> =
    | { exact: T }
    | { enum: T[] }
    | { any: true }
    | (T extends string ? { prefix: string } : never)
    | (T extends readonly string[] ? { subsetOf: string[] } : never);

/** Type-safe top-level parameter matchers for one interface member. */
export type ParamMatchers<T> = T extends Record<string, unknown>
    ? { [K in keyof T]: ParamMatcherFor<Exclude<T[K], undefined>> }
    : never;

type RequestMemberName<TMembers extends MemberMap> = {
    [K in keyof TMembers]: TMembers[K] extends RequestType<any, any, any, any, any> ? K : never;
}[keyof TMembers] & string;

type RequestParams<TMember> = TMember extends RequestType<infer TParams, any, any, any, any>
    ? TParams
    : never;

/** Match a string parameter by prefix. */
export function prefix(value: string): { prefix: string } {
    return { prefix: value };
}

/**
 * Build an invoke permission from a typed interface member. The helper derives
 * the interface id and schema hash and type-checks parameter matcher names and
 * values against the member's params.
 */
export function invoke<
    TMembers extends MemberMap,
    TMember extends RequestMemberName<TMembers>,
>(
    serviceId: string,
    iface: InterfaceDefinition<TMembers>,
    member: TMember,
    params?: ParamMatchers<RequestParams<TMembers[TMember]>>,
): Permission {
    return {
        target: {
            serviceId: { exact: serviceId },
            interfaceId: { exact: iface.info.id },
            interfaceHash: iface.schemaHash,
            members: [{ exact: member }],
        },
        canInvoke: true,
        ...(params !== undefined
            ? { params: params as Record<string, ParamMatcher> }
            : {}),
    };
}

function _randomCapabilityNonce(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
}
