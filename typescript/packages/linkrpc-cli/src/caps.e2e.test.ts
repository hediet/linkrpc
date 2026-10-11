import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    defineInterface, KeypairSigningIdentity, requestType, TransportPair,
} from '@hediet/linkrpc';
import { createHubAccessConfig, HubAccessGrantSigner } from '@hediet/linkrpc-hub';
import {
    createHubServiceInterfaces, Hub, hubRegisterServiceId, registerHubAccessService,
    registerHubServices, RootOverlay, withForwardedCallGate, withVerifiedSignature,
} from '@hediet/linkrpc-hub/hub/server';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';

const exec = promisify(execFile);
const files = defineInterface({ id: 'test.files' }, {
    read: requestType(z.object({ path: z.string() }), z.object({ path: z.string() })),
});

describe('caps CLI on a gated hub', () => {
    it('parses shared shortcuts, persists grants and reuses broad scopes across processes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'linkrpc-caps-cli-'));
        const issuer = await KeypairSigningIdentity.generateNew();
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const service = hubRegisterServiceId(hub, 'files');
        const calls: string[] = [];
        service.connection.register(files, {
            read: ({ path }) => { calls.push(path); return { path }; },
        }, { serviceId: 'files' });
        service.connection.enableReflection({ serviceId: 'files' });
        let grants = 0;
        const access = createHubAccessConfig(new HubAccessGrantSigner(issuer, () => {
            grants++;
            return { result: 'permitted' };
        }).decide);
        const socket = await SocketServer.start();
        socket.setConnectionHandler(transport => {
            const pair = new TransportPair();
            const upstream = hub.attach(withForwardedCallGate(pair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: issuer.publicSigningIdentity.principal, isPublic: true }],
            }));
            const overlay = new RootOverlay({ uplink: pair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            registerHubAccessService(overlay.root, access);
            overlay.connectParticipant(withVerifiedSignature(transport, { verifySignatures: true }));
        });
        const common = ['--endpoint', `unix:${socket.endpoint}`, '--principal', `file:${join(directory, 'identity.json')}`];
        const invoke = (...args: string[]) => exec(process.execPath, [
            '--import', 'tsx', '--conditions=@hediet/source',
            fileURLToPath(new URL('./linkrpc.ts', import.meta.url)), ...common, ...args,
        ], { timeout: 20_000 });
        try {
            const help = await invoke('call', 'files::test.files::read', '--help');
            expect(help.stdout).toContain('--cap:request');
            expect(grants).toBe(0);
            expect(calls).toEqual([]);
            for (const profile of [[], ['hub']]) {
                for (const validation of [[], ['--no-validate']]) {
                    await expect(invoke(...profile, 'call', 'files::test.files::read',
                        '--p:path=/docs/a', ...validation)).rejects.toThrow(
                        profile.length === 0 ? 'missing $hubrpc envelope' : '--cap:request',
                    );
                    expect(grants).toBe(0);
                    expect(calls).toEqual([]);
                }
            }
            const requested = await invoke('hub', 'caps', 'request', 'files::test.files::read',
                '--p:path=/docs/a', '--cap:allow-prefix=/docs/', '--cap:duration=persistent');
            expect(JSON.parse(requested.stdout)).toMatchObject({ status: 'granted', reused: false });
            expect(calls).toEqual([]);
            const grantedCount = grants;
            expect(grantedCount).toBeGreaterThan(0);

            const listed = JSON.parse((await invoke('hub', 'caps', 'list', '--json')).stdout);
            expect(listed.capabilities.some((cap: { permissions: { params?: unknown }[] }) =>
                cap.permissions.some(permission => JSON.stringify(permission.params) === '{"path":{"prefix":"/docs/"}}'),
            )).toBe(true);

            await expect(invoke('call', 'files::test.files::read', '--p:path=/docs/stored'))
                .rejects.toThrow('missing $hubrpc envelope');
            expect(grants).toBe(grantedCount);
            const ordinary = await invoke('call', 'files::test.files::read', '--sign', '--validation=required', '--p:path=/docs/stored');
            expect(JSON.parse(ordinary.stdout)).toEqual({ path: '/docs/stored' });
            expect(grants).toBe(grantedCount);
            await expect(invoke('call', 'files::test.files::read', '--p:path=/other/a'))
                .rejects.toThrow('missing $hubrpc envelope');
            expect(grants).toBe(grantedCount);

            const called = await invoke('call', 'files::test.files::read', '--cap:request',
                '--p:path', '/docs/public/b', '--cap:allow-prefix', '/docs/public/');
            expect(JSON.parse(called.stdout)).toEqual({ path: '/docs/public/b' });
            expect(calls).toEqual(['/docs/stored', '/docs/public/b']);
            expect(grants).toBe(grantedCount);

            const reused = await invoke('hub', 'caps', 'request', 'files::test.files::read',
                '--p:path=/docs/c', '--cap:allow-param', 'path={"prefix":"/docs/"}');
            expect(JSON.parse(reused.stdout)).toMatchObject({ status: 'granted', reused: true });
            expect(grants).toBe(grantedCount);

            const pinned = await invoke('call', `files::test.files::read@${files.schemaHash}`,
                '--sign', '--p:path=/docs/pinned');
            expect(JSON.parse(pinned.stdout)).toEqual({ path: '/docs/pinned' });
            expect(grants).toBe(grantedCount);

            await expect(invoke('call', 'files::test.files::read', '--cap:request',
                '--p:path=/other/a', '--cap:allow-param', 'path={"prefix":"/docs/"}'))
                .rejects.toThrow('Parameters do not match');
            expect(calls).toEqual(['/docs/stored', '/docs/public/b', '/docs/pinned']);
            expect(grants).toBe(grantedCount);

            await expect(invoke('call', 'files::test.files::read', '--cap:request',
                '--no-sign', '--p:path=/docs/d')).rejects.toThrow('require signing');
            await expect(invoke('hub', 'call', 'files::test.files::read',
                '--no-sign', '--p:path=/docs/d')).rejects.toThrow('missing $hubrpc envelope');
            expect(grants).toBe(grantedCount);

            await invoke('call', 'files::test.files::read', '--cap:request',
                '--p:path=/docs/d', '--cap:allow-param', 'path={"prefix":"/"}');
            expect(grants).toBe(grantedCount + 1);
            expect(calls).toEqual(['/docs/stored', '/docs/public/b', '/docs/pinned', '/docs/d']);
        } finally {
            socket.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
