import type { ITransportServer, Transport } from '@hediet/linkrpc/hub/common';
import { mapTransport } from '@hediet/linkrpc/hub/common';

/**
 * Attested origin of an incoming connection. Produced by a
 * {@link ConnectionProvenanceProvider} from a freshly accepted transport,
 * *before* any RPC flows. Everything here is, by contract, already verified:
 * there is no "unverified" provenance — a provider that cannot fully attest
 * the peer returns `{ error }` instead of a partial result.
 */
export interface ConnectionProvenance {
    /**
     * Stable identity key for the peer. INVARIANT: must begin with
     * `` `${provider.identityNamespace}/` `` (e.g. `"docker/echo-provider"`),
     * which {@link withProvenance} enforces — a value that doesn't is treated
     * as un-attested. This keeps keys from different provenance sources from
     * colliding and makes the namespace self-describing.
     */
    readonly identityKey: string;
    /**
     * Free-form, already-verified attestation detail for logging and policy
     * (container id, image, pid, uid, …). Never used for routing or trust.
     */
    readonly attributes: Readonly<Record<string, string | number>>;
}

/**
 * Resolves the {@link ConnectionProvenance} of an accepted transport.
 *
 * Generic over the transport type so the provider can read whatever the
 * concrete transport exposes (e.g. a `NodeSocketTransport`'s `socket` for
 * peercred) — the hub core stays free of those types. Implementations live
 * outside the hub (e.g. `@hediet/linkrpc-extra`).
 */
export interface ConnectionProvenanceProvider<TTransport extends Transport> {
    /**
     * Namespace every {@link ConnectionProvenance.identityKey} this provider
     * emits is prefixed with (e.g. `"docker"`).
     */
    readonly identityNamespace: string;

    /**
     * Resolve provenance for `transport` before any RPC is exchanged. Honour
     * `signal` to abort if the transport closes or a deadline elapses.
     *
     * @returns verified provenance, or `{ error }` to refuse attestation.
     */
    resolve(transport: TTransport, signal: AbortSignal): Promise<ConnectionProvenance | { error: string }>;
}

/**
 * A {@link Transport} annotated with its (possibly absent) attestation —
 * the narrow shape provenance-aware consumers (e.g. {@link PrefixPolicy})
 * depend on, without naming a concrete backend transport type.
 */
export interface ITransportWithProvenance extends Transport {
    readonly provenance: ConnectionProvenance | undefined;
}

/** A concrete transport `T` annotated with its (possibly absent) attestation. */
export type WithProvenance<T extends Transport> = T & {
    readonly provenance: ConnectionProvenance | undefined;
};

export interface WithProvenanceOptions {
    /**
     * Abort the provider's `resolve` after this many ms (counts as
     * un-attested). Omit for no deadline.
     */
    readonly resolveTimeoutMs?: number;
    /**
     * Drop connections that could not be attested instead of forwarding them
     * with `provenance: undefined`. Default `false`.
     */
    readonly requireProvenance?: boolean;
}

/**
 * Annotate every transport from `source` with the provenance `provider`
 * resolves for it. On provider error/timeout — or when the returned
 * `identityKey` does not start with `` `${provider.identityNamespace}/` `` —
 * the transport is forwarded with `provenance: undefined`, unless
 * {@link WithProvenanceOptions.requireProvenance} is set, in which case it is
 * disposed and dropped.
 *
 * This is the one concrete {@link mapTransport} the hub ships: it is where
 * `net.Socket` (or any backend handle) is read for attestation and nowhere
 * else.
 */
export function withProvenance<T extends Transport>(
    source: ITransportServer<T>,
    provider: ConnectionProvenanceProvider<T>,
    options: WithProvenanceOptions = {},
): ITransportServer<WithProvenance<T>> {
    const namespacePrefix = `${provider.identityNamespace}/`;
    return mapTransport(source, async (t) => {
        const controller = new AbortController();
        t.onDidClose(() => controller.abort());
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (options.resolveTimeoutMs !== undefined) {
            timer = setTimeout(() => controller.abort(), options.resolveTimeoutMs);
        }

        let provenance: ConnectionProvenance | undefined;
        try {
            const result = await provider.resolve(t, controller.signal);
            if (!('error' in result) && result.identityKey.startsWith(namespacePrefix)) {
                provenance = result;
            }
        } catch {
            provenance = undefined;
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }

        if (provenance === undefined && options.requireProvenance) {
            t.dispose();
            return undefined;
        }
        return Object.assign(t, { provenance }) as WithProvenance<T>;
    });
}
