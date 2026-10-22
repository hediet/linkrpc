import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    createSeededMemoryPrincipal, defineInterface, LinkRpcConnection, requestType, TransportPair,
} from '@hediet/linkrpc';
import * as client from '@hediet/linkrpc-client-internal';
import { main } from './cli';
import { ContextStore, type ContextValues } from './contexts';

const iface = defineInterface({ id: 'test.profile' }, {
    ping: requestType(z.object({}), z.object({ ok: z.boolean() })),
});

afterEach(() => vi.restoreAllMocks());

async function fixture(values: ContextValues = {}) {
    const principal = await createSeededMemoryPrincipal({ seed: 308 });
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    const ping = vi.fn(() => ({ ok: true }));
    server.register(iface, { ping });
    server.enableReflection();
    const connection = client.connectViaTransport(pair.a);
    const connect = vi.spyOn(client, 'connect').mockResolvedValue(connection);
    const signing = vi.spyOn(client, 'setupSigning').mockResolvedValue({
        principal, principalSource: { kind: 'user', id: 'test' },
        hubAccessMethod: 'hubAccess::requestAccess',
        listGrants: () => principal.capBag.capabilities,
        requestAccess: vi.fn(async () => ({ status: 'denied', reason: 'test denied' })),
    });
    const reflection = vi.spyOn(client, 'requestReflectionAccess').mockResolvedValue('granted');
    vi.spyOn(ContextStore.prototype, 'select').mockResolvedValue({
        reference: { kind: 'id', id: 'test' }, selectedBy: 'argument', explicitlySelected: true,
        context: { key: 'id:test', reference: { kind: 'id', id: 'test' }, values, createdAt: '', updatedAt: '' },
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
        connect, signing, reflection, ping,
        invoke: (args: string[], executable: 'linkrpc' | 'rpc' | 'hub' = 'linkrpc') =>
            main(['--endpoint', 'ws://profile.test', ...args], executable),
        dispose: () => { connection.close(); server.close(); },
    };
}

describe('shared call signing profile overrides', () => {
    it('ls disables broad up-front and sign-time negotiation', async () => {
        const f = await fixture();
        try {
            await f.invoke(['ls'], 'hub');
            expect(f.reflection).not.toHaveBeenCalled();
            expect(f.signing.mock.calls[0][3]).toMatchObject({ autoNegotiatePerCall: false });
        } finally { f.dispose(); }
    });
    it.each(['--request-cap', '--allow-param', '--duration'])('rejects obsolete flag %s', async flag => {
        const f = await fixture();
        try {
            vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
            await expect(f.invoke(['call', 'test.profile::ping', flag])).rejects.toThrow('exit 1');
            expect(f.connect).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it.each([
        { executable: 'linkrpc' as const, prefix: [], sign: undefined, expected: false },
        { executable: 'rpc' as const, prefix: [], sign: undefined, expected: false },
        { executable: 'hub' as const, prefix: [], sign: undefined, expected: true },
        { executable: 'linkrpc' as const, prefix: ['hub'], sign: undefined, expected: true },
        { executable: 'rpc' as const, prefix: ['hub'], sign: undefined, expected: true },
        { executable: 'linkrpc' as const, prefix: [], sign: '--sign', expected: true },
        { executable: 'hub' as const, prefix: [], sign: '--no-sign', expected: false },
    ])('$executable $prefix $sign enables signing=$expected', async ({ executable, prefix, sign, expected }) => {
        const f = await fixture();
        try {
            await f.invoke([...prefix, 'call', 'test.profile::ping', '--params={}', ...(sign ? [sign] : [])], executable);
            expect(f.signing).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(f.reflection).not.toHaveBeenCalled();
            expect(f.ping).toHaveBeenCalledOnce();
        } finally { f.dispose(); }
    });

    it.each([
        { contextSign: true, flag: undefined, expected: true },
        { contextSign: true, flag: '--no-sign', expected: false },
        { contextSign: false, flag: '--sign', expected: true },
        { contextSign: false, flag: undefined, expected: false },
    ])('context sign=$contextSign, CLI=$flag => $expected', async ({ contextSign, flag, expected }) => {
        const f = await fixture({ sign: contextSign });
        try {
            await f.invoke(['call', 'test.profile::ping', '--params={}', ...(flag ? [flag] : [])]);
            expect(f.signing).toHaveBeenCalledTimes(expected ? 1 : 0);
        } finally { f.dispose(); }
    });

    it.each([{}, { sign: false }])('rejects --no-sign or saved disabled signing before connecting: %j', async values => {
        const f = await fixture(values);
        try {
            await expect(f.invoke([
                'call', 'test.profile::ping', '--cap:request', '--params={}',
                ...(values.sign === false ? [] : ['--no-sign']),
            ])).rejects.toThrow('require signing');
            expect(f.connect).not.toHaveBeenCalled();
            expect(f.ping).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('implicitly signs explicit capability requests without changing the command profile', async () => {
        const f = await fixture();
        try {
            await expect(f.invoke(['call', 'test.profile::ping', '--cap:request', '--params={}']))
                .rejects.toThrow('test denied');
            expect(f.signing).toHaveBeenCalledOnce();
            expect(f.signing.mock.calls[0][3]).toMatchObject({ autoNegotiatePerCall: false });
            expect(f.ping).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it.each(['--no-validate', '--validation=off'])('rejects explicit request with %s without executing', async flag => {
        const f = await fixture();
        try {
            await expect(f.invoke(['call', 'test.profile::ping', '--cap:request', '--params={}', flag]))
                .rejects.toThrow('require schema validation');
            expect(f.connect).not.toHaveBeenCalled();
            expect(f.reflection).not.toHaveBeenCalled();
            expect(f.ping).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it.each(['--sign', '--cap:request'])('rejects %s for raw endpoints', async flag => {
        const f = await fixture();
        try {
            await expect(f.invoke([
                'call', 'test.profile::ping', flag, '--params={}', '--endpoint=ws-no-init://profile.test',
            ])).rejects.toThrow('initialized LinkRPC endpoint');
            expect(f.signing).not.toHaveBeenCalled();
            expect(f.ping).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it.each(['--sign', '--no-sign'])('collects %s when saving context settings', async flag => {
        const f = await fixture();
        try {
            const set = vi.spyOn(ContextStore.prototype, 'set').mockImplementation(async (reference, values) => ({
                reference, values, key: 'id:test', createdAt: '', updatedAt: '',
            }));
            await f.invoke(['--context=id:test', 'context', 'set', flag]);
            expect(set.mock.calls[0][1]).toEqual({ endpoint: 'ws://profile.test', sign: flag === '--sign' });
            expect(f.connect).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });
});

describe('capability management command profile boundary', () => {
    it.each(['linkrpc', 'rpc', 'hub'] as const)('shows profile-specific commands in %s help', async executable => {
        const f = await fixture();
        try {
            const output: string[] = [];
            vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
            vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
            await expect(f.invoke(['--help'], executable)).rejects.toThrow('exit 0');
            expect(output.join('').includes('caps')).toBe(executable === 'hub');
            expect(f.connect).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });
    it.each(['linkrpc', 'rpc'] as const)('rejects %s caps before connecting', async executable => {
        const f = await fixture();
        try {
            vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
            await expect(f.invoke(['caps', 'list'], executable)).rejects.toThrow('exit 1');
            expect(f.connect).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it.each([
        { executable: 'hub' as const, prefix: [] },
        { executable: 'linkrpc' as const, prefix: ['hub'] },
        { executable: 'rpc' as const, prefix: ['hub'] },
    ])('supports $executable $prefix caps list', async ({ executable, prefix }) => {
        const f = await fixture();
        try {
            await f.invoke([...prefix, 'caps', 'list', '--json'], executable);
            expect(f.signing).toHaveBeenCalledOnce();
            expect(f.reflection).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });
});
