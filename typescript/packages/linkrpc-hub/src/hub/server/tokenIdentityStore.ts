import { randomBytes } from 'node:crypto';

/**
 * What a connection token resolves to once redeemed. The token is a hub-minted,
 * single-use bearer credential; its presence on a connection attests that the
 * minting authority (a `connectionTokenBinder`-granted endpoint) vouched for the
 * bound slot(s).
 *
 * The two bindings are **independent axes**, each optional:
 *
 * - {@link identitySlot} drives the redeemer's *managed identity* (`identity::*`).
 * - {@link grantedServiceIdNamespace} drives the redeemer's *freely-claimable
 *   serviceId namespace* (`hubGrantedServiceId::get`).
 *
 * A binder typically sets both to the same value (the historical convention),
 * but they no longer have to agree — and either may be omitted. A token with
 * neither is still admitted, but the connection routes anonymously (no
 * `identity::*`, no freely-claimable namespace).
 */
export interface TokenIdentityBinding {
    /**
     * Managed-identity slot the redeeming connection inherits. Omit to admit the
     * connection without a managed identity.
     */
    readonly identitySlot?: string;
    /**
     * ServiceId namespace the redeeming connection may claim freely (reported
     * via `hubGrantedServiceId::get`). Omit to grant no freely-claimable
     * namespace.
     */
    readonly grantedServiceIdNamespace?: string;
}

/** A freshly minted token plus its absolute expiry (epoch ms). */
export interface MintedToken {
    readonly token: string;
    readonly expiresAt: number;
}

interface Entry {
    readonly identitySlot: string | undefined;
    readonly grantedServiceIdNamespace: string | undefined;
    readonly expiresAt: number;
}

export interface TokenIdentityStoreOptions {
    /** Default lifetime applied to {@link TokenIdentityStore.mint}. Default 30s. */
    readonly defaultTtlMs?: number;
    /** Clock seam (tests). Default `Date.now`. */
    readonly now?: () => number;
    /** Token generator seam (tests). Default 32 random bytes, base64url. */
    readonly generateToken?: () => string;
}

/**
 * The hub's connection-token mint + redemption store, shared between the
 * `connectionTokenBinder::bindConnectionToken` front door (mint) and a
 * `managedIdentity: { mode: "fromToken" }` / `grantedServiceId: { mode:
 * "fromToken" }` listener (redeem).
 *
 * Tokens are random, time-boxed and **single-use**: {@link redeem} consumes the
 * entry, so a token can bind exactly one connection and cannot be replayed once
 * used or expired. Expired entries are pruned lazily on access.
 */
export class TokenIdentityStore {
    private readonly _byToken = new Map<string, Entry>();
    private readonly _defaultTtlMs: number;
    private readonly _now: () => number;
    private readonly _generate: () => string;

    constructor(options: TokenIdentityStoreOptions = {}) {
        this._defaultTtlMs = options.defaultTtlMs ?? 30_000;
        this._now = options.now ?? ((): number => Date.now());
        this._generate = options.generateToken ?? ((): string => randomBytes(32).toString('base64url'));
    }

    /** Mint a fresh single-use token bound to `binding`, valid for `ttlMs`. */
    public mint(binding: TokenIdentityBinding = {}, ttlMs?: number): MintedToken {
        this._prune();
        const token = this._generate();
        const expiresAt = this._now() + (ttlMs ?? this._defaultTtlMs);
        this._byToken.set(token, {
            identitySlot: binding.identitySlot,
            grantedServiceIdNamespace: binding.grantedServiceIdNamespace,
            expiresAt,
        });
        return { token, expiresAt };
    }

    /**
     * Non-consuming existence check for the `linkrpc::initialize` token gate.
     * Returns `true` iff the token is live (known and unexpired). Single-use is
     * enforced separately by {@link redeem}.
     */
    public peek(token: string | undefined): boolean {
        if (token === undefined) return false;
        const entry = this._byToken.get(token);
        if (entry === undefined) return false;
        if (entry.expiresAt <= this._now()) {
            this._byToken.delete(token);
            return false;
        }
        return true;
    }

    /**
     * Consume `token`, returning its binding exactly once. Returns `undefined`
     * for an unknown, expired or already-redeemed token (the caller should drop
     * the connection in that case).
     */
    public redeem(token: string | undefined): TokenIdentityBinding | undefined {
        if (token === undefined) return undefined;
        const entry = this._byToken.get(token);
        if (entry === undefined) return undefined;
        this._byToken.delete(token);
        if (entry.expiresAt <= this._now()) return undefined;
        const binding: { identitySlot?: string; grantedServiceIdNamespace?: string; } = {};
        if (entry.identitySlot !== undefined) binding.identitySlot = entry.identitySlot;
        if (entry.grantedServiceIdNamespace !== undefined) {
            binding.grantedServiceIdNamespace = entry.grantedServiceIdNamespace;
        }
        return binding;
    }

    /** Live (unexpired, unredeemed) token count — primarily for tests/metrics. */
    public get size(): number {
        this._prune();
        return this._byToken.size;
    }

    private _prune(): void {
        const now = this._now();
        for (const [token, entry] of this._byToken) {
            if (entry.expiresAt <= now) this._byToken.delete(token);
        }
    }
}
