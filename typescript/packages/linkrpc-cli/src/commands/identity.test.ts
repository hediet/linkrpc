import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IRequestSender, SigningCallCtx } from '@hediet/linkrpc';
import { resolvePrincipal } from '@hediet/linkrpc-client';
import { describe, expect, it } from 'vitest';
import { formatCliIdentity } from './identity';

const unusedSender = {} as IRequestSender<SigningCallCtx>;

describe('identity show', () => {
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
