/**
 * Hub-backed source of completion candidates. Abstracted so the orchestrator
 * in {@link ./complete.ts} stays unit-testable: tests inject a hand-written
 * source, production wires {@link ChannelDirectorySource} which talks to a
 * live hub via the standard reflection helpers (with an optional file cache
 * provided by {@link ./cache}).
 *
 * The interface intentionally has three primitive operations:
 *   - {@link entries} — the bus snapshot (serviceId, interfaceId) pairs
 *   - {@link methodsOnInterface} — method names per (serviceId, interfaceId)
 *   - {@link paramNamesForMethod} — param property names per method
 *
 * Everything else (distinct serviceIds, interfaces-on-service) is derived
 * by the orchestrator. This keeps cache coordination trivial: one snapshot,
 * one per-interface schema fetch per (sid, iid).
 */
import { fetchSchema, walkHub } from '@vscode/hubrpc-client';
import type { IRequestSender, SigningCallCtx } from '@vscode/hubrpc';

export interface DirectoryEntry {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
}

export interface DirectorySource {
    entries(): Promise<readonly DirectoryEntry[]>;
    methodsOnInterface(
        serviceId: string | undefined,
        interfaceId: string,
    ): Promise<readonly string[]>;
    /**
     * Property names of the method's params object schema, or `[]` if the
     * method takes no params / has a non-object params descriptor / does
     * not exist on the interface.
     */
    paramNamesForMethod(
        serviceId: string | undefined,
        interfaceId: string,
        methodName: string,
    ): Promise<readonly string[]>;
}

/** Distinct, sorted serviceIds (drops the empty `''` root). */
export function distinctServiceIds(entries: readonly DirectoryEntry[]): readonly string[] {
    return [...new Set(entries.map((e) => e.serviceId).filter((s) => s.length > 0))].sort();
}

/** Distinct, sorted interface ids across all services. */
export function distinctInterfaceIds(entries: readonly DirectoryEntry[]): readonly string[] {
    return [...new Set(entries.map((e) => e.interfaceId))].sort();
}

/** Distinct, sorted interface ids registered on a particular serviceId. */
export function interfacesOnService(
    entries: readonly DirectoryEntry[],
    serviceId: string,
): readonly string[] {
    return [
        ...new Set(entries.filter((e) => e.serviceId === serviceId).map((e) => e.interfaceId)),
    ].sort();
}

/**
 * Live source: walks the hub once (memoized for the instance lifetime),
 * then derives every entry / methods lookup from that single snapshot +
 * lazy `fetchSchema` calls. Each (sid, iid) schema is fetched at most once
 * per instance regardless of how many downstream queries reference it.
 */
export class ChannelDirectorySource implements DirectorySource {
    private _walkPromise: Promise<readonly DirectoryEntry[]> | undefined;
    private readonly _schemaCache = new Map<string, Promise<{
        readonly methods: readonly string[];
        readonly paramsByMethod: ReadonlyMap<string, readonly string[]>;
    }>>();

    constructor(private readonly _channel: IRequestSender<SigningCallCtx>) {}

    entries(): Promise<readonly DirectoryEntry[]> {
        if (!this._walkPromise) {
            this._walkPromise = walkHub(this._channel).then((listings) =>
                listings.map((l) => ({
                    serviceId: l.serviceId,
                    interfaceId: l.interfaceId,
                    hash: l.hash,
                })),
            );
        }
        return this._walkPromise;
    }

    async methodsOnInterface(
        serviceId: string | undefined,
        interfaceId: string,
    ): Promise<readonly string[]> {
        const schema = await this._fetchSchema(serviceId, interfaceId);
        return schema.methods;
    }

    async paramNamesForMethod(
        serviceId: string | undefined,
        interfaceId: string,
        methodName: string,
    ): Promise<readonly string[]> {
        const schema = await this._fetchSchema(serviceId, interfaceId);
        return schema.paramsByMethod.get(methodName) ?? [];
    }

    private _fetchSchema(
        serviceId: string | undefined,
        interfaceId: string,
    ): Promise<{
        readonly methods: readonly string[];
        readonly paramsByMethod: ReadonlyMap<string, readonly string[]>;
    }> {
        const key = `${serviceId ?? ''}::${interfaceId}`;
        let cached = this._schemaCache.get(key);
        if (!cached) {
            cached = (async () => {
                const schema = await fetchSchema(this._channel, interfaceId, undefined, serviceId);
                const methods = Object.keys(schema.methods).sort();
                const paramsByMethod = new Map<string, readonly string[]>();
                for (const [name, method] of Object.entries(schema.methods)) {
                    const params = method.params;
                    if (
                        typeof params === 'object' && params !== null
                        && (params as { type?: string }).type === 'object'
                    ) {
                        const props = (params as { properties?: Record<string, unknown> }).properties
                            ?? {};
                        paramsByMethod.set(name, Object.keys(props));
                    } else {
                        paramsByMethod.set(name, []);
                    }
                }
                return { methods, paramsByMethod };
            })();
            this._schemaCache.set(key, cached);
        }
        return cached;
    }
}
