/**
 * Sign / verify the linkrpc identity envelopes on a JSON-RPC call.
 *
 * Wire shape (signed call params):
 *
 *     params: {
 *         ...userParams,
 *         $linkrpc:           CallMeta,        // signed
 *         $linkrpcSignature:  { call: sig },   // the signature
 *         $linkrpcUnsigned:   { capabilities } // unsigned attachments
 *     }
 *
 * The call signature commits to `signingInput("call", paramsObject)` — the
 * params with the two reserved keys (`$linkrpcSignature`, `$linkrpcUnsigned`)
 * stripped and the `"call"` pad prefixed. This is the same
 * {@link signedHash} the cap-minter uses for `callBind.payloadHash`, so the
 * two can never drift.
 */

import type { SignedCapability } from '../protocol/capability';
import type { JsonValue } from '../protocol/jsonValue';
import {
    LINKRPC_UNSIGNED_KEY,
    type CallMeta,
    type LinkRpcUnsigned,
    type LinkRpcWireParams,
    requireObjectParams,
    stripLinkRpcWireMeta,
} from '../protocol/linkRpcEnvelope';
import { bytesToBase64Url, type PrincipalId, resolveSigningKey } from '../crypto/cryptoProvider';
import {
    LINKRPC_META_KEY,
    LINKRPC_SIGNATURE_KEY,
    type Base64Sha256,
    readSignature,
    signObject,
    signedHash,
    verifyObject,
} from './signedObject';
import type { SigningIdentity } from './identity';

export { LINKRPC_META_KEY, LINKRPC_SIGNATURE_KEY, LINKRPC_UNSIGNED_KEY, type CallMeta };

// ---- signing -------------------------------------------------------

export interface SignRpcCallOptions {
    readonly method: string;
    /** The user's params. Must be a plain JSON object or `undefined` (else throws). */
    readonly params?: JsonValue;
    /** Identity that produces the signature. */
    readonly signingIdentity: SigningIdentity;
    /** Unix milliseconds. Defaults to `Date.now()`. */
    readonly nowMs?: number;
    /** Override the random nonce (testing). */
    readonly nonce?: Uint8Array;
    /** Optional schema hash assertion. */
    readonly interfaceHash?: string;
}

export interface SignedRpcCall {
    /**
     * Wire params for the JSON-RPC request: the user's params merged with
     * `$linkrpc` (signed meta) and `$linkrpcSignature` (the `call` signature).
     * Capabilities are attached separately via {@link attachCapabilities}
     * since they are unsigned authority hints, not part of what the
     * signature commits to.
     */
    readonly wireParams: LinkRpcWireParams;
    /** The signed call meta embedded under `$linkrpc`. */
    readonly callMeta: CallMeta;
    /** The call's content hash (`signedHash("call", signedParams)`) — what `callBind` binds to. */
    readonly callHash: Base64Sha256;
}

/**
 * Sign a single JSON-RPC call. Produces the wire-form params with the
 * `$linkrpc` (signed meta) and `$linkrpcSignature.call` envelopes attached,
 * plus the call content hash.
 */
export async function signRpcCall(opts: SignRpcCallOptions): Promise<SignedRpcCall> {
    const userParams = requireObjectParams(opts.params);
    const nonce = opts.nonce ?? _randomNonce();
    const signedAtMs = opts.nowMs ?? Date.now();
    const callMeta: CallMeta = {
        method: opts.method,
        nonce: bytesToBase64Url(nonce),
        signedAtMs,
        principal: opts.signingIdentity.publicSigningIdentity.principal,
        ...(opts.interfaceHash !== undefined ? { interfaceHash: opts.interfaceHash } : {}),
    };
    const signedParams = { ...userParams, [LINKRPC_META_KEY]: callMeta };
    const callHash = signedHash("call", signedParams);
    const wireParams = await signObject("call", signedParams, opts.signingIdentity) as LinkRpcWireParams;
    return { wireParams, callMeta, callHash };
}

/**
 * Attach capabilities to a {@link SignedRpcCall.wireParams}. Capabilities
 * ride in `$linkrpcUnsigned.capabilities` — they are NOT part of what the
 * signature commits to (which is why this is a separate step). Returns a
 * new wireParams object; the input is not mutated.
 */
export function attachCapabilities(
    wireParams: LinkRpcWireParams,
    capabilities: readonly SignedCapability[],
): LinkRpcWireParams {
    if (capabilities.length === 0) return wireParams;
    const obj = wireParams as unknown as Record<string, unknown>;
    const existing = obj[LINKRPC_UNSIGNED_KEY] as LinkRpcUnsigned | undefined;
    const merged: LinkRpcUnsigned = { ...existing, capabilities };
    return { ...obj, [LINKRPC_UNSIGNED_KEY]: merged } as LinkRpcWireParams;
}

// ---- verification --------------------------------------------------

export interface VerifyRpcCallOptions {
    readonly wireMethod: string;
    /** Raw params object received on the wire. */
    readonly wireParams: unknown;
    /** Defaults to `Date.now()`. */
    readonly nowMs?: number;
    /** Max clock skew in milliseconds. Default 300000 (5 min). */
    readonly maxSkewMs?: number;
    /** When `true`, reject calls lacking a signed envelope + signature. */
    readonly requireSigned?: boolean;
}

export type VerifyRpcCallResult =
    | {
        readonly ok: true;
        /** `undefined` when the call had no signed (`$linkrpc` + `$linkrpcSignature.call`) envelope. */
        readonly identity:
        | undefined
        | {
            readonly callMeta: CallMeta;
            /** The authenticated principal (`callMeta.principal`). */
            readonly signer: PrincipalId;
            /** The call's content hash — input to `callBind.payloadHash`. */
            readonly callHash: Base64Sha256;
            readonly capabilities: SignedCapability[];
        };
        /** Params the handler should see (user params with the reserved keys stripped). */
        readonly params: JsonValue | undefined;
    }
    | { readonly ok: false; readonly reason: string; };

/**
 * Verify the identity envelope on a JSON-RPC call. Does **not** evaluate
 * capability chains or caveats — that is the hub / authoriser's job.
 *
 * A signed call carries `$linkrpc` (with `principal`) and a `call` signature
 * under `$linkrpcSignature`. The signature is checked against
 * `signingInput("call", wireParams)` (the reserved keys are stripped by the
 * signed-object standard). Bare/unsigned calls return `identity: undefined`.
 */
export async function verifyRpcCall(opts: VerifyRpcCallOptions): Promise<VerifyRpcCallResult> {
    const { wireParams } = opts;
    const meta = _extractObject<CallMeta>(wireParams, LINKRPC_META_KEY);
    const userParams = stripLinkRpcWireMeta(wireParams);

    if (meta === undefined) {
        if (opts.requireSigned) return { ok: false, reason: 'missing $linkrpc envelope' };
        return { ok: true, identity: undefined, params: userParams };
    }

    // Validate the always-present meta fields.
    if (
        typeof meta.method !== 'string' ||
        typeof meta.nonce !== 'string' ||
        typeof meta.signedAtMs !== 'number' ||
        (meta.principal !== undefined && typeof meta.principal !== 'string') ||
        (meta.interfaceHash !== undefined && typeof meta.interfaceHash !== 'string')
    ) {
        return { ok: false, reason: 'malformed linkrpc envelope' };
    }

    // Anti-confusion: the signed method must match the JSON-RPC method.
    if (meta.method !== opts.wireMethod) {
        return { ok: false, reason: 'method mismatch' };
    }

    // Skew window applies to signed and unsigned-with-meta calls alike.
    const now = opts.nowMs ?? Date.now();
    const skew = opts.maxSkewMs ?? 300000;
    if (Math.abs(meta.signedAtMs - now) > skew) {
        return { ok: false, reason: `timestamp skew > ${skew}ms` };
    }

    const signature = readSignature(wireParams as object, 'call');
    if (meta.principal === undefined || signature === undefined) {
        // Has $linkrpc meta but no signature — an unsigned call.
        if (opts.requireSigned) return { ok: false, reason: 'unsigned call' };
        return { ok: true, identity: undefined, params: userParams };
    }

    const resolved = resolveSigningKey({
        principal: meta.principal,
        keyId: signature.keyId,
        timeMs: meta.signedAtMs,
    });
    if (resolved === undefined) {
        return { ok: false, reason: `unresolvable signing key for principal ${meta.principal}` };
    }

    // The signature covers `signingInput("call", wireParams)` — the
    // standard strips `$linkrpcSignature`/`$linkrpcUnsigned` for us.
    const sigOk = await verifyObject('call', wireParams as object, resolved.publicKey);
    if (!sigOk) return { ok: false, reason: 'bad signature' };

    const callHash = signedHash('call', wireParams as object);
    const unsigned = _extractObject<LinkRpcUnsigned>(wireParams, LINKRPC_UNSIGNED_KEY);
    const capabilities = Array.isArray(unsigned?.capabilities)
        ? (unsigned!.capabilities as SignedCapability[])
        : [];

    return {
        ok: true,
        identity: {
            callMeta: meta,
            signer: meta.principal,
            callHash,
            capabilities,
        },
        params: userParams,
    };
}

// ---- helpers -------------------------------------------------------

function _extractObject<T>(wireParams: unknown, key: string): T | undefined {
    if (wireParams === null || typeof wireParams !== 'object' || Array.isArray(wireParams)) {
        return undefined;
    }
    const env = (wireParams as Record<string, unknown>)[key];
    if (env === undefined || env === null || typeof env !== 'object' || Array.isArray(env)) {
        return undefined;
    }
    return env as T;
}

function _randomNonce(): Uint8Array {
    const out = new Uint8Array(16);
    globalThis.crypto.getRandomValues(out);
    return out;
}
