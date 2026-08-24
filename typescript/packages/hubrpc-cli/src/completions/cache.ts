/**
 * File-backed JSON cache for the directory snapshot + per-interface method
 * lists. Keyed by a stable identifier of the target hub (typically the
 * resolved endpoint URI sha) so TAB completion against different endpoints
 * doesn't share state.
 *
 * Cache lives under `os.tmpdir()/hubrpc-completions/`. I/O failures are
 * silently absorbed — the wrapper falls through to the inner source rather
 * than failing the completion request.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DirectoryEntry, DirectorySource } from './directorySource';

/** TTL for the bus snapshot (services + interfaces). */
const SNAPSHOT_TTL_MS = 60_000;

/** TTL for per-interface method lists (schemas change rarely). */
const METHODS_TTL_MS = 5 * 60_000;

const CACHE_DIR = path.join(os.tmpdir(), 'hubrpc-completions');

interface CachedSnapshot {
    readonly ts: number;
    readonly entries: readonly DirectoryEntry[];
    readonly methods: Record<string, { readonly ts: number; readonly names: readonly string[] }>;
    readonly params?: Record<string, { readonly ts: number; readonly names: readonly string[] }>;
}

/**
 * Wrap `inner` with a JSON-file cache scoped to `endpointKey`. Reads the
 * cache file once at construction; refills the bus snapshot lazily on the
 * first `entries()` call when the cache is missing or stale.
 */
export function withFileCache(inner: DirectorySource, endpointKey: string): DirectorySource {
    const file = _cacheFile(endpointKey);
    let cached = _loadFresh(file);

    let entriesPromise: Promise<readonly DirectoryEntry[]> | undefined;
    const ensureEntries = (): Promise<readonly DirectoryEntry[]> => {
        if (cached !== undefined) return Promise.resolve(cached.entries);
        if (!entriesPromise) {
            entriesPromise = inner.entries().then((entries) => {
                cached = { ts: Date.now(), entries, methods: {} };
                _save(file, cached);
                return entries;
            });
        }
        return entriesPromise;
    };

    return {
        entries: ensureEntries,
        async methodsOnInterface(serviceId, interfaceId) {
            const key = `${serviceId ?? ''}::${interfaceId}`;
            if (cached && cached.methods[key]) {
                const entry = cached.methods[key];
                if (Date.now() - entry.ts <= METHODS_TTL_MS) return entry.names;
            }
            const names = await inner.methodsOnInterface(serviceId, interfaceId);
            if (cached) {
                cached = {
                    ...cached,
                    methods: { ...cached.methods, [key]: { ts: Date.now(), names: [...names] } },
                };
                _save(file, cached);
            }
            return names;
        },
        async paramNamesForMethod(serviceId, interfaceId, methodName) {
            const key = `${serviceId ?? ''}::${interfaceId}::${methodName}`;
            if (cached && cached.params && cached.params[key]) {
                const entry = cached.params[key];
                if (Date.now() - entry.ts <= METHODS_TTL_MS) return entry.names;
            }
            const names = await inner.paramNamesForMethod(serviceId, interfaceId, methodName);
            if (cached) {
                const params = { ...(cached.params ?? {}), [key]: { ts: Date.now(), names: [...names] } };
                cached = { ...cached, params };
                _save(file, cached);
            }
            return names;
        },
    };
}

function _loadFresh(file: string): CachedSnapshot | undefined {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as CachedSnapshot | null;
        if (!parsed || typeof parsed.ts !== 'number' || !Array.isArray(parsed.entries)) {
            return undefined;
        }
        if (Date.now() - parsed.ts > SNAPSHOT_TTL_MS) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

function _save(file: string, snap: CachedSnapshot): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(snap));
    } catch {
        // Cache writes are best-effort; never propagate.
    }
}

function _cacheFile(endpointKey: string): string {
    const hash = createHash('sha256').update(endpointKey).digest('hex').slice(0, 16);
    return path.join(CACHE_DIR, `${hash}.json`);
}
