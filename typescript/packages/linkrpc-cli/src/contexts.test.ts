import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ContextStore,
    formatContextReference,
    mergeContextValues,
} from './contexts';

const cleanups: string[] = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linkrpc-context-'));
    cleanups.push(root);
    const project = path.join(root, 'project');
    const child = path.join(project, 'packages', 'child');
    await mkdir(child, { recursive: true });
    return {
        root,
        project,
        child,
        storeFile: path.join(root, 'data', 'contexts.json'),
    };
}

describe('ContextStore', () => {
    it('uses the immutable empty context when no path or root context exists', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.child });
        const selected = await store.select();
        expect(selected.reference).toEqual({ kind: 'empty' });
        expect(selected.selectedBy).toBe('empty');
    });

    it('walks from cwd to the closest path context', async () => {
        const f = await fixture();
        const projectStore = new ContextStore({ file: f.storeFile, cwd: f.project });
        const project = await projectStore.resolveReference('.');
        if (project.kind === 'empty') throw new Error('unexpected empty context');
        await projectStore.set(project, { endpoint: 'ws://project' });

        const childStore = new ContextStore({ file: f.storeFile, cwd: f.child });
        const selected = await childStore.select();
        expect(selected.selectedBy).toBe('cwd');
        expect(selected.context?.values.endpoint).toBe('ws://project');
        expect(formatContextReference(selected.reference)).toBe(await real(f.project));
    });

    it('falls back to the root context above filesystem roots', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.child });
        await store.set({ kind: 'root' }, { principal: 'user:root' });
        const selected = await store.select();
        expect(selected.reference).toEqual({ kind: 'root' });
        expect(selected.context?.values.principal).toBe('user:root');
    });

    it('selects named and explicit empty contexts', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.child });
        await store.set({ kind: 'id', id: 'production' }, { endpointToken: 'secret' });

        expect((await store.select({ selector: 'id:production' })).context?.values.endpointToken)
            .toBe('secret');
        expect((await store.select({ selector: ':empty' })).reference).toEqual({ kind: 'empty' });
    });

    it('requires explicitly selected contexts to exist unless mutation allows them', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.child });
        await expect(store.select({ selector: 'id:missing' })).rejects.toThrow(/does not exist/);
        const selected = await store.select({ selector: 'id:missing', allowMissing: true });
        expect(selected.context).toBeUndefined();
    });

    it('creates, merges, replaces, unsets, and removes contexts explicitly', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.project });
        const reference = await store.resolveReference('.');
        if (reference.kind === 'empty') throw new Error('unexpected empty context');

        await store.set(reference, { endpoint: 'ws://one', endpointToken: 'secret' }, { createOnly: true });
        await expect(store.assertCanCreate(reference)).rejects.toThrow(/already exists/);
        await expect(store.set(reference, {}, { createOnly: true })).rejects.toThrow(/already exists/);
        await store.set(reference, { endpoint: 'ws://two?token=%' });
        expect((await store.select({ selector: '.' })).context?.values).toEqual({
            endpoint: 'ws://two?token=%',
            endpointToken: 'secret',
        });

        await store.unset(reference, ['endpointToken']);
        expect((await store.select({ selector: '.' })).context?.values).toEqual({
            endpoint: 'ws://two?token=%',
        });

        await store.replace(reference, { principal: 'user:new' });
        expect((await store.select({ selector: '.' })).context?.values).toEqual({
            principal: 'user:new',
        });

        expect(await store.remove(reference)).toBe(true);
        expect(await store.remove(reference)).toBe(false);
    });

    it('persists endpoint tokens inline in the global user store', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.project });
        await store.set({ kind: 'id', id: 'production' }, {
            endpoint: 'wss://hub.example.com?token=%',
            endpointToken: 'inline-secret',
        });
        expect(await readFile(f.storeFile, 'utf8')).toContain('inline-secret');
    });

    it('serializes concurrent updates to different contexts', async () => {
        const f = await fixture();
        const first = new ContextStore({ file: f.storeFile, cwd: f.project });
        const second = new ContextStore({ file: f.storeFile, cwd: f.child });

        await Promise.all([
            first.set({ kind: 'id', id: 'first' }, { principal: 'user:first' }),
            second.set({ kind: 'id', id: 'second' }, { principal: 'user:second' }),
        ]);

        expect((await first.list()).map((context) => context.reference)).toEqual([
            { kind: 'id', id: 'first' },
            { kind: 'id', id: 'second' },
        ]);
    });

    it.runIf(process.platform !== 'win32')('treats / and :root as the same context', async () => {
        const f = await fixture();
        const store = new ContextStore({ file: f.storeFile, cwd: f.child });
        expect(await store.resolveReference('/')).toEqual({ kind: 'root' });

        const root = await store.resolveReference('/');
        if (root.kind === 'empty') throw new Error('unexpected empty context');
        await store.set(root, { endpoint: 'ws://root' });

        expect((await store.select({ selector: ':root' })).context?.values.endpoint)
            .toBe('ws://root');
    });
});

describe('mergeContextValues', () => {
    it('overlays only defined values', () => {
        expect(mergeContextValues(
            { endpoint: 'ws://one', principal: 'user:one' },
            { endpoint: 'ws://two', principal: undefined },
        )).toEqual({
            endpoint: 'ws://two',
            principal: 'user:one',
        });
    });

    it('replaces endpoint selectors and removes incompatible inherited values', () => {
        expect(mergeContextValues(
            {
                endpoint: 'wss://old.example?token=%',
                endpointToken: 'old-token',
                endpointCmdEnv: { OLD: 'value' },
                endpointCmdCwd: '/old',
            },
            { endpointCmd: 'node server.js' },
        )).toEqual({
            endpointCmd: 'node server.js',
            endpointCmdEnv: { OLD: 'value' },
            endpointCmdCwd: '/old',
        });

        expect(mergeContextValues(
            { endpointCmd: 'node old.js', endpointToken: 'old-token' },
            { endpoint: 'wss://new.example' },
        )).toEqual({ endpoint: 'wss://new.example' });
    });

    it('retains an inherited token only when the new endpoint opts in', () => {
        expect(mergeContextValues(
            { endpoint: 'wss://old.example', endpointToken: 'old-token' },
            { endpoint: 'wss://new.example?token=%' },
        )).toEqual({
            endpoint: 'wss://new.example?token=%',
            endpointToken: 'old-token',
        });
    });
});

async function real(folder: string): Promise<string> {
    return (await import('node:fs/promises')).realpath(folder);
}
