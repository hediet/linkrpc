import type { CapProvider } from './signingSender';
import {
    type SignedCapability,
} from './capability';
import type { ManagedIdentityStorage } from './managedIdentity';

export interface CapBagOptions {
    /**
     * Per-identity persistent storage (e.g.
     * {@link ManagedIdentityHandle.storage}). Omit for a memory-only bag
     * that forgets its caps when the process exits.
     */
    readonly storage?: ManagedIdentityStorage;
    /** Storage key. Defaults to `linkrpc.caps.v1`. */
    readonly storageKey?: string;
    /** Optional sink for non-fatal storage warnings. */
    readonly onWarn?: (message: string) => void;
}

const DEFAULT_STORAGE_KEY = 'linkrpc.caps.v1';

/**
 * A process-lifetime bag of hub-issued capabilities. Plug
 * {@link CapBag.provider} straight into a connection's cap provider so every
 * outbound signed call carries whatever caps have been granted so far. The
 * hub picks whichever cap matches the call per dispatch.
 *
 * When constructed with {@link CapBagOptions.storage} the bag hydrates from
 * (and persists to) storage, so the next process spawn for the same identity
 * reuses its grants without re-prompting.
 */
export class CapBag {
    /** Create a bag, hydrating from storage when one was supplied. */
    public static async load(options: CapBagOptions = {}): Promise<CapBag> {
        const bag = new CapBag(options);
        await bag._hydrate();
        return bag;
    }

    private readonly _caps: SignedCapability[] = [];
    private readonly _storage?: ManagedIdentityStorage;
    private readonly _storageKey: string;
    private readonly _onWarn: (message: string) => void;

    private constructor(options: CapBagOptions) {
        this._storage = options.storage;
        this._storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
        this._onWarn = options.onWarn ?? (() => { });
    }

    public get capabilities(): readonly SignedCapability[] {
        return this._caps;
    }

    /**
     * A {@link CapProvider} reflecting the bag at call-time. Assign it to
     * `HubClientHandle.signing.capProvider` or pass it through
     * `SigningSenderConfig.capProvider`.
     */
    public readonly provider: CapProvider = async () => this._caps.length > 0 ? { capabilities: this._caps } : {};

    /** Append capabilities and persist (when backed by storage). */
    public async add(...caps: readonly SignedCapability[]): Promise<void> {
        if (caps.length === 0) {
            return;
        }
        this._caps.push(...caps);
        await this._persist();
    }

    /** Drop all capabilities and persist the empty bag. */
    public async clear(): Promise<void> {
        if (this._caps.length === 0) {
            return;
        }
        this._caps.length = 0;
        await this._persist();
    }

    private async _hydrate(): Promise<void> {
        if (!this._storage) {
            return;
        }
        try {
            const persisted = await this._storage.get<SignedCapability[]>(this._storageKey);
            if (!Array.isArray(persisted)) {
                return;
            }
            for (const cap of persisted) {
                if (cap && typeof cap === 'object' && '$linkrpcSignature' in cap) {
                    this._caps.push(cap);
                } else {
                    this._onWarn(`skipping malformed persisted cap`);
                }
            }
        } catch (e) {
            this._onWarn(`failed to read caps from storage: ${(e as Error).message}`);
        }
    }

    private async _persist(): Promise<void> {
        if (!this._storage) {
            return;
        }
        try {
            await this._storage.set(this._storageKey, this._caps);
        } catch (e) {
            this._onWarn(`failed to persist caps: ${(e as Error).message}`);
        }
    }
}
