import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ManagedIdentityStorage } from '../identity/managedIdentity';

/**
 * A {@link ManagedIdentityStorage} backed by a single JSON file (one object
 * keyed by the storage keys). Suitable for self-managed identities that
 * persist their capability bag locally — e.g. pass it to `CapBag.load`.
 *
 * The file is created (mode 0o600) on first write; reads of a missing file
 * yield an empty store. Not concurrency-safe across processes.
 */
export function fileManagedIdentityStorage(file: string): ManagedIdentityStorage {
    const read = async (): Promise<Record<string, unknown>> => {
        try {
            return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw e;
        }
    };
    const write = async (data: Record<string, unknown>): Promise<void> => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    };
    return {
        get: async <T = unknown>(key: string) => (await read())[key] as T | undefined,
        set: async (key, value) => {
            const data = await read();
            data[key] = value;
            await write(data);
        },
        delete: async (key) => {
            const data = await read();
            const existed = key in data;
            delete data[key];
            await write(data);
            return existed;
        },
        list: async (prefix = '') => Object.keys(await read()).filter((k) => k.startsWith(prefix)),
    };
}
