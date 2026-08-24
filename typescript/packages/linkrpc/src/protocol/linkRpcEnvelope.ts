import type { JsonValue } from "./jsonValue";
import type { PrincipalId } from "../crypto/cryptoProvider";
import type { SignedCapability } from "./capability";
import type { JsonRpcNotification, JsonRpcRequest } from "./jsonRpc";
import {
    LINKRPC_META_KEY,
    LINKRPC_SIGNATURE_KEY,
    LINKRPC_UNSIGNED_KEY,
    type Signatures,
} from "./signedObject";

export { LINKRPC_META_KEY, LINKRPC_SIGNATURE_KEY, LINKRPC_UNSIGNED_KEY, type Signatures };

/**
 * Signed call meta. Lives under `params.$linkrpc` so it can't collide with
 * the user's top-level param keys. Present on signed AND unsigned calls
 * (the latter omit {@link CallMeta.principal} and carry no `$linkrpcSignature`).
 *
 * Included verbatim in the bytes a call signature commits to — the
 * signature covers `signingInput("call", { ...userParams, $linkrpc })`.
 */
export interface CallMeta {
    /** Fully-qualified wire method. The verifier asserts it equals the JSON-RPC `method`. */
    readonly method: string;
    /** Replay-protection nonce (base64url). The gate dedups on this. */
    readonly nonce: string;
    /** Unix milliseconds. Skew window enforced by the verifier. */
    readonly signedAtMs: number;
    /** Identity wielding the call. Present iff signed; equals the audience of every presented cap. */
    readonly principal?: PrincipalId;
    /** Optional schema hash assertion. Matched against `TargetPattern.interfaceHash`. */
    readonly interfaceHash?: string;
}

/**
 * Extrinsic, unsigned attachments carried under `params.$linkrpcUnsigned`.
 * Not covered by the call signature (they aren't authored by the signer).
 */
export interface LinkRpcUnsigned {
    /** Caller's presented capability bag. Parents are resolved out of this by hash. */
    readonly capabilities?: readonly SignedCapability[];
}

/** Reserved wire-key meta carried on a linkrpc call's params object. */
export interface LinkRpcWireMeta {
    readonly [LINKRPC_META_KEY]?: CallMeta;
    readonly [LINKRPC_SIGNATURE_KEY]?: Signatures;
    readonly [LINKRPC_UNSIGNED_KEY]?: LinkRpcUnsigned;
}


/**
 * Wire shape of `params` on a linkrpc JSON-RPC call.
 *
 * The user's params object (if any) is spread as-is, with the
 * {@link LinkRpcWireMeta} keys attached on top. `TUserParams` carries the
 * user-visible param shape; defaults to an open object. User params MUST be
 * a plain object — enforced at signing/verification via
 * {@link requireObjectParams}.
 */
export type LinkRpcWireParams<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = TUserParams & LinkRpcWireMeta;

/** JSON-RPC request whose `params` carry the linkrpc wire meta. */
export type LinkRpcJsonRpcRequest<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = JsonRpcRequest<LinkRpcWireParams<TUserParams>>;

/** JSON-RPC notification whose `params` carry the linkrpc wire meta. */
export type LinkRpcJsonRpcNotification<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = JsonRpcNotification<LinkRpcWireParams<TUserParams>>;

/** Either of the two linkrpc-bearing JSON-RPC message shapes. */
export type LinkRpcJsonRpcMessage<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = LinkRpcJsonRpcRequest<TUserParams> | LinkRpcJsonRpcNotification<TUserParams>;

/**
 * The linkrpc signing/cap system accepts only plain-object user params (or
 * none). Reject arrays/primitives at the boundary so "strip `$linkrpc*`, the
 * rest is the signed user params" stays unambiguous.
 */
export function requireObjectParams(
    userParams: JsonValue | undefined,
): Record<string, JsonValue | undefined> {
    if (userParams === undefined) return {};
    if (userParams === null || typeof userParams !== "object" || Array.isArray(userParams)) {
        throw new Error("linkrpc: user params must be a plain JSON object or undefined");
    }
    return userParams as Record<string, JsonValue | undefined>;
}

/**
 * Return the application-authored portion of a LinkRPC params value.
 *
 * Routing and gate layers must continue forwarding the original wire params so
 * every chained hub can independently verify the envelope. Terminal dispatch
 * may use this derived value for application-schema validation without mutating
 * or replacing the wire message.
 */
export function stripLinkRpcWireMeta(wireParams: unknown): JsonValue | undefined {
    if (wireParams === undefined) return undefined;
    if (wireParams === null || typeof wireParams !== "object" || Array.isArray(wireParams)) {
        return wireParams as JsonValue;
    }
    const object = wireParams as Record<string, unknown>;
    const reserved = [LINKRPC_META_KEY, LINKRPC_SIGNATURE_KEY, LINKRPC_UNSIGNED_KEY];
    if (!reserved.some((key) => key in object)) return object as JsonValue;

    const userParams: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
        if (reserved.includes(key)) continue;
        userParams[key] = object[key];
    }
    return userParams as JsonValue;
}
