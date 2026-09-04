import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type ValidationMode = 'auto' | 'required' | 'off';

export interface ContextValues {
    readonly endpoint?: string;
    readonly endpointCmd?: string;
    readonly endpointCmdStdio?: string;
    readonly endpointCmdEnv?: Readonly<Record<string, string>>;
    readonly endpointToken?: string;
    readonly endpointCmdCwd?: string;
    readonly config?: string;
    readonly provisionIdentity?: boolean;
    readonly provisionIdentitySlot?: string;
    readonly principal?: string;
    readonly schema?: string;
    readonly validation?: ValidationMode;
    readonly connectionTimeout?: string;
    readonly connectionTtl?: string;
    readonly notificationLimit?: number;
}

export type ContextReference =
    | { readonly kind: 'empty'; }
    | { readonly kind: 'root'; }
    | { readonly kind: 'id'; readonly id: string; }
    | { readonly kind: 'path'; readonly path: string; };

export interface StoredContext {
    readonly key: string;
    readonly reference: Exclude<ContextReference, { readonly kind: 'empty'; }>;
    readonly values: ContextValues;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface SelectedContext {
    readonly reference: ContextReference;
    readonly context: StoredContext | undefined;
    readonly selectedBy: 'argument' | 'environment' | 'cwd' | 'root' | 'empty';
    readonly explicitlySelected: boolean;
}

interface ContextDocument {
    readonly version: 1;
    readonly contexts: readonly StoredContext[];
}

export interface ContextStoreOptions {
    readonly file?: string;
    readonly cwd?: string;
}

export class ContextStore {
    private readonly _file: string;
    private readonly _cwd: string;

    public constructor(options: ContextStoreOptions = {}) {
        this._file = options.file ?? defaultContextStoreFile();
        this._cwd = path.resolve(options.cwd ?? process.cwd());
    }

    public get file(): string {
        return this._file;
    }

    public async select(options: {
        readonly selector?: string;
        readonly environmentSelector?: string;
        readonly allowMissing?: boolean;
    } = {}): Promise<SelectedContext> {
        const contexts = await this._read();
        if (options.selector !== undefined) {
            const reference = await this.resolveReference(options.selector);
            return this._selectedReference(
                contexts,
                reference,
                'argument',
                true,
                options.allowMissing === true,
            );
        }
        if (options.environmentSelector !== undefined && options.environmentSelector !== '') {
            const reference = await this.resolveReference(options.environmentSelector);
            return this._selectedReference(
                contexts,
                reference,
                'environment',
                false,
                options.allowMissing === true,
            );
        }

        let cursor = await canonicalDirectory(this._cwd);
        while (true) {
            const reference = normalizeContextReference({ kind: 'path', path: cursor });
            const context = contexts.get(contextKey(reference));
            if (context !== undefined) {
                return {
                    reference,
                    context,
                    selectedBy: reference.kind === 'root' ? 'root' : 'cwd',
                    explicitlySelected: false,
                };
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) break;
            cursor = parent;
        }

        const rootReference: ContextReference = { kind: 'root' };
        const root = contexts.get(contextKey(rootReference));
        if (root !== undefined) {
            return {
                reference: rootReference,
                context: root,
                selectedBy: 'root',
                explicitlySelected: false,
            };
        }
        return {
            reference: { kind: 'empty' },
            context: undefined,
            selectedBy: 'empty',
            explicitlySelected: false,
        };
    }

    public async resolveReference(selector: string): Promise<ContextReference> {
        if (selector === ':empty') return { kind: 'empty' };
        if (selector === ':root') return { kind: 'root' };
        if (selector.startsWith('id:')) {
            const id = selector.slice('id:'.length);
            if (id.length === 0) {
                throw new Error('context selector "id:" requires a non-empty id');
            }
            return { kind: 'id', id };
        }
        if (selector.startsWith(':')) {
            throw new Error(
                `unknown context selector "${selector}" (expected a folder, id:<name>, :root, or :empty)`,
            );
        }
        const folder = path.resolve(this._cwd, selector);
        return normalizeContextReference({
            kind: 'path',
            path: await canonicalDirectory(folder),
        });
    }

    public async set(
        reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
        values: ContextValues,
        options: { readonly createOnly?: boolean } = {},
    ): Promise<StoredContext> {
        reference = normalizeContextReference(reference);
        return this._mutate((contexts) => {
            const key = contextKey(reference);
            const existing = contexts.get(key);
            if (options.createOnly === true && existing !== undefined) {
                throw new Error(`context ${formatContextReference(reference)} already exists`);
            }
            const now = new Date().toISOString();
            const context: StoredContext = {
                key,
                reference,
                values: existing === undefined
                    ? normalizeContextValues(values)
                    : mergeContextValues(existing.values, values),
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            };
            contexts.set(key, context);
            return { value: context, changed: true };
        });
    }

    public async assertCanCreate(
        reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
    ): Promise<void> {
        reference = normalizeContextReference(reference);
        if ((await this._read()).has(contextKey(reference))) {
            throw new Error(`context ${formatContextReference(reference)} already exists`);
        }
    }

    public async replace(
        reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
        values: ContextValues,
        options: { readonly createOnly?: boolean } = {},
    ): Promise<StoredContext> {
        reference = normalizeContextReference(reference);
        return this._mutate((contexts) => {
            const key = contextKey(reference);
            const existing = contexts.get(key);
            if (options.createOnly === true && existing !== undefined) {
                throw new Error(`context ${formatContextReference(reference)} already exists`);
            }
            const now = new Date().toISOString();
            const context: StoredContext = {
                key,
                reference,
                values: normalizeContextValues(values),
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            };
            contexts.set(key, context);
            return { value: context, changed: true };
        });
    }

    public async unset(
        reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
        keys: readonly (keyof ContextValues)[],
    ): Promise<StoredContext> {
        reference = normalizeContextReference(reference);
        return this._mutate((contexts) => {
            const key = contextKey(reference);
            const existing = contexts.get(key);
            if (existing === undefined) {
                throw new Error(`context ${formatContextReference(reference)} does not exist`);
            }
            const values = { ...existing.values } as Record<keyof ContextValues, unknown>;
            for (const item of keys) delete values[item];
            const context: StoredContext = {
                ...existing,
                values: normalizeContextValues(values as ContextValues),
                updatedAt: new Date().toISOString(),
            };
            contexts.set(key, context);
            return { value: context, changed: true };
        });
    }

    public async remove(reference: ContextReference): Promise<boolean> {
        if (reference.kind === 'empty') {
            throw new Error(':empty is immutable and cannot be removed');
        }
        reference = normalizeContextReference(reference);
        return this._mutate((contexts) => {
            const removed = contexts.delete(contextKey(reference));
            return { value: removed, changed: removed };
        });
    }

    public async list(): Promise<readonly StoredContext[]> {
        return [...(await this._read()).values()].sort((a, b) =>
            formatContextReference(a.reference).localeCompare(formatContextReference(b.reference)));
    }

    private _selectedReference(
        contexts: ReadonlyMap<string, StoredContext>,
        reference: ContextReference,
        selectedBy: SelectedContext['selectedBy'],
        explicitlySelected: boolean,
        allowMissing: boolean,
    ): SelectedContext {
        if (reference.kind === 'empty') {
            return { reference, context: undefined, selectedBy, explicitlySelected };
        }
        const context = contexts.get(contextKey(reference));
        if (context === undefined && !allowMissing) {
            throw new Error(`context ${formatContextReference(reference)} does not exist`);
        }
        return { reference, context, selectedBy, explicitlySelected };
    }

    private async _read(): Promise<Map<string, StoredContext>> {
        let text: string;
        try {
            text = await readFile(this._file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
            throw error;
        }
        const value = JSON.parse(text) as Partial<ContextDocument>;
        if (value.version !== 1 || !Array.isArray(value.contexts)) {
            throw new Error(`invalid context store ${this._file}`);
        }
        const contexts = new Map<string, StoredContext>();
        for (const raw of value.contexts) {
            const context = parseStoredContext(raw);
            if (contexts.has(context.key)) {
                throw new Error(`duplicate context key "${context.key}" in ${this._file}`);
            }
            contexts.set(context.key, context);
        }
        return contexts;
    }

    private async _write(contexts: ReadonlyMap<string, StoredContext>): Promise<void> {
        await mkdir(path.dirname(this._file), { recursive: true });
        const document: ContextDocument = {
            version: 1,
            contexts: [...contexts.values()],
        };
        const temporary = `${this._file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(document, undefined, 2) + '\n', { mode: 0o600 });
        await rename(temporary, this._file);
        if (process.platform !== 'win32') await chmod(this._file, 0o600);
    }

    private async _mutate<T>(
        update: (contexts: Map<string, StoredContext>) => {
            readonly value: T;
            readonly changed: boolean;
        },
    ): Promise<T> {
        const release = await acquireContextStoreLock(this._file);
        try {
            const contexts = await this._read();
            const result = update(contexts);
            if (result.changed) await this._write(contexts);
            return result.value;
        } finally {
            await release();
        }
    }
}

export function mergeContextValues(
    base: ContextValues,
    overrides: ContextValues,
): ContextValues {
    const result: Record<string, unknown> = { ...base };
    const endpointSelectors = ([
        ['endpoint', overrides.endpoint],
        ['endpointCmd', overrides.endpointCmd],
        ['endpointCmdStdio', overrides.endpointCmdStdio],
    ] as const).filter((entry) => entry[1] !== undefined);
    if (endpointSelectors.length === 1) {
        delete result.endpoint;
        delete result.endpointCmd;
        delete result.endpointCmdStdio;
        const selector = endpointSelectors[0][0];
        if (selector === 'endpoint') {
            delete result.endpointCmdEnv;
            delete result.endpointCmdCwd;
            delete result.provisionIdentity;
            delete result.provisionIdentitySlot;
            const endpoint = overrides.endpoint;
            if (
                overrides.endpointToken === undefined
                && endpoint !== undefined
                && !/(?:[?&])token=%(?:[&#]|$)/.test(endpoint)
            ) {
                delete result.endpointToken;
            }
        } else {
            delete result.endpointToken;
            if (selector === 'endpointCmdStdio') {
                delete result.provisionIdentity;
                delete result.provisionIdentitySlot;
            }
        }
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) result[key] = value;
    }
    return normalizeContextValues(result as ContextValues);
}

async function acquireContextStoreLock(file: string): Promise<() => Promise<void>> {
    const lockFile = `${file}.lock`;
    const deadline = Date.now() + 5_000;
    await mkdir(path.dirname(file), { recursive: true });
    while (true) {
        try {
            const handle = await open(lockFile, 'wx', 0o600);
            try {
                await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
            } catch (error) {
                await handle.close();
                await unlink(lockFile);
                throw error;
            }
            return async () => {
                await handle.close();
                try {
                    await unlink(lockFile);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }

        try {
            const lockInfo = await stat(lockFile);
            if (Date.now() - lockInfo.mtimeMs > 30_000) {
                await unlink(lockFile);
                continue;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
        }
        if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for context store lock ${lockFile}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

export function contextKey(reference: ContextReference): string {
    reference = normalizeContextReference(reference);
    switch (reference.kind) {
        case 'empty': return ':empty';
        case 'root': return ':root';
        case 'id': return `id:${reference.id}`;
        case 'path': {
            const normalized = path.normalize(reference.path);
            return `path:${process.platform === 'win32' ? normalized.toLowerCase() : normalized}`;
        }
    }
}

export function formatContextReference(reference: ContextReference): string {
    reference = normalizeContextReference(reference);
    switch (reference.kind) {
        case 'empty': return ':empty';
        case 'root': return ':root';
        case 'id': return `id:${reference.id}`;
        case 'path': return reference.path;
    }
}

export function defaultContextStoreFile(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(
            process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
            'linkrpc',
            'contexts.json',
        );
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'linkrpc', 'contexts.json');
    }
    return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
        'linkrpc',
        'contexts.json',
    );
}

async function canonicalDirectory(folder: string): Promise<string> {
    let info;
    try {
        info = await stat(folder);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`context folder does not exist: ${folder}`);
        }
        throw error;
    }
    if (!info.isDirectory()) {
        throw new Error(`context path is not a directory: ${folder}`);
    }
    return path.normalize(await realpath(folder));
}

function normalizeContextReference(
    reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
): Exclude<ContextReference, { readonly kind: 'empty'; }>;
function normalizeContextReference(reference: ContextReference): ContextReference;
function normalizeContextReference(reference: ContextReference): ContextReference {
    if (
        process.platform !== 'win32'
        && reference.kind === 'path'
        && path.parse(path.normalize(reference.path)).root === path.normalize(reference.path)
    ) {
        return { kind: 'root' };
    }
    return reference;
}

function normalizeContextValues(values: ContextValues): ContextValues {
    return JSON.parse(JSON.stringify(values)) as ContextValues;
}

function parseStoredContext(value: unknown): StoredContext {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('invalid context entry');
    }
    const raw = value as Partial<StoredContext>;
    if (
        typeof raw.key !== 'string'
        || typeof raw.createdAt !== 'string'
        || typeof raw.updatedAt !== 'string'
        || typeof raw.reference !== 'object'
        || raw.reference === null
        || typeof raw.values !== 'object'
        || raw.values === null
    ) {
        throw new Error('invalid context entry');
    }
    const reference = raw.reference as ContextReference;
    if (
        reference.kind === 'empty'
        || !['root', 'id', 'path'].includes(reference.kind)
        || (reference.kind === 'id' && typeof reference.id !== 'string')
        || (reference.kind === 'path' && typeof reference.path !== 'string')
    ) {
        throw new Error('invalid context reference');
    }
    if (raw.key !== contextKey(reference)) {
        throw new Error(`context key mismatch for ${formatContextReference(reference)}`);
    }
    return {
        key: raw.key,
        reference,
        values: normalizeContextValues(raw.values),
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    };
}
