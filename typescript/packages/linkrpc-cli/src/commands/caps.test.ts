import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    createSeededMemoryPrincipal, defaultInterfaceTarget, defineInterface, LinkRpcConnection, requestType,
    TransportPair, type SignedCapability,
} from '@hediet/linkrpc';
import { connectViaTransport, type SigningSession } from '@hediet/linkrpc-client-internal';
import { callCommand } from './call';
import { createParamMatchers, listCaps } from './caps';
import { rewriteParamShortcuts } from '../paramFlags';
import { mergeParams } from '../paramParsing';

const files = defineInterface({ id: 'test.files' }, {
    read: requestType(z.object({
        path: z.string(), mode: z.enum(['text', 'json']), tags: z.array(z.string()),
    }), z.object({ content: z.string() })),
});
const params = { path: '/docs/a', mode: 'text', tags: ['a'] };
const allowParams = ['path={"prefix":"/docs/"}', 'mode={"enum":["text","json"]}', 'tags={"subsetOf":["a","b"]}'];

describe('capability parameter constraints', () => {
    it.each([
        { param: '/docs/a', flag: '--cap:allow-prefix=/docs/', schema: { type: 'string' as const }, expected: { prefix: '/docs/' } },
        { param: 'text', flag: '--cap:allow-enum=["text","json"]', schema: { enum: ['text', 'json'] }, expected: { enum: ['text', 'json'] } },
        { param: '["read"]', flag: '--cap:allow-subset=["read","write"]', schema: { type: 'array' as const, items: { type: 'string' as const } }, expected: { subsetOf: ['read', 'write'] } },
        { param: '{"nested":42}', flag: '--cap:allow-any', schema: true, expected: { any: true } },
        { param: '[]', flag: '--cap:allow-subset=[]', schema: { type: 'array' as const, items: { type: 'string' as const } }, expected: { subsetOf: [] } },
    ])('validates normalized shortcut $flag with the same matcher path', ({ param, flag, schema, expected }) => {
        const normalized = rewriteParamShortcuts([`--p:value=${param}`, flag]);
        const params = mergeParams({ overrides: [normalized[1]] });
        expect(createParamMatchers(params, [normalized[3]], {
            type: 'object', properties: { value: schema }, required: ['value'], additionalProperties: false,
        })).toEqual({ value: expected });
    });

    it.each([
        { param: '42', flag: '--cap:allow-prefix=a', schema: { type: 'number' as const } },
        { param: 'text', flag: '--cap:allow-enum=["text",42]', schema: { type: 'string' as const } },
        { param: 'text', flag: '--cap:allow-enum=["json"]', schema: { type: 'string' as const } },
        { param: 'text', flag: '--cap:allow-any', schema: { type: 'string' as const } },
        { param: '["read"]', flag: '--cap:allow-subset=["write"]', schema: { type: 'array' as const, items: { type: 'string' as const } } },
        { param: '/else/a', flag: '--cap:allow-prefix=/docs/', schema: { type: 'string' as const } },
    ])('rejects invalid normalized shortcut $flag', ({ param, flag, schema }) => {
        const normalized = rewriteParamShortcuts([`--p:value=${param}`, flag]);
        expect(() => createParamMatchers(mergeParams({ overrides: [normalized[1]] }), [normalized[3]], {
            type: 'object', properties: { value: schema }, required: ['value'], additionalProperties: false,
        })).toThrow();
    });
    const methodSchema = {
        type: 'object' as const,
        properties: {
            path: { type: 'string' as const },
            mode: { enum: ['text', 'json'] },
            tags: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['path', 'mode', 'tags'],
        additionalProperties: false as const,
    };

    it('defaults arguments to exact constraints and relaxes explicit keys', () => {
        expect(createParamMatchers(params, [], methodSchema)).toMatchInlineSnapshot(`
          {
            "mode": {
              "exact": "text",
            },
            "path": {
              "exact": "/docs/a",
            },
            "tags": {
              "exact": [
                "a",
              ],
            },
          }
        `);
        expect(createParamMatchers(params, allowParams, methodSchema)).toMatchInlineSnapshot(`
          {
            "mode": {
              "enum": [
                "text",
                "json",
              ],
            },
            "path": {
              "prefix": "/docs/",
            },
            "tags": {
              "subsetOf": [
                "a",
                "b",
              ],
            },
          }
        `);
    });

    it.each([
        ['path={"enum":[42]}', 'scope does not match'],
        ['mode={"enum":["text","invalid"]}', 'scope does not match'],
        ['tags={"prefix":"a"}', 'scope does not match'],
        ['path={"any":true}', 'scope does not match'],
        ['unknown={"exact":"x"}', 'scope does not match'],
        ['path={"prefix":42}', 'Invalid --cap:allow-param'],
        ['path={"prefix":"/docs/","any":true}', 'Invalid --cap:allow-param'],
        ['path={"enum":[]}', 'Invalid --cap:allow-param'],
        ['path.nested={"any":true}', 'top-level'],
        ['path={"prefix":"/elsewhere/"}', 'Parameters do not match'],
        ['mode={"enum":["json"]}', 'Parameters do not match'],
        ['tags={"subsetOf":["b"]}', 'Parameters do not match'],
    ])('rejects %s', (allow, error) => {
        expect(() => createParamMatchers(params, [allow], methodSchema)).toThrow(error);
    });

    it('rejects duplicate matchers and missing example keys', () => {
        expect(() => createParamMatchers(params, [allowParams[0], allowParams[0]], methodSchema))
            .toThrow('Duplicate');
        expect(() => createParamMatchers({}, ['optional={"any":true}'], {
            type: 'object', properties: { optional: true }, additionalProperties: false,
        })).toThrow('param keys mismatch');
    });

    it('supports any for unknown schemas and follows component references', () => {
        expect(createParamMatchers({ value: 42 }, ['value={"any":true}'], {
            $ref: '#/components/schemas/Params',
        }, {
            Params: { type: 'object', properties: { value: true }, required: ['value'], additionalProperties: false },
        })).toEqual({ value: { any: true } });
    });

    it('checks enum alternatives with the reflected Zod validator', () => {
        expect(() => createParamMatchers({ email: 'a@example.com' }, [
            'email={"enum":["a@example.com","invalid"]}',
        ], {
            type: 'object', properties: { email: { type: 'string', format: 'email' } },
            required: ['email'], additionalProperties: false,
        })).toThrow('schema validation failed');
    });
});

async function fixture() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    const read = vi.fn(() => ({ content: 'hello' }));
    server.register(defaultInterfaceTarget(files), { read });
    server.enableReflection();
    server.service('files').register(files, { read });
    server.enableReflection({ serviceId: 'files' });
    const connection = connectViaTransport(pair.a);
    const principal = await createSeededMemoryPrincipal({ seed: 301 });
    const requestAccess = vi.fn<SigningSession['requestAccess']>(async request => {
        const cap: SignedCapability = {
            issuer: 'issuer', audience: principal.id, nonce: 'nonce',
            permissions: request.permissions.map(permission => ({
                ...permission,
                target: { ...permission.target, members: [...permission.target.members] },
            })),
            $hubrpcSignature: {},
        };
        await principal.capBag.add(cap);
        return { status: 'granted', capabilities: [cap], addedDurable: 1 };
    });
    const session: SigningSession = {
        principal, principalSource: { kind: 'user', id: 'test' },
        hubAccessMethod: 'hubAccess::requestAccess',
        listGrants: () => principal.capBag.capabilities,
        requestAccess,
    };
    return {
        channel: connection.channel, read, session, requestAccess,
        dispose: () => { connection.close(); server.close(); },
    };
}

describe('caps request and call --cap:request', () => {
    it('stores a scope without calling and reuses it for inline calls', async () => {
        const f = await fixture();
        try {
            const opts = {
                methodRef: 'files::test.files::read', paramsArg: JSON.stringify(params),
                allowParams, signingSession: f.session, requestCap: true,
            };
            const result = JSON.parse(await callCommand(f.channel, { ...opts, capabilityOnly: true }));
            expect({ status: result.status, reused: result.reused, addedDurable: result.addedDurable })
                .toMatchInlineSnapshot(`
                  {
                    "addedDurable": 1,
                    "reused": false,
                    "status": "granted",
                  }
                `);
            expect(f.read).not.toHaveBeenCalled();
            expect(f.requestAccess.mock.calls[0][0].permissions[0]).toEqual({
                target: {
                    serviceId: { exact: 'files' }, interfaceId: { exact: 'test.files' },
                    members: [{ exact: 'read' }],
                },
                canInvoke: true,
                params: { path: { prefix: '/docs/' }, mode: { enum: ['text', 'json'] }, tags: { subsetOf: ['a', 'b'] } },
            });
            expect(JSON.parse(await callCommand(f.channel, {
                ...opts, paramsArg: JSON.stringify({ ...params, path: '/docs/b', mode: 'json' }),
            }))).toEqual({ content: 'hello' });
            expect(f.requestAccess).toHaveBeenCalledTimes(1);
            expect(f.read).toHaveBeenCalledTimes(1);
            expect(JSON.parse(listCaps(f.session, true)).capabilities).toHaveLength(1);
        } finally { f.dispose(); }
    });

    it('requests broader scope even when the existing cap covers the concrete call', async () => {
        const f = await fixture();
        try {
            const opts = { methodRef: 'files::test.files::read', paramsArg: JSON.stringify(params), signingSession: f.session };
            await callCommand(f.channel, { ...opts, capabilityOnly: true });
            await callCommand(f.channel, { ...opts, requestCap: true, allowParams });
            expect(f.requestAccess).toHaveBeenCalledTimes(2);
        } finally { f.dispose(); }
    });

    it.each(['denied', 'insufficient', 'one-shot'])('does not execute on %s approval', async outcome => {
        const f = await fixture();
        try {
            f.requestAccess.mockImplementation(async request => {
                if (outcome === 'denied') return { status: 'denied', reason: 'No access' };
                if (outcome === 'insufficient') return { status: 'granted', capabilities: [], addedDurable: 0 };
                const cap: SignedCapability = {
                    issuer: 'issuer', audience: f.session.principal.id, nonce: 'once',
                    permissions: request.permissions.map(permission => ({
                        ...permission,
                        target: { ...permission.target, members: [...permission.target.members] },
                        callBind: { alg: 'sha256', payloadHash: 'one-call' },
                    })),
                    $hubrpcSignature: {},
                };
                return { status: 'granted', capabilities: [cap], addedDurable: 0 };
            });
            await expect(callCommand(f.channel, {
                methodRef: 'files::test.files::read', paramsArg: JSON.stringify(params),
                requestCap: true, allowParams, signingSession: f.session,
            })).rejects.toThrow(outcome === 'denied' ? 'No access' : 'durable scope');
            expect(f.read).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it.each(['read', 'test.files::read', 'files::test.files::read'])('resolves %s with shared call schema lookup', async methodRef => {
        const f = await fixture();
        try {
            await callCommand(f.channel, {
                methodRef, paramsArg: JSON.stringify(params), capabilityOnly: true,
                signingSession: f.session, duration: 'shortLived',
            });
            expect(f.requestAccess.mock.calls[0][0]).toMatchObject({
                duration: 'shortLived',
                permissions: [{
                    target: {
                        serviceId: { exact: methodRef.startsWith('files::') ? 'files' : '' },
                        interfaceId: { exact: 'test.files' },
                        members: [{ exact: 'read' }],
                    },
                }],
            });
            expect(f.read).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('rejects constraints before requesting authority or executing', async () => {
        const f = await fixture();
        try {
            await expect(callCommand(f.channel, {
                methodRef: 'files::test.files::read', paramsArg: JSON.stringify(params),
                requestCap: true, allowParams: ['path={"prefix":"/other/"}'], signingSession: f.session,
            })).rejects.toThrow('Parameters do not match');
            expect(f.requestAccess).not.toHaveBeenCalled();
            expect(f.read).not.toHaveBeenCalled();
            await expect(callCommand(f.channel, {
                methodRef: 'files::test.files::read', allowParams,
            })).rejects.toThrow('requires --cap:request');
            await expect(callCommand(f.channel, {
                methodRef: 'files::test.files::read', requestCap: true, noValidate: true,
            })).rejects.toThrow('require schema validation');
        } finally { f.dispose(); }
    });
});
