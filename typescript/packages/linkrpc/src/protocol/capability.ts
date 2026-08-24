/**
 * Capability protocol types and pure (sync, no-crypto) helpers.
 *
 * Wire shapes and the matchers that decide whether a call falls inside a
 * capability's permissions. Anything involving signature verification or
 * private keys lives in `../identity/capability` instead.
 */

import { type PrincipalId } from "../crypto/cryptoProvider";
import { jcsCanonicalize } from "./jcs";
import {
    type Base64Sha256,
    LINKRPC_SIGNATURE_KEY,
    readSignature,
    type Signatures,
} from "./signedObject";

// ---- Types ---------------------------------------------------------------

/**
 * A single axis matcher. Empty prefix matches anything. Non-empty prefix `p`
 * matches `value` iff:
 *   - `value === p`, OR
 *   - `value` starts with `p + delimiter` (delimiter depends on the axis).
 *
 * For axes without a delimiter (`member`), prefix degrades to `startsWith`.
 */
export type Pattern = { exact: string } | { prefix: string };

/**
 * Per-field matcher used by {@link Permission.params}. The set of declared
 * keys is a strict allowlist — a call whose params carry an undeclared key
 * is rejected, so the only way to permit a free value is to say
 * `{ any: true }` explicitly. Values are compared via canonical-JSON
 * equality, so anything JSON-serializable is acceptable.
 *
 * - `exact`    — canonical-JSON equality against a single value.
 * - `enum`     — canonical-JSON equality against any value in the list.
 * - `prefix`   — value MUST be a string and `startsWith(prefix)`. Used to
 *                pin e.g. a URL to a base-path subtree.
 * - `subsetOf` — value MUST be a `string[]` whose every element is in this
 *                set. Order-independent; the empty array is a valid subset.
 *                Used to bound a requested scope set.
 * - `any`      — matches anything (the explicit wildcard).
 */
export type ParamMatcher =
    | { exact: unknown }
    | { enum: unknown[] }
    | { prefix: string }
    | { subsetOf: string[] }
    | { any: true };

/**
 * The exact, point-precision narrowing of a {@link Permission}: it admits
 * **one** signed RPC call — the one whose call content-hash
 * ({@link import("./signedObject").signedHash}`("call", signedCall)`, i.e.
 * `base64url(sha256(jcs({ "linkrpc-sig/v1/call": userParams + $hubrpc })))`)
 * equals `payloadHash`. No field-by-field comparison; pure hash equality.
 * This is the *same bytes the call signature commits to*, so the host can
 * pre-compute it at consent time exactly as the consumer will sign.
 *
 * Because it binds the entire signed payload, `callBind` pins **every**
 * signed field at once — method, user params, `nonce`, `signedAtMs`,
 * `signer`, and `interfaceHash?`. Since the bound bytes include the
 * per-request `nonce`, a `callBind` grant is intrinsically single-use:
 * the request-nonce ledger rejects any replay of the one call it names.
 *
 * Used for "Allow once" flows where the user approved a single concrete call.
 */
export interface CallBind {
    /** Hash algorithm. Currently always "sha256". */
    alg: "sha256";
    /**
     * `signedHash("call", signedCall)` — the SHA-256 of exactly the bytes the
     * RPC signature commits to, for the one call this permission is bound to.
     */
    payloadHash: Base64Sha256;
}

/**
 * The address of a class of calls, expressed as patterns. A
 * {@link CallTarget} is admitted iff every axis pattern admits it.
 */
export interface TargetPattern {
    /** Delimiter `/`. `"github"` matches `"github/repos"` but not `"githubclone"`. */
    serviceId: Pattern;
    /** Delimiter `.`. `"linkrpc"` matches `"linkrpc.directory"` but not `"linkrpcx.foo"`. */
    interfaceId: Pattern;
    /**
     * Optional schema-version pin. When set, the call's asserted
     * `interfaceHash` (carried in `$hubrpc.interfaceHash`) must equal this
     * string. Omit to accept any version.
     */
    interfaceHash?: string;
    /**
     * Any-of: the call's member must match at least one pattern. Empty
     * list matches nothing. `[{ prefix: "" }]` is the universal wildcard.
     */
    members: Pattern[];
}

/**
 * One grant clause of a {@link Capability}. Denotes a set of calls the
 * holder may make, described at up to three zoom levels (coarse → exact):
 *
 *  - `target`   — *which endpoint* (always present);
 *  - `params`   — *which argument values* (optional value allowlist);
 *  - `callBind` — *which exact call* (optional collapse to a single call).
 *
 * The {@link canInvoke}/{@link canDelegate} flags say what the holder may
 * *do* with that set: invoke calls in it, and/or delegate (re-issue a
 * narrowed grant) onward. Both default to `false` (fail closed) — a
 * permission that grants neither admits nothing.
 */
export interface Permission {
    /** Which endpoints this clause talks about. */
    target: TargetPattern;
    /** The holder may invoke calls in the set. Default `false`. */
    canInvoke?: boolean;
    /** The holder may delegate (re-issue a narrowed grant) of the set. Default `false`. */
    canDelegate?: boolean;
    /**
     * Optional value-level narrowing. Strict allowlist by top-level param
     * key: the call's param key-set must equal the declared set; each value
     * must satisfy its matcher. Omit to accept any params.
     */
    params?: Record<string, ParamMatcher>;
    /** Optional collapse to a single exact signed call. See {@link CallBind}. */
    callBind?: CallBind;
}

export interface Capability {
    /** Issuer principal (signer of this cap). */
    issuer: PrincipalId;
    /** Audience principal (holder allowed to wield it). */
    audience: PrincipalId;
    /** What the holder may do. A call is permitted by the cap iff it is permitted by **any** permission. */
    permissions: Permission[];
    /** Unix milliseconds. Absent = never expires. */
    expiresAtMs?: number;
    /**
     * The single parent this cap delegates from, referenced by its content
     * hash (`signedHash("capability", parent)`). Linearized — at most one
     * parent. The parent itself travels out-of-band in the call's
     * `$linkrpcUnsigned.capabilities` bag and is resolved by this hash.
     * Effective authority is the intersection over the chain: a call must be
     * permitted by every link. Absent = this cap is a root.
     */
    parentHash?: Base64Sha256<Capability>;
    /** Per-cap distinguisher (base64url). Identifies the capability for audit/logging. */
    nonce: string;
}

/**
 * A capability with its issuer's signature attached under
 * `$linkrpcSignature.capability`. It IS a {@link Capability} (the fields are
 * top-level) plus the signature map — no separate wrapper object. The
 * signature commits to `signingInput("capability", cap)`, i.e. the cap with
 * `$linkrpcSignature`/`$linkrpcUnsigned` stripped.
 */
export type SignedCapability = Capability & {
    readonly [LINKRPC_SIGNATURE_KEY]: Signatures;
};

/**
 * Structural wire-shape check for an untrusted signed capability. This does
 * not establish authenticity; callers must still verify its signature and
 * delegation chain.
 */
export function hasSignedCapabilityShape(value: unknown): value is SignedCapability {
    if (!_isRecord(value)) return false;
    if (
        typeof value.issuer !== "string" ||
        typeof value.audience !== "string" ||
        typeof value.nonce !== "string" ||
        !Array.isArray(value.permissions) ||
        !value.permissions.every(_hasPermissionShape) ||
        (value.expiresAtMs !== undefined && typeof value.expiresAtMs !== "number") ||
        (value.parentHash !== undefined && typeof value.parentHash !== "string")
    ) {
        return false;
    }
    return readSignature(value, "capability") !== undefined;
}

/**
 * The address of a concrete call — *which endpoint*, with no arguments.
 * This is what {@link TargetPattern} matches against. The full concrete
 * call (with params/nonce/signer/bytes) is `Call` in `identity/capability`.
 */
export interface CallTarget {
    serviceId: string;
    interfaceId: string;
    member: string;
    /**
     * Schema-version assertion the caller stamps from its compile-time
     * knowledge of the interface (typed clients use `iface.schemaHash`).
     * Compared against `TargetPattern.interfaceHash` by the matcher. Absent
     * means the caller didn't pin a version — the matcher then requires
     * `target.interfaceHash` to also be absent.
     */
    interfaceHash?: string;
}

function _hasPermissionShape(value: unknown): value is Permission {
    if (!_isRecord(value) || !_isRecord(value.target)) return false;
    const target = value.target;
    if (
        !_hasPatternShape(target.serviceId) ||
        !_hasPatternShape(target.interfaceId) ||
        !Array.isArray(target.members) ||
        !target.members.every(_hasPatternShape) ||
        (target.interfaceHash !== undefined && typeof target.interfaceHash !== "string") ||
        (value.canInvoke !== undefined && typeof value.canInvoke !== "boolean") ||
        (value.canDelegate !== undefined && typeof value.canDelegate !== "boolean")
    ) {
        return false;
    }
    if (value.params !== undefined) {
        if (!_isRecord(value.params) || !Object.values(value.params).every(_hasParamMatcherShape)) {
            return false;
        }
    }
    if (value.callBind !== undefined) {
        if (
            !_isRecord(value.callBind) ||
            value.callBind.alg !== "sha256" ||
            typeof value.callBind.payloadHash !== "string"
        ) {
            return false;
        }
    }
    return true;
}

function _hasPatternShape(value: unknown): value is Pattern {
    if (!_isRecord(value)) return false;
    return ("exact" in value && typeof value.exact === "string") ||
        ("prefix" in value && typeof value.prefix === "string");
}

function _hasParamMatcherShape(value: unknown): value is ParamMatcher {
    if (!_isRecord(value)) return false;
    if ("exact" in value) return true;
    if ("enum" in value) return Array.isArray(value.enum);
    if ("prefix" in value) return typeof value.prefix === "string";
    if ("subsetOf" in value) {
        return Array.isArray(value.subsetOf) && value.subsetOf.every((item) => typeof item === "string");
    }
    return value.any === true;
}

function _isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---- addressing matchers (synchronous, pure) -----------------------------

/**
 * Addressing match for a single permission: do its
 * `serviceId`/`interfaceId`/`interfaceHash`/`members` patterns admit
 * `target`?
 */
export function permissionMatchesTarget(target: CallTarget, perm: Permission): boolean {
    return _targetMismatchReason(target, perm) === undefined;
}

type TargetMismatch =
    | { kind: "serviceId"; actual: string; expected: Pattern }
    | { kind: "interfaceId"; actual: string; expected: Pattern }
    | { kind: "interfaceHash"; actual: string | undefined; expected: string }
    | { kind: "invalidMembers" }
    | { kind: "member"; actual: string; expected: Pattern[] };

class TargetMismatchReason {
    constructor(readonly mismatch: TargetMismatch) {}

    toString(): string {
        const mismatch = this.mismatch;
        switch (mismatch.kind) {
            case "serviceId":
            case "interfaceId":
                return `${mismatch.kind} ${JSON.stringify(mismatch.actual)} does not match ${_formatPattern(mismatch.expected)}`;
            case "interfaceHash": {
                const actual = mismatch.actual === undefined ? "<none>" : JSON.stringify(mismatch.actual);
                return `interfaceHash ${actual} does not match required ${JSON.stringify(mismatch.expected)}`;
            }
            case "invalidMembers":
                return "permission target has invalid members";
            case "member": {
                const allowed = mismatch.expected.map(_formatPattern).join(", ") || "<none>";
                return `member ${JSON.stringify(mismatch.actual)} does not match allowed patterns [${allowed}]`;
            }
        }
    }
}

function _targetMismatchReason(target: CallTarget, perm: Permission): TargetMismatchReason | undefined {
    const t = perm.target;
    if (!_patternMatches(target.serviceId, t.serviceId, "/")) {
        return new TargetMismatchReason({
            kind: "serviceId",
            actual: target.serviceId,
            expected: t.serviceId,
        });
    }
    if (!_patternMatches(target.interfaceId, t.interfaceId, ".")) {
        return new TargetMismatchReason({
            kind: "interfaceId",
            actual: target.interfaceId,
            expected: t.interfaceId,
        });
    }
    if (t.interfaceHash !== undefined && target.interfaceHash !== t.interfaceHash) {
        return new TargetMismatchReason({
            kind: "interfaceHash",
            actual: target.interfaceHash,
            expected: t.interfaceHash,
        });
    }
    // Defense-in-depth: an upstream issuer that bypasses schema validation can
    // produce caps whose permissions omit `members`. Treat as a non-match
    // rather than crashing on `.some` of undefined.
    if (!Array.isArray(t.members)) {
        return new TargetMismatchReason({ kind: "invalidMembers" });
    }
    if (!t.members.some((m) => _patternMatches(target.member, m, ""))) {
        return new TargetMismatchReason({
            kind: "member",
            actual: target.member,
            expected: t.members,
        });
    }
    return undefined;
}

function _patternMatches(value: string, pat: Pattern, delim: string): boolean {
    if ("exact" in pat) return value === pat.exact;
    const p = pat.prefix;
    if (p === "") return true;
    if (value === p) return true;
    if (delim === "") return value.startsWith(p);
    return value.startsWith(p + delim);
}

function _formatPattern(pattern: Pattern): string {
    return "exact" in pattern
        ? `exact ${JSON.stringify(pattern.exact)}`
        : `prefix ${JSON.stringify(pattern.prefix)}`;
}

// ---- pure param-allowlist matcher ----------------------------------------

/**
 * Strict allowlist match for {@link Permission.params}. The set of
 * top-level keys in the call MUST equal the declared set; values must
 * satisfy their matchers. Nested objects/arrays are compared as opaque
 * JSON values via canonical-JSON equality. Pure (no crypto).
 */
export function matchParams(
    declared: Record<string, ParamMatcher>,
    actualParams: unknown,
): { ok: true } | { ok: false; reason: string } {
    const declaredKeys = Object.keys(declared).sort();
    const actualObj =
        actualParams !== null && typeof actualParams === "object" && !Array.isArray(actualParams)
            ? (actualParams as Record<string, unknown>)
            : undefined;
    const actualKeys = actualObj ? Object.keys(actualObj).sort() : [];
    if (
        declaredKeys.length !== actualKeys.length ||
        declaredKeys.some((k, i) => k !== actualKeys[i])
    ) {
        return {
            ok: false,
            reason: `param keys mismatch (declared=${declaredKeys.join(",")}, actual=${actualKeys.join(",")})`,
        };
    }
    for (const k of declaredKeys) {
        if (!_matchParamValue(declared[k], actualObj![k])) {
            return { ok: false, reason: `param "${k}" does not match` };
        }
    }
    return { ok: true };
}

function _matchParamValue(matcher: ParamMatcher, value: unknown): boolean {
    if ("any" in matcher) return true;
    if ("prefix" in matcher) {
        return typeof value === "string" && value.startsWith(matcher.prefix);
    }
    if ("subsetOf" in matcher) {
        return (
            Array.isArray(value) &&
            value.every((v) => typeof v === "string" && matcher.subsetOf.includes(v))
        );
    }
    if ("exact" in matcher) {
        return jcsCanonicalize(matcher.exact) === jcsCanonicalize(value);
    }
    if ("enum" in matcher) {
        const v = jcsCanonicalize(value);
        return matcher.enum.some((opt) => jcsCanonicalize(opt) === v);
    }
    return false;
}


/** What a holder may do with a permission's call-set. */
export type Ability = "invoke" | "delegate";


/**
 * A concrete, authenticated RPC call — the thing {@link permits} judges.
 * It is the call's {@link CallTarget} (which endpoint) plus the arguments
 * and the authenticated request metadata. Built by `verifyCall` from a
 * signed wire envelope.
 */
export interface Call {
    /** Which endpoint is being called. */
    target: CallTarget;
    /** User params with identity envelopes stripped. */
    params: unknown;
    /** Per-request replay nonce (the unit the gate dedups on). */
    nonce: string;
    /** Unix milliseconds the call was signed. */
    signedAtMs: number;
    /** The authenticated signer — must equal the leaf capability's audience. */
    signer: PrincipalId;
    /** The call's content hash (`signedHash("call", signedCall)`) — what `callBind` compares against. */
    callHash: Base64Sha256;
}

type Verdict = { ok: true } | { ok: false; reason: string };

// ---- membership: does a call fall inside a permission / capability? ------

/**
 * Does `permission` admit `call` for the given `ability`? Checks, in
 * order: the ability flag (`canInvoke`/`canDelegate`, both default
 * `false`), the target address, the optional `params` allowlist, and the
 * optional `callBind` hash-binding. Pure.
 */
export function permissionPermits(call: Call, permission: Permission, ability: Ability): Verdict {
    const granted = ability === "invoke" ? permission.canInvoke === true : permission.canDelegate === true;
    if (!granted) return { ok: false, reason: `permission does not grant ${ability}` };
    const targetMismatch = _targetMismatchReason(call.target, permission);
    if (targetMismatch !== undefined) {
        return {
            ok: false,
            reason: `permission does not address this call: ${targetMismatch.toString()}`,
        };
    }
    if (permission.params !== undefined) {
        const r = matchParams(permission.params, call.params);
        if (!r.ok) return { ok: false, reason: `params: ${r.reason}` };
    }
    if (permission.callBind !== undefined) {
        if (permission.callBind.alg !== "sha256") {
            return { ok: false, reason: `callBind: unsupported hash alg (${permission.callBind.alg})` };
        }
        if (call.callHash !== permission.callBind.payloadHash) {
            return { ok: false, reason: "callBind: payload hash mismatch" };
        }
    }
    return { ok: true };
}

/**
 * Does `cap` admit `call` for the given `ability`? True iff **any** of its
 * permissions does (the union over permissions). This is one *link's*
 * judgment; chain intersection is enforced by {@link verifyChain}.
 */
export function capabilityPermits(call: Call, cap: Capability, ability: Ability): Verdict {
    let lastReason = `no permission grants ${ability} for this call`;
    for (const permission of cap.permissions) {
        const r = permissionPermits(call, permission, ability);
        if (r.ok) return { ok: true };
        lastReason = r.reason;
    }
    return { ok: false, reason: lastReason };
}
