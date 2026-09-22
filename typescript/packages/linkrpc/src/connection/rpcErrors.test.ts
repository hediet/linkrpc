import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
    applicationError, bareInterfaceTarget, defaultInterfaceTarget, defineInterface,
    interfaceFromSchema, interfaceTarget, isRpcFailure, LinkRpcConnection,
    NonCompliantServerError, requestType, rpcError, RpcError, RpcFailure, TransportPair,
    type InterfaceClient, type InterfaceHandlers, type IRequestSender, type LinkRpcJsonSchema,
} from '../index';

const retry = rpcError(-32001, { message: z.string(), data: z.object({ retryAfter: z.number() }) });
const optional = rpcError(-32002, { message: z.string(), data: z.unknown().optional() });
const union = rpcError(-32003, { data: z.union([z.string(), z.number()]) });
const named = applicationError('NotFound', { data: z.object({ resource: z.string() }) });
const errors = [retry, optional, union, named] as const;
const contract = defineInterface({ id: 'test.raw-errors' }, {
    read: requestType(z.object({}), z.string()).withErrors(errors),
    watch: requestType(z.object({}), z.string()).withErrors(errors).withStream({ server: z.string() }),
});

function sender(error: unknown): IRequestSender {
    return {
        sendRequest: async () => { throw error; },
        sendRequestWithStream: () => ({
            result: Promise.reject(error), send() {}, cancel() {}, ping: async () => {},
        }),
        sendNotification: async () => {},
        close() {},
    };
}

describe('code-first rpc errors', () => {
    it.each([['unknown', z.unknown()], ['any', z.any()]] as const)(
        'retains code discrimination with %s body schemas', async (_name, schema) => {
            const broad = rpcError(-32004, schema);
            const broadContract = defineInterface({ id: 'test.broad-errors' }, {
                read: requestType(z.object({}), z.string()).withErrors([broad]),
            });
            const wire = new RpcError('Anything', -32004, { free: true }, 'remote');
            const result = await new LinkRpcConnection(sender(wire)).get(broadContract).read({});
            if (!isRpcFailure(result)) throw new Error('Expected a handled error');
            expectTypeOf(result.error.code).toEqualTypeOf<-32004>();
            expectTypeOf(result.error.message).toEqualTypeOf<string>();
            expectTypeOf(result.error.data).toEqualTypeOf<unknown>();
            expectTypeOf(broad.create({ message: 'Anything' }).code).toEqualTypeOf<-32004>();
            expect(result.error).toEqual({
                kind: 'application', code: -32004, message: 'Anything', data: { free: true },
            });
        },
    );

    it('handles foreign server codes with dynamic messages and nominal matchers', async () => {
        const wire = new RpcError('Retry in 3s', -32001, { retryAfter: 3 }, 'remote');
        const value = await new LinkRpcConnection(sender(wire)).get(contract).read({});
        expect(value).toEqual(new RpcFailure({
            kind: 'application', code: -32001, message: 'Retry in 3s', data: { retryAfter: 3 },
        }));
        expect(retry.is(value)).toBe(true);
        expect(retry.is(retry.create({ message: 'Try again', data: { retryAfter: 1 } }))).toBe(true);
        expect(retry.is({ kind: 'application', code: -32001, message: 'x', data: { retryAfter: 1 } })).toBe(false);
        expect(retry.is(new RpcFailure({ kind: 'application', code: -32001, message: 'x', data: { retryAfter: 1 } })))
            .toBe(false);
        expect(named.is(new RpcFailure({ kind: 'application', code: 1, message: 'x',
            type: 'NotFound', data: { resource: 'x' } }))).toBe(false);
        expect(retry.is(retry.create({ message: 'x', data: { retryAfter: 'bad' } } as never))).toBe(false);
    });

    it('selects by code before validation in qualified, default and bare routes', async () => {
        const requestOnly = defineInterface({ id: 'test.raw-routing' }, { read: contract.members.read });
        const routes = [interfaceTarget(requestOnly, { serviceId: 'service' }),
            defaultInterfaceTarget(requestOnly), bareInterfaceTarget(requestOnly, { prefix: 'foreign/' })];
        for (const route of routes) {
            const wire = new RpcError('Broken retry', -32001, { retryAfter: 'tomorrow' }, 'remote');
            const connection = new LinkRpcConnection(sender(wire));
            const call = connection.get(route).read({});
            const outcome = await call.result();
            if (outcome.ok) throw new Error('expected compliance error');
            expect(outcome.error).toBeInstanceOf(NonCompliantServerError);
            await expect(call).rejects.toBe(outcome.error);
            const safe = await connection.getResultClient(route).read({});
            if (!isRpcFailure(safe) || safe.error.kind !== 'generic') throw new Error('expected generic failure');
            expect(safe.error.error).toBeInstanceOf(NonCompliantServerError);
            if (!(safe.error.error instanceof NonCompliantServerError)) throw new Error('expected compliance error');
            expect(safe.error.error.original).toEqual({
                code: -32001, message: 'Broken retry', data: { retryAfter: 'tomorrow' },
            });
            expect(safe.error.error.issues).toEqual([
                { path: '/data/retryAfter', message: expect.stringContaining('number') },
            ]);
        }
    });

    it('reports named mismatches at the original error paths without becoming remote', async () => {
        for (const [data, path] of [
            [{ type: 'Other', data: { resource: 'x' } }, '/data/type'],
            [{ type: 'NotFound', data: { resource: 42 } }, '/data/data/resource'],
        ] as const) {
            const wire = new RpcError('Not found', 1, data, 'remote');
            const safe = await new LinkRpcConnection(sender(wire)).getResultClient(contract).read({});
            expect(safe).toMatchObject({ error: { kind: 'generic', error: {
                kind: 'nonCompliantServer', original: { code: 1, message: 'Not found', data },
                issues: expect.arrayContaining([{ path, message: expect.any(String) }]),
            } } });
        }
    });

    it('leaves undeclared codes remote and preserves absent versus null data', async () => {
        for (const hasData of [false, true]) {
            const wire = new RpcError('Unknown', -32099, null, 'remote', hasData);
            const connection = new LinkRpcConnection(sender(wire));
            await expect(connection.get(contract).read({})).rejects.toBe(wire);
            expect(await connection.getResultClient(contract).read({})).toEqual(new RpcFailure({
                kind: 'generic', error: { kind: 'remote', code: -32099, message: 'Unknown',
                    ...(hasData ? { data: null } : {}) },
            }));
        }
    });

    it('serializes and decodes optional data, explicit null, and arbitrary payload unions', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        let result: ReturnType<typeof optional.create> | ReturnType<typeof union.create>
            = optional.create({ message: 'absent' });
        server.register(contract, { read: () => result, watch: () => result });
        for (const value of [
            optional.create({ message: 'absent' }), optional.create({ message: 'null', data: null }),
            optional.create({ message: 'array', data: [false, 1] }),
            union.create({ message: 'string', data: 'no' }), union.create({ message: 'number', data: 42 }),
        ]) {
            result = value;
            expect(await client.get(contract).read({})).toEqual(new RpcFailure(value));
            expect(await client.get(contract).watch({})).toEqual(new RpcFailure(value));
            await expect(client.channel.sendRequest(`${contract.info.id}::read`, {})).rejects.toMatchObject({
                code: value.code, message: value.message, hasData: Object.hasOwn(value, 'data'),
            });
        }
        server.close();
        client.close();
    });

    it('rejects non-JSON data on serialization even when its schema is unknown', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        let data: unknown;
        server.register(contract, {
            read: () => optional.create({ message: 'invalid', data }), watch: () => 'ok',
        });
        for (data of [undefined, new Date(), NaN, { nested: undefined }, [,]]) {
            expect(await client.getResultClient(contract).read({})).toMatchObject({
                error: { kind: 'generic', error: { kind: 'remote', code: -32603 } },
            });
        }
        server.close();
        client.close();
    });

    it('applies compliance errors to terminal streams and preserves their controls', async () => {
        const wire = new RpcError('Invalid terminal', -32003, null, 'remote');
        const connection = new LinkRpcConnection(sender(wire));
        const call = connection.get(contract).watch({});
        const outcome = await call.result();
        if (outcome.ok) throw new Error('expected failure');
        await expect(call).rejects.toBe(outcome.error);
        expect(outcome.error).toBeInstanceOf(NonCompliantServerError);
        const safe = connection.getResultClient(contract).watch({});
        expect(safe.send).toBeTypeOf('function');
        expect(safe.cancel).toBeTypeOf('function');
        expect(safe.ping).toBeTypeOf('function');
        expect(await safe).toMatchObject({ error: { kind: 'generic',
            error: { kind: 'nonCompliantServer', original: { code: -32003, data: null } } } });
        const compliance = new NonCompliantServerError(
            { code: -32001, message: 'bad' }, [{ path: '/data', message: 'Required' }],
        );
        const forwarded = await new LinkRpcConnection(sender(compliance)).getResultClient(contract).read({});
        if (!isRpcFailure(forwarded) || forwarded.error.kind !== 'generic') throw new Error('expected generic failure');
        expect(forwarded.error.error).toBe(compliance);
    });

    it('supports body-schema unions, including literal message constraints', async () => {
        const bodyError = rpcError(-32004, z.union([
            z.object({ message: z.literal('retry'), data: z.number() }),
            z.object({ message: z.literal('stop'), data: z.null().optional() }),
        ]));
        const definition = defineInterface({ id: 'test.raw-body-union' }, {
            read: requestType(z.object({}), z.string()).withErrors([bodyError]),
        });
        const imported = interfaceFromSchema(definition.toSchema());
        expect(imported.toSchema()).toEqual(definition.toSchema());
        for (const [message, data, hasData] of [['retry', 2, true], ['stop', null, false], ['stop', null, true]] as const) {
            const value = await new LinkRpcConnection(sender(new RpcError(message, -32004, data, 'remote', hasData)))
                .get(definition).read({});
            expect(bodyError.is(value)).toBe(true);
        }
        const connection = new LinkRpcConnection(sender(new RpcError('wrong', -32004, 2, 'remote')));
        const importedRead = imported.members.read;
        if (importedRead.kind !== 'request') throw new Error('expected request');
        const result = await connection.getResultClient(defineInterface(
            { id: imported.info.id }, { read: importedRead },
        )).read({});
        expect(result).toMatchObject({ error: { kind: 'generic', error: {
            kind: 'nonCompliantServer', issues: expect.arrayContaining([
                { path: '/message', message: expect.any(String) },
            ]),
        } } });
    });

    it('uses the declared decoder for required unknown, optional, nullable, and stripped data', async () => {
        for (const [schema, acceptsAbsent, acceptsNull] of [
            [z.object({ message: z.string(), data: z.unknown() }), false, true],
            [z.object({ message: z.string(), data: z.string().optional() }), true, false],
            [z.object({ message: z.string(), data: z.string().nullable() }), false, true],
            [z.object({ message: z.string() }), true, true],
            [z.strictObject({ message: z.string() }), true, false],
        ] as const) {
            const descriptor = rpcError(-32005, schema);
            const definition = defineInterface({ id: 'test.data-presence' }, {
                read: requestType(z.object({}), z.string()).withErrors([descriptor]),
            });
            for (const hasData of [false, true]) {
                const wire = new RpcError('diagnostic', -32005, null, 'remote', hasData);
                const result = await new LinkRpcConnection(sender(wire)).getResultClient(definition).read({});
                const valid = hasData ? acceptsNull : acceptsAbsent;
                expect(result).toMatchObject({ error: { kind: valid ? 'application' : 'generic' } });
                if (!valid) {
                    expect(result).toMatchObject({ error: { error: {
                        original: { code: -32005, message: 'diagnostic', ...(hasData ? { data: null } : {}) },
                        issues: expect.arrayContaining([{ path: '/data', message: expect.any(String) }]),
                    } } });
                }
            }
        }
    });

    it('reports JSON Pointer paths through payload unions and escaped property names', async () => {
        const descriptor = rpcError(-32006, { data: z.union([
            z.object({ 'a/b': z.object({ '~value': z.number() }) }),
            z.object({ kind: z.literal('other') }),
        ]) });
        const definition = defineInterface({ id: 'test.issue-pointers' }, {
            read: requestType(z.object({}), z.string()).withErrors([descriptor]),
        });
        const wire = new RpcError('Invalid', -32006, { 'a/b': { '~value': false } }, 'remote');
        const result = await new LinkRpcConnection(sender(wire)).getResultClient(definition).read({});
        expect(result).toMatchObject({ error: { error: {
            issues: expect.arrayContaining([{ path: '/data/a~1b/~0value', message: expect.any(String) }]),
        } } });
    });

    it('tries named branches before legacy branches and reports failure only when all reject', async () => {
        const first = applicationError('First', { data: z.object({ resource: z.string() }) });
        const second = applicationError('Second', { data: z.number() });
        const legacy = applicationError(1, 'Legacy', z.object({ value: z.boolean() }));
        const definition = defineInterface({ id: 'test.named-legacy-union' }, {
            read: requestType(z.object({}), z.string()).withErrors([legacy, first, second]),
        });
        const response = (data: import('../protocol/jsonValue').JsonValue) =>
            new LinkRpcConnection(sender(new RpcError('Legacy', 1, data, 'remote'))).getResultClient(definition).read({});
        expect(await response({ type: 'Second', data: 42 })).toMatchObject({
            error: { kind: 'application', error: { type: 'Second', data: 42 } },
        });
        expect(await response({ value: true })).toMatchObject({
            error: { kind: 'application', error: { data: { value: true } } },
        });
        expect(await response({ type: 'Other' })).toMatchObject({
            error: { kind: 'generic', error: { kind: 'nonCompliantServer' } },
        });
    });

    it('requires string messages even when an imported body union accepts everything', async () => {
        for (const schema of [true, { anyOf: [true, { type: 'null' }] }] satisfies LinkRpcJsonSchema[]) {
            const definition = interfaceFromSchema({
                id: 'test.raw-top', hash: '', methods: { read: { params: true, result: true,
                    errors: [{ code: -32001, schema }],
                } },
            });
            const bad = new RpcError(42 as never, -32001, undefined, 'remote', false);
            await expect(new LinkRpcConnection(sender(bad)).get(definition).read({}))
                .rejects.toMatchObject({ kind: 'nonCompliantServer',
                    issues: [{ path: '/message', message: expect.any(String) }] });
        }
    });

    it.each(['raw', 'named', 'legacy'] as const)(
        'decodes %s errors once and returns the parsed output in every client view', async (kind) => {
            let parses = 0;
            const dataSchema = z.object({
                retryAfter: z.coerce.number().refine((value) => { parses++; return value > 0; }),
                reason: z.string().default('try later'),
            });
            const descriptor = kind === 'raw'
                ? rpcError(42, { message: z.string().trim(), data: dataSchema })
                : kind === 'named'
                ? applicationError('Retry', { code: 42, data: dataSchema })
                : applicationError(42, 'Diagnostic', dataSchema);
            const read = requestType(z.object({}), z.string()).withErrors([descriptor]);
            const definition = defineInterface({ id: 'test.single-pass' }, {
                read, watch: read.withStream({ server: z.string() }),
            });
            const wireData = { retryAfter: '3', extra: true };
            const wire = new RpcError(kind === 'raw' ? ' Diagnostic ' : 'Diagnostic', 42,
                kind === 'named' ? { type: 'Retry', data: wireData } : wireData, 'remote');
            const connection = new LinkRpcConnection(sender(wire));
            const expected = {
                kind: 'application', code: 42, message: 'Diagnostic',
                ...(kind === 'named' ? { type: 'Retry' } : {}),
                data: { retryAfter: 3, reason: 'try later' },
            };
            const call = connection.get(definition).read({});
            expect(await call).toEqual(new RpcFailure(expected));
            expect(await call.result()).toEqual({ ok: false, error: expected });
            expect(parses).toBe(1);
            expect(await connection.getResultClient(definition).read({}))
                .toEqual(new RpcFailure({ kind: 'application', error: expected }));
            expect(parses).toBe(2);
            expect(await connection.get(definition).watch({})).toEqual(new RpcFailure(expected));
            expect(parses).toBe(3);
            expect(await connection.getResultClient(definition).watch({}))
                .toEqual(new RpcFailure({ kind: 'application', error: expected }));
            expect(parses).toBe(4);

            const invalidData = { retryAfter: -1 };
            const invalid = new RpcError('Diagnostic', 42,
                kind === 'named' ? { type: 'Retry', data: invalidData } : invalidData, 'remote');
            await expect(new LinkRpcConnection(sender(invalid)).get(definition).read({}))
                .rejects.toMatchObject({
                    kind: 'nonCompliantServer',
                    issues: [{ path: kind === 'named' ? '/data/data/retryAfter' : '/data/retryAfter',
                        message: expect.any(String) }],
                });
            expect(parses).toBe(5);
            const unknown = new RpcError('Undeclared', 43, wireData, 'remote');
            await expect(new LinkRpcConnection(sender(unknown)).get(definition).read({})).rejects.toBe(unknown);
            expect(parses).toBe(5);
        },
    );

    it.each(['raw', 'named', 'legacy'] as const)(
        'validates outgoing %s errors once without replacing the body with parsed output', async (kind) => {
            let parses = 0;
            const dataSchema = z.object({ retryAfter: z.number() }).refine(() => { parses++; return true; });
            const raw = rpcError(42, { message: z.string().trim(), data: dataSchema });
            const named = applicationError('Retry', { code: 42, message: ' Diagnostic ', data: dataSchema });
            const legacy = applicationError(42, ' Diagnostic ', dataSchema);
            const data = { retryAfter: 3, extra: true };
            const descriptor = kind === 'raw' ? raw : kind === 'named' ? named : legacy;
            const value = kind === 'raw' ? raw.create({ message: ' Diagnostic ', data })
                : kind === 'named' ? named.create(data) : legacy.create(data);
            const read = requestType(z.object({}), z.string()).withErrors([descriptor]);
            const definition = defineInterface({ id: 'test.single-pass-outgoing' }, {
                read, watch: read.withStream({ server: z.string() }),
            });
            const pair = new TransportPair();
            const server = LinkRpcConnection.fromTransport(pair.a);
            const client = LinkRpcConnection.fromTransport(pair.b);
            server.register(definition, { read: () => value, watch: () => value });
            try {
                for (const method of ['read', 'watch']) {
                    await expect(client.channel.sendRequest(`${definition.info.id}::${method}`, {}))
                        .rejects.toMatchObject({
                            code: 42, message: ' Diagnostic ',
                            data: kind === 'named' ? { type: 'Retry', data } : data,
                        });
                }
                expect(parses).toBe(2);
            } finally {
                server.close();
                client.close();
            }
        },
    );

    it('disallows raw code collisions but retains named and legacy union candidates', () => {
        for (const declarations of [
            [retry, retry], [rpcError(1, { message: z.string() }), named],
            [rpcError(42, {}), applicationError(42, 'Legacy')],
        ] as const) {
            expect(() => requestType(z.object({}), z.string()).withErrors(declarations)).toThrow(/shared|Duplicate/);
        }
        expect(() => rpcError(-32600, {})).not.toThrow();
        expect(() => applicationError('Reserved', { code: -32600 })).toThrow(/reserved/);
        expect(() => rpcError(1.5, {})).toThrow(/integer/);
        expect(() => rpcError(2147483648, {})).toThrow(/integer/);
        const schema = contract.toSchema();
        for (const declarations of [
            [{ code: 1, schema: true }, { code: 1, type: 'Named', message: 'Named' }],
            [{ code: -32001, schema: true }, { code: -32001, schema: false }],
        ]) {
            expect(() => interfaceFromSchema({ ...schema, methods: {
                read: { params: true, result: true, errors: declarations },
            } })).toThrow(/shared/);
        }
        expect(() => interfaceFromSchema({ ...schema, methods: {
            read: { params: true, result: true,
                errors: [{ code: -32001, schema: true, message: 'invalid' } as never] },
        } })).toThrow(/only code and schema/);
    });
});

function checkTypes(client: InterfaceClient<typeof contract>): void {
    const unknown = rpcError(-32006, { data: z.unknown() });
    // @ts-expect-error unknown payload is required unless explicitly optional
    unknown.create({ message: 'missing' });
    unknown.create({ message: 'present', data: null });
    void client.read({}).then((result) => {
        if (!isRpcFailure(result)) return;
        switch (result.error.code) {
            case -32001:
                expectTypeOf(result.error.data).toEqualTypeOf<{ retryAfter: number }>();
                // @ts-expect-error numeric code narrowing excludes named payloads
                result.error.data.resource;
                break;
            case -32002:
                expectTypeOf(result.error.data).toEqualTypeOf<unknown>();
                break;
            case -32003:
                expectTypeOf(result.error.data).toEqualTypeOf<string | number>();
                break;
            case 1:
                expectTypeOf(result.error.type).toEqualTypeOf<'NotFound'>();
                // @ts-expect-error named code does not expose raw retry data
                result.error.data.retryAfter;
                break;
        }
        if (retry.is(result)) expectTypeOf(result.error.data.retryAfter).toEqualTypeOf<number>();
        if (named.is(result)) {
            expectTypeOf(result.error.type).toEqualTypeOf<'NotFound'>();
            expectTypeOf(result.error.data.resource).toEqualTypeOf<string>();
            // @ts-expect-error nominal named narrowing excludes raw payloads
            result.error.data.retryAfter;
        }
    });
    const handler: InterfaceHandlers<typeof contract>['read'] = () =>
        retry.create({ message: 'retry', data: { retryAfter: 1 } });
    void handler;
    // @ts-expect-error required data cannot be omitted
    retry.create({ message: 'retry' });
    // @ts-expect-error message is always required when creating a wire error
    optional.create({ data: null });
    // @ts-expect-error the payload union excludes null
    union.create({ message: 'union', data: null });
}
void checkTypes;
