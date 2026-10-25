import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IRequestSender, SigningCallCtx } from '@hediet/linkrpc';
import { cliIdentityTarget, deleteCliIdentity, MANAGED_FALLBACK_USER_ID, readCliIdentity, resolvePrincipal } from '@hediet/linkrpc-client-internal';
import { describe, expect, it } from 'vitest';
import { formatCliIdentity } from './identity';

const unusedSender = {} as IRequestSender<SigningCallCtx>;

describe('identity show', () => {
    it('keeps the HubRPC CLI identity slot for existing approvals', () => {
        expect(MANAGED_FALLBACK_USER_ID).toBe('hubrpc-cli');
    });

    it('reports the same persisted file principal across invocations', async () => {
        const file = resolve(`.linkrpc-cli-identity-test-${process.pid}-${Date.now()}.json`);
        try {
            const first = await resolvePrincipal({ kind: 'file', path: file }, unusedSender);
            const second = await resolvePrincipal({ kind: 'file', path: file }, unusedSender);

            expect(second.principal.id).toBe(first.principal.id);
            expect(JSON.parse(formatCliIdentity({
                principal: first.principal.id,
                source: first.source,
            }, true))).toEqual({
                version: 1,
                principal: first.principal.id,
                source: { kind: 'file', path: file },
            });
        } finally {
            await rm(file, { force: true });
            await rm(file.replace(/\.json$/, '.caps.json'), { force: true });
        }
    });

    it('renders a full human-readable principal', () => {
        const principal = 'id:key:0123456789abcdef';
        expect(formatCliIdentity({
            principal,
            source: { kind: 'user', id: 'operator' },
        })).toContain(`principal: ${principal}`);
    });
});

describe('logout target', () => {
    it('selects the identity named by --principal, falling back to user:hubrpc-cli for managed', () => {
        const labels = [
            { kind: 'managed' } as const,
            { kind: 'user', id: 'security-test' } as const,
            { kind: 'file', path: '/keys/ci.json' } as const,
        ].map(spec => {
            const target = cliIdentityTarget(spec);
            return { label: target.label, capsFile: target.capsFile.endsWith('.caps.json') };
        });
        expect({
            labels,
            distinctSlots: cliIdentityTarget({ kind: 'user', id: 'security-test' }).file !== cliIdentityTarget({ kind: 'managed' }).file,
        }).toEqual({
            labels: [
                { label: 'user:hubrpc-cli', capsFile: true },
                { label: 'user:security-test', capsFile: true },
                { label: 'file:/keys/ci.json', capsFile: true },
            ],
            distinctSlots: true,
        });
    });

    it('reports a newly created keypair, reads it back, and deletes only that identity', async () => {
        const file = resolve(`.linkrpc-cli-logout-test-${process.pid}-${Date.now()}.json`);
        const target = cliIdentityTarget({ kind: 'file', path: file });
        try {
            const before = await readCliIdentity(target);
            const first = await resolvePrincipal({ kind: 'file', path: file }, unusedSender);
            const second = await resolvePrincipal({ kind: 'file', path: file }, unusedSender);
            const stored = await readCliIdentity(target);
            const removed = await deleteCliIdentity(target);
            expect({
                before,
                createdFirst: first.createdFile,
                createdSecond: second.createdFile,
                storedMatches: stored === first.principal.id,
                removedIdentity: removed.includes(file),
                after: await readCliIdentity(target),
            }).toEqual({
                before: undefined,
                createdFirst: file,
                createdSecond: undefined,
                storedMatches: true,
                removedIdentity: true,
                after: undefined,
            });
        } finally {
            await rm(file, { force: true });
            await rm(target.capsFile, { force: true });
        }
    });
});
