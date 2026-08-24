/**
 * Capability proposal issuer — the byte-equality preview mechanism for the v2
 * consent engine, backed by an admin {@link Identity}.
 *
 * In v1 these were hub-core methods (`Hub.proposeCapability` / `signProposal` /
 * `redeemProposal`). In v2 the hub signs nothing, so the consent engine owns an
 * admin identity and runs the proposal protocol itself. The mechanism lets a
 * separate consent UI (a webview shell, reached over RPC) render the *exact*
 * `Capability` that will be signed, then return it verbatim for redemption —
 * with cryptographic guarantees that the displayed bytes equal the signed
 * bytes and that a proposal cannot be replayed or substituted across prompts.
 *
 * Protocol (all host-side, using the admin key):
 *   1. `propose({ audience, permissions, expiresAtMs? })` → an unsigned
 *      `Capability` tagged with an internal marker.
 *   2. `signProposal(cap, { bind? })` → a `CapabilityProposal`: the readable
 *      `capability` plus an opaque `$hubData` blob (a domain-separated
 *      signature over `canonicalJson({ preview: cap, bind? })`). The UI renders
 *      `capability` and, on approval, returns the whole proposal verbatim.
 *   3. `redeemProposal(proposal, { expectedBind? })` → a real
 *      `SignedCapability`. Verifies the `$hubData` signature, that the preview
 *      deep-equals `proposal.capability`, the optional `bind`, and a one-shot
 *      nonce; then signs the bare canonical cap so the result is an ordinary
 *      bearer token (verifiable by {@link verifyChain}).
 */

import {
    base64UrlToBytes,
    bytesToBase64Url,
    jcsCanonicalize,
    jcsCanonicalizeBytes,
    keyIdForPrincipal,
    type JsonValue,
    type PrincipalId,
    publicKeyForKeyId,
    signCapability,
    type SignedCapability,
} from '@vscode/hubrpc';
import { crypto } from '@vscode/hubrpc';
import type { Capability, Permission } from '@vscode/hubrpc';
import type { SigningIdentity } from '@vscode/hubrpc';

/**
 * Hub-minted "proposal" of a capability the user is about to approve.
 * `capability` is the readable JSON the consent UI renders; `$hubData` is an
 * opaque blob the UI must round-trip verbatim — only the issuer inspects it.
 */
export interface CapabilityProposal {
    readonly capability: Capability;
    /** Opaque issuer-private signed blob; round-trip verbatim. */
    readonly $hubData: unknown;
}

interface HubProposalData {
    readonly payload: string;
    readonly signature: string;
}

function isHubProposalData(v: unknown): v is HubProposalData {
    return (
        v !== null &&
        typeof v === 'object' &&
        typeof (v as HubProposalData).payload === 'string' &&
        typeof (v as HubProposalData).signature === 'string'
    );
}

/**
 * Access-grant duration vocabulary.
 *
 * `once` and `shortLived` share the same 5-minute TTL — they differ only on
 * the *use* axis: `once` is the single-use "Allow once" choice (the consent
 * host additionally pins a `callBind`, making it intrinsically single-use),
 * while `shortLived` is an ordinary multi-use grant that simply expires soon.
 * `persistent` never expires (no `expiresAtMs`); revocation is the only way to
 * end it.
 */
export type AccessDurationName = 'once' | 'shortLived' | 'longLived' | 'persistent';

const _DURATION_TO_MS: Record<Exclude<AccessDurationName, 'persistent'>, number> = {
    once: 5 * 60 * 1000,
    shortLived: 5 * 60 * 1000,
    longLived: 24 * 60 * 60 * 1000,
};

/**
 * Convert an access duration into a Unix-milliseconds expiration timestamp, so
 * handlers compute the same `expiresAtMs` the issuer mints with. Returns
 * `undefined` for `persistent` (and any future never-expiring duration), which
 * callers pass straight to {@link CapabilityProposalIssuer.propose}/`mint` —
 * both omit `expiresAtMs` when it is `undefined`, yielding a non-expiring cap.
 * Defaults to the safe short TTL (`shortLived`) when no duration is supplied.
 */
export function durationToExp(duration: AccessDurationName | undefined): number | undefined {
    const d = duration ?? 'shortLived';
    if (d === 'persistent') {
        return undefined;
    }
    return Date.now() + _DURATION_TO_MS[d];
}

function canonicalEqual(a: unknown, b: unknown): boolean {
    try {
        return jcsCanonicalize(a as JsonValue) === jcsCanonicalize(b as JsonValue);
    } catch {
        return false;
    }
}

/** Marker proving a `Capability` came from {@link CapabilityProposalIssuer.propose}. */
const _PROPOSED = Symbol('hubrpc.proposedCapability');

export interface ProposeArgs {
    readonly audience: PrincipalId;
    readonly permissions: readonly Permission[];
    /** Unix milliseconds. Absent = never expires. */
    readonly expiresAtMs?: number;
}

/**
 * Issues capabilities and capability proposals signed by an admin
 * {@link SigningIdentity}. One instance per hub host; tracks redeemed nonces
 * for one-shot proposal redemption.
 */
export class CapabilityProposalIssuer {
    private readonly _redeemedNonces = new Set<string>();
    private _nonceCounter = 0;

    constructor(
        private readonly _issuer: SigningIdentity,
    ) { }

    public get issuerPrincipalId(): PrincipalId {
        return this._issuer.publicSigningIdentity.principal;
    }

    /**
     * Build an unsigned `Capability` the issuer is willing to sign, tagged with
     * an internal marker. {@link signProposal} refuses to sign anything lacking
     * the marker — a guard against a handler fabricating arbitrary caps. The
     * marker is non-enumerable, so it never affects serialization or signing.
     */
    public propose(args: ProposeArgs): Capability {
        const cap: Capability = {
            issuer: this._issuer.publicSigningIdentity.principal,
            audience: args.audience,
            permissions: [...args.permissions],
            nonce: this._nextNonce(),
            ...(args.expiresAtMs !== undefined ? { expiresAtMs: args.expiresAtMs } : {}),
        };
        Object.defineProperty(cap, _PROPOSED, {
            value: true,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        return cap;
    }

    /**
     * Mint a final `SignedCapability` directly from a proposed cap, bypassing
     * the preview round-trip. Use when no UI needs to render the unsigned form.
     */
    public async mint(args: ProposeArgs): Promise<SignedCapability> {
        const cap = this.propose(args);
        return this._sign(cap);
    }

    /**
     * Pair a proposed `Capability` with a domain-separated signature over
     * `canonicalJson({ preview: cap, bind? })`. The result is **not** a bearer
     * token — only this issuer can redeem it.
     */
    public async signProposal(
        cap: Capability,
        opts?: { readonly bind?: JsonValue },
    ): Promise<CapabilityProposal> {
        if (!(cap as unknown as Record<symbol, unknown>)[_PROPOSED]) {
            throw new Error('signProposal: capability was not produced by propose()');
        }
        const payload: { preview: Capability; bind?: JsonValue } = { preview: cap };
        if (opts?.bind !== undefined) {
            payload.bind = opts.bind;
        }
        const previewBytes = jcsCanonicalizeBytes(payload);
        const sig = await this._issuer.sign(previewBytes);
        const hubData: HubProposalData = {
            payload: bytesToBase64Url(previewBytes),
            signature: bytesToBase64Url(sig),
        };
        return { capability: cap, $hubData: hubData };
    }

    /**
     * Verify and redeem a {@link CapabilityProposal}, returning a real
     * {@link SignedCapability}. Checks: `$hubData` signature, preview deep-equal
     * to `proposal.capability`, optional `bind` match, and one-shot nonce.
     */
    public async redeemProposal(
        proposal: CapabilityProposal,
        opts?: { readonly expectedBind?: JsonValue },
    ): Promise<SignedCapability> {
        if (!isHubProposalData(proposal.$hubData)) {
            throw new Error('redeemProposal: malformed $hubData');
        }
        const payloadBytes = base64UrlToBytes(proposal.$hubData.payload);
        const sigBytes = base64UrlToBytes(proposal.$hubData.signature);
        const pubKey = publicKeyForKeyId(keyIdForPrincipal(this._issuer.publicSigningIdentity.principal));
        const sigOk = await crypto.verify(pubKey, payloadBytes, sigBytes);
        if (!sigOk) {
            throw new Error('redeemProposal: $hubData.signature does not verify');
        }
        let parsed: { preview?: unknown; bind?: unknown };
        try {
            parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
                preview?: unknown;
                bind?: unknown;
            };
        } catch (e) {
            throw new Error(`redeemProposal: malformed payload (${(e as Error).message})`);
        }
        if (!canonicalEqual(parsed.preview, proposal.capability)) {
            throw new Error('redeemProposal: proposal.capability does not match the signed preview');
        }
        const hasBind = parsed.bind !== undefined;
        const wantBind = opts?.expectedBind !== undefined;
        if (hasBind !== wantBind) {
            throw new Error(
                hasBind
                    ? 'redeemProposal: proposal is bound but no expectedBind supplied'
                    : 'redeemProposal: expectedBind supplied but proposal has no bind',
            );
        }
        if (hasBind && !canonicalEqual(parsed.bind, opts!.expectedBind)) {
            throw new Error('redeemProposal: bind does not match expectedBind');
        }
        const cap = parsed.preview as Capability;
        if (this._redeemedNonces.has(cap.nonce)) {
            throw new Error('redeemProposal: proposal already redeemed');
        }
        this._redeemedNonces.add(cap.nonce);
        return this._sign(cap);
    }

    private _sign(cap: Capability): Promise<SignedCapability> {
        // Sign the bare canonical cap so the result is an ordinary bearer
        // token, indistinguishable from one minted via mintCapability.
        return signCapability(cap, this._issuer);
    }

    private _nextNonce(): string {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        this._nonceCounter += 1;
        return `${bytesToBase64Url(bytes)}-${this._nonceCounter}`;
    }
}
