import type { PrincipalId } from "../crypto/cryptoProvider";
import type { SigningIdentity } from "./identity";
import {
    type Call,
    type CallTarget,
    type SignedCapability,
} from "./capability";
import type { Base64Sha256 } from "../protocol/signedObject";
import type { JsonValue } from "../protocol/jsonValue";
import {
    LINKRPC_META_KEY,
    LINKRPC_SIGNATURE_KEY,
    LINKRPC_UNSIGNED_KEY,
    attachCapabilities,
    signRpcCall,
    verifyRpcCall,
} from "./signedRpcEnvelope";
import type { CallMeta } from "../protocol/linkRpcEnvelope";

export { attachCapabilities };

/** Plain JSON object with optional values — the wire shape JSON-RPC params take. */
export type JsonObject = { [key: string]: JsonValue | undefined };

// ---- signing -----------------------------------------------------------

export interface SignParamsOptions {
    method: string;
    /** Caller-supplied params (without identity envelopes). Must be an object or undefined. */
    params: JsonObject | undefined;
    /** Identity that produces the signature. */
    signingIdentity: SigningIdentity;
    /**
     * Caps to attach. They are NOT signed — they ride in `$linkrpcUnsigned`.
     */
    capabilities?: readonly SignedCapability[];
    /** Unix milliseconds; defaults to `Date.now()`. */
    nowMs?: number;
    /** Override nonce (testing); otherwise 16 random bytes. */
    nonce?: Uint8Array;
    /** Stamped into the signed envelope as `interfaceHash`. */
    interfaceHash?: string;
}

/**
 * Returns a wire-form params object carrying the `$hubrpc` envelope, the
 * `call` signature under `$linkrpcSignature`, and (optionally) capabilities
 * under `$linkrpcUnsigned`.
 */
export async function signParams(opts: SignParamsOptions): Promise<JsonObject> {
    if (opts.params !== undefined
        && (typeof opts.params !== "object" || Array.isArray(opts.params))) {
        throw new Error("signParams: params must be an object or undefined");
    }
    const signed = await signRpcCall({
        method: opts.method,
        params: (opts.params ?? undefined) as JsonValue | undefined,
        signingIdentity: opts.signingIdentity,
        ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
        ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
        ...(opts.interfaceHash !== undefined ? { interfaceHash: opts.interfaceHash } : {}),
    });
    const wireParams = opts.capabilities && opts.capabilities.length > 0
        ? attachCapabilities(signed.wireParams, opts.capabilities)
        : signed.wireParams;
    return wireParams as unknown as JsonObject;
}

// ---- verification ------------------------------------------------------

export interface VerifyCallOptions {
    method: string;
    /** Raw params as received on the wire. Carries `$hubrpc` + `$linkrpcSignature` when signed. */
    params: unknown;
    /** Decode the method string into the call's target address. */
    parseMethod: (method: string) => CallTarget;
    nowMs?: number;
    /** Max clock skew in milliseconds. Default 300000 (±5min). */
    maxSkewMs?: number;
    /** Reject if no capability is presented. */
    requireCapability?: boolean;
}

export type VerifyResult =
    | {
        ok: true;
        signer: PrincipalId;
        /**
         * The resolved, authenticated call — the unit `permits()` judges.
         * Authorization is intentionally NOT done here; the gate owns it
         * (and the replay ledger).
         */
        call: Call;
        /** Params with the reserved keys stripped — pass this to the actual handler. */
        strippedParams: Record<string, unknown> | undefined;
        /** Leaf + parent capabilities to hand to `permits()`. */
        capabilities: SignedCapability[];
        /** Per-call nonce extracted from the envelope (for replay-protection ledgers). */
        nonce: string;
        /** The call's content hash — input to `callBind.payloadHash`. */
        callHash: Base64Sha256;
        /** The `$hubrpc` envelope as received. */
        callMeta: CallMeta;
        /** Schema-version assertion the caller stamped. */
        interfaceHash: string | undefined;
    }
    | {
        ok: false;
        /**
         * Failure category:
         *  - `"capability"` — the call shape was fine; the caller needs to
         *    acquire (or present) a capability. Hub should surface this as
         *    `permissionRequired` so consumers know to negotiate access.
         *  - `"envelope"` — anything else (missing/bad signature, replay,
         *    malformed nonce, etc). Hub should surface as `invalidRequest`.
         */
        kind: "capability" | "envelope";
        reason: string;
    };

export async function verifyCall(opts: VerifyCallOptions): Promise<VerifyResult> {
    const res = await verifyRpcCall({
        wireMethod: opts.method,
        wireParams: opts.params,
        ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
        ...(opts.maxSkewMs !== undefined ? { maxSkewMs: opts.maxSkewMs } : {}),
        requireSigned: opts.requireCapability === true,
    });
    if (!res.ok) return { ok: false, kind: "envelope", reason: res.reason };
    if (!res.identity) {
        return { ok: false, kind: "envelope", reason: "missing identity envelope" };
    }
    const { identity } = res;

    if (opts.requireCapability && identity.capabilities.length === 0) {
        return { ok: false, kind: "capability", reason: "capability required but none provided" };
    }

    const params = res.params;
    let strippedParams: Record<string, unknown> | undefined;
    if (params === undefined || params === null) {
        strippedParams = undefined;
    } else if (typeof params === "object" && !Array.isArray(params)) {
        // Preserve `{}` — a handler whose schema is `z.object({...})` (no
        // required fields) accepts `{}` but rejects `undefined`.
        strippedParams = params as Record<string, unknown>;
    } else {
        // Non-object params: callers expect Record<string, unknown> | undefined.
        strippedParams = undefined;
    }

    const target = opts.parseMethod(opts.method);
    if (identity.callMeta.interfaceHash !== undefined) {
        target.interfaceHash = identity.callMeta.interfaceHash;
    }
    const call: Call = {
        target,
        params,
        nonce: identity.callMeta.nonce,
        signedAtMs: identity.callMeta.signedAtMs,
        signer: identity.signer,
        callHash: identity.callHash,
    };

    return {
        ok: true,
        signer: identity.signer,
        call,
        strippedParams,
        capabilities: identity.capabilities,
        nonce: identity.callMeta.nonce,
        callHash: identity.callHash,
        callMeta: identity.callMeta,
        interfaceHash: identity.callMeta.interfaceHash,
    };
}

// Re-exported so callers can spot signed calls without going through `verifyCall`.
export { LINKRPC_META_KEY, LINKRPC_SIGNATURE_KEY, LINKRPC_UNSIGNED_KEY };

