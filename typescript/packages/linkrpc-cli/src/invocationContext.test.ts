import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextStore } from './contexts';
import {
    contextValuesFromEnvironment,
    mutationReference,
    resolveInvocationContext,
    resolveInvocationEndpoint,
    validationDefault,
    type ResolvedInvocationContext,
} from './invocationContext';

const cleanups: string[] = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linkrpc-invocation-'));
    cleanups.push(root);
    const project = path.join(root, 'project');
    const child = path.join(project, 'child');
    await mkdir(child, { recursive: true });
    const file = path.join(root, 'data', 'contexts.json');
    const projectStore = new ContextStore({ file, cwd: project });
    const reference = await projectStore.resolveReference('.');
    if (reference.kind === 'empty') throw new Error('unexpected empty context');
    await projectStore.set(reference, {
        endpoint: 'wss://context.example?token=%',
        endpointToken: 'context-token',
        principal: 'user:context',
    });
    return {
        child,
        file,
        store: new ContextStore({ file, cwd: child }),
    };
}

describe('resolveInvocationContext', () => {
    it('applies environment endpoint overrides by default for the hub profile', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'hub',
            store: f.store,
            env: {
                LINKRPC_ENDPOINT: 'wss://environment.example?token=%',
                LINKRPC_TOKEN: 'environment-token',
            },
        });
        expect(result.environmentApplied).toBe(true);
        expect(result.values).toMatchObject({
            endpoint: 'wss://environment.example?token=%',
            endpointToken: 'environment-token',
            principal: 'user:context',
        });
    });

    it('does not apply environment endpoint overrides by default for the RPC profile', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'rpc',
            store: f.store,
            env: { LINKRPC_ENDPOINT: 'wss://environment.example' },
        });
        expect(result.environmentApplied).toBe(false);
        expect(result.values.endpoint).toBe('wss://context.example?token=%');
    });

    it('suppresses hub environment overrides for an explicit --context', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'hub',
            store: f.store,
            selector: '..',
            env: { LINKRPC_ENDPOINT: 'wss://environment.example' },
        });
        expect(result.environmentApplied).toBe(false);
        expect(result.values.endpoint).toBe('wss://context.example?token=%');
    });

    it('allows explicit environment behavior to override profile defaults', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'rpc',
            store: f.store,
            useEnvironment: true,
            env: { HUBRPC_ENDPOINT: 'wss://legacy.example' },
        });
        expect(result.environmentApplied).toBe(true);
        expect(result.values.endpoint).toBe('wss://legacy.example');
    });

    it('applies CLI values after context and environment values', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'hub',
            store: f.store,
            cliOverrides: { endpoint: 'wss://flag.example', principal: 'user:flag' },
            env: { LINKRPC_ENDPOINT: 'wss://environment.example' },
        });
        expect(result.values.endpoint).toBe('wss://flag.example');
        expect(result.values.principal).toBe('user:flag');
    });

    it('replaces an inherited endpoint selector atomically', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'rpc',
            store: f.store,
            cliOverrides: { endpointCmd: 'node server.js' },
        });
        expect(result.values).toMatchObject({
            endpointCmd: 'node server.js',
            principal: 'user:context',
        });
        expect(result.values.endpoint).toBeUndefined();
        expect(result.values.endpointToken).toBeUndefined();
        expect(resolveInvocationEndpoint(result)).toMatchObject({
            kind: 'cmd-env',
        });
    });

    it('validates CLI command options when an environment endpoint wins', async () => {
        const f = await fixture();
        const result = await resolveInvocationContext({
            profile: 'hub',
            store: f.store,
            cliOverrides: { endpointCmdEnv: { KEY: 'value' } },
            env: { LINKRPC_ENDPOINT: 'wss://environment.example' },
        });
        expect(() => resolveInvocationEndpoint(result))
            .toThrow(/--endpoint-cmd-env requires/);
    });
});

describe('contextValuesFromEnvironment', () => {
    it('prefers LINKRPC variables over legacy HUBRPC variables', () => {
        expect(contextValuesFromEnvironment({
            LINKRPC_ENDPOINT: 'link',
            HUBRPC_ENDPOINT: 'hub',
            LINKRPC_TOKEN: 'link-token',
            HUBRPC_TOKEN: 'hub-token',
        })).toEqual({
            endpoint: 'link',
            endpointToken: 'link-token',
        });
    });
});

describe('mutationReference', () => {
    it('updates a discovered path context', async () => {
        const f = await fixture();
        const selected = await f.store.select();
        expect(await mutationReference(f.store, selected)).toEqual(selected.reference);
    });

    it('creates at cwd instead of implicitly mutating :root', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'linkrpc-root-context-'));
        cleanups.push(root);
        const store = new ContextStore({ file: path.join(root, 'contexts.json'), cwd: root });
        await store.set({ kind: 'root' }, { principal: 'user:root' });
        const selected = await store.select();
        const target = await mutationReference(store, selected);
        expect(target.kind).toBe('path');
        if (target.kind === 'path') expect(target.path).toBe(await real(root));
    });
});

describe('validationDefault', () => {
    it('uses auto for RPC and required for hub', () => {
        expect(validationDefault('rpc')).toBe('auto');
        expect(validationDefault('hub')).toBe('required');
    });

    describe('resolveInvocationEndpoint', () => {
        it('fills a context endpoint token placeholder', () => {
            expect(resolveInvocationEndpoint(invocation({
                contextValues: {
                    endpoint: 'wss://context.example?token=%',
                    endpointToken: 'context-token',
                },
            }))).toEqual({
                kind: 'ws',
                url: 'wss://context.example/',
                token: 'context-token',
            });
        });

        it('lets an explicit endpoint without a placeholder discard an inherited token', () => {
            expect(resolveInvocationEndpoint(invocation({
                contextValues: {
                    endpoint: 'wss://context.example?token=%',
                    endpointToken: 'context-token',
                },
                cliOverrides: { endpoint: 'wss://override.example' },
            }))).toEqual({
                kind: 'ws',
                url: 'wss://override.example/',
            });
        });

        it('uses an inherited token when an explicit endpoint opts in with token=%', () => {
            expect(resolveInvocationEndpoint(invocation({
                contextValues: { endpointToken: 'context-token' },
                cliOverrides: { endpoint: 'wss://override.example?token=%' },
            }))).toEqual({
                kind: 'ws',
                url: 'wss://override.example/',
                token: 'context-token',
            });
        });

        it('rejects an explicit token override without token=%', () => {
            expect(() => resolveInvocationEndpoint(invocation({
                cliOverrides: {
                    endpoint: 'wss://override.example?token=literal',
                    endpointToken: 'flag-token',
                },
            }))).toThrow(/requires --endpoint to contain exactly/);
        });

        it('preserves legacy environment endpoint plus token fallback behavior', () => {
            expect(resolveInvocationEndpoint(invocation({
                environmentValues: {
                    endpoint: 'wss://environment.example',
                    endpointToken: 'environment-token',
                },
            }))).toEqual({
                kind: 'ws',
                url: 'wss://environment.example/',
                token: 'environment-token',
            });
        });

        it('fills an environment endpoint placeholder from the environment token', () => {
            expect(resolveInvocationEndpoint(invocation({
                environmentValues: {
                    endpoint: 'wss://environment.example?token=%',
                    endpointToken: 'environment-token',
                },
            }))).toEqual({
                kind: 'ws',
                url: 'wss://environment.example/',
                token: 'environment-token',
            });
        });
    });
});

async function real(folder: string): Promise<string> {
    return (await import('node:fs/promises')).realpath(folder);
}

function invocation(
    values: Partial<ResolvedInvocationContext>,
): ResolvedInvocationContext {
    const contextValues = values.contextValues ?? {};
    const environmentValues = values.environmentValues ?? {};
    const cliOverrides = values.cliOverrides ?? {};
    return {
        profile: values.profile ?? 'hub',
        selected: values.selected ?? {
            reference: { kind: 'empty' },
            context: undefined,
            selectedBy: 'empty',
            explicitlySelected: false,
        },
        contextValues,
        environmentValues,
        cliOverrides,
        values: {
            ...contextValues,
            ...environmentValues,
            ...cliOverrides,
        },
        environmentApplied: values.environmentApplied ?? true,
    };
}
