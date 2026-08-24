import type { JsonValue } from "./jsonValue";
import type { PrincipalId } from "../crypto/cryptoProvider";
import type { SignedCapability } from "./capability";
import type { JsonRpcNotification, JsonRpcRequest } from "./jsonRpc";
import {
    HUBRPC_META_KEY,
    HUBRPC_SIGNATURE_KEY,
    HUBRPC_UNSIGNED_KEY,
    type Signatures,
} from "./signedObject";

export { HUBRPC_META_KEY, HUBRPC_SIGNATURE_KEY, HUBRPC_UNSIGNED_KEY, type Signatures };

/**
 * Signed call meta. Lives under `params.$hubrpc` so it can't collide with
 * the user's top-level param keys. Present on signed AND unsigned calls
 * (the latter omit {@link CallMeta.principal} and carry no `$hubrpcSignature`).
 *
 * Included verbatim in the bytes a call signature commits to — the
 * signature covers `signingInput("call", { ...userParams, $hubrpc })`.
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
 * Extrinsic, unsigned attachments carried under `params.$hubrpcUnsigned`.
 * Not covered by the call signature (they aren't authored by the signer).
 */
export interface HubRpcUnsigned {
    /** Caller's presented capability bag. Parents are resolved out of this by hash. */
    readonly capabilities?: readonly SignedCapability[];
}

/** Reserved wire-key meta carried on a hubrpc call's params object. */
export interface HubRpcWireMeta {
    readonly [HUBRPC_META_KEY]?: CallMeta;
    readonly [HUBRPC_SIGNATURE_KEY]?: Signatures;
    readonly [HUBRPC_UNSIGNED_KEY]?: HubRpcUnsigned;
}


/**
 * Wire shape of `params` on a hubrpc JSON-RPC call.
 *
 * The user's params object (if any) is spread as-is, with the
 * {@link HubRpcWireMeta} keys attached on top. `TUserParams` carries the
 * user-visible param shape; defaults to an open object. User params MUST be
 * a plain object — enforced at signing/verification via
 * {@link requireObjectParams}.
 */
export type HubRpcWireParams<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = TUserParams & HubRpcWireMeta;

/** JSON-RPC request whose `params` carry the hubrpc wire meta. */
export type HubRpcJsonRpcRequest<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = JsonRpcRequest<HubRpcWireParams<TUserParams>>;

/** JSON-RPC notification whose `params` carry the hubrpc wire meta. */
export type HubRpcJsonRpcNotification<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = JsonRpcNotification<HubRpcWireParams<TUserParams>>;

/** Either of the two hubrpc-bearing JSON-RPC message shapes. */
export type HubRpcJsonRpcMessage<
    TUserParams extends { [key: string]: JsonValue | undefined } = { [key: string]: JsonValue | undefined },
> = HubRpcJsonRpcRequest<TUserParams> | HubRpcJsonRpcNotification<TUserParams>;

/**
 * The hubrpc signing/cap system accepts only plain-object user params (or
 * none). Reject arrays/primitives at the boundary so "strip `$hubrpc*`, the
 * rest is the signed user params" stays unambiguous.
 */
export function requireObjectParams(
    userParams: JsonValue | undefined,
): Record<string, JsonValue | undefined> {
    if (userParams === undefined) return {};
    if (userParams === null || typeof userParams !== "object" || Array.isArray(userParams)) {
        throw new Error("hubrpc: user params must be a plain JSON object or undefined");
    }
    return userParams as Record<string, JsonValue | undefined>;
}

/**
 * Return the application-authored portion of a HubRPC params value.
 *
 * Routing and gate layers must continue forwarding the original wire params so
 * every chained hub can independently verify the envelope. Terminal dispatch
 * may use this derived value for application-schema validation without mutating
 * or replacing the wire message.
 */
export function stripHubRpcWireMeta(wireParams: unknown): JsonValue | undefined {
    if (wireParams === undefined) return undefined;
    if (wireParams === null || typeof wireParams !== "object" || Array.isArray(wireParams)) {
        return wireParams as JsonValue;
    }
    const object = wireParams as Record<string, unknown>;
    const reserved = [HUBRPC_META_KEY, HUBRPC_SIGNATURE_KEY, HUBRPC_UNSIGNED_KEY];
    if (!reserved.some((key) => key in object)) return object as JsonValue;

    const userParams: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
        if (reserved.includes(key)) continue;
        userParams[key] = object[key];
    }
    return userParams as JsonValue;
}
