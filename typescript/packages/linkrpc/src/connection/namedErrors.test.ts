import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
    applicationError, bareInterfaceTarget, defaultInterfaceTarget, defineInterface, ErrorCode, interfaceFromSchema, interfaceTarget, isRpcFailure, LinkRpcConnection,
    requestType, RpcError, RpcFailure, TransportPair, NonCompliantServerError,
    type InterfaceClient, type InterfaceHandlers,
    type InterfaceResultClient, type IRequestSender, type Result, type ApplicationErrorValue,
} from '../index';

const notFound = applicationError('NotFound', { message: 'Not found', data: z.object({ id: z.string() }) });
const denied = applicationError('Denied', { message: 'Denied' });
const custom = applicationError('Custom', { code: 42, data: z.string().nullable() });
const contract = defineInterface({ id: 'test.named-errors' }, {
    read: requestType(z.object({ id: z.string() }), z.string()).withErrors([notFound, denied, custom]),
    plain: requestType(z.object({}), z.string()),
    stream: requestType(z.object({}), z.string()).withErrors([denied])
        .withStream({ client: z.string(), server: z.string() }),
});

function sender(error: unknown, synchronous = false): IRequestSender {
    return {
        sendRequest: () => { if (synchronous) throw error; return Promise.reject(error); },
        sendRequestWithStream: () => {
            if (synchronous) throw error;
            return { result: Promise.reject(error), send() {}, cancel() {}, ping: async () => {} };
        },
        sendNotification: async () => {},
        close() {},
    };
}

describe('named application errors and result clients', () => {
    it('treats imported Rust format templates as metadata, preserving rendered remote messages', async () => {
        const imported = interfaceFromSchema({
            id: 'test.rust-frame-errors', hash: '',
            methods: {
                read: { params: true, result: { type: 'string' }, errors: [{
                    code: 1, type: 'Missing', message: 'Frame {frame_index} not found',
                    data: { type: 'object', properties: { frame_index: { type: 'integer' } },
                        required: ['frame_index'], additionalProperties: false },
                }] },
            },
        });
        const error = new RpcError('Frame 17 not found', 1,
            { type: 'Missing', data: { frame_index: 17 } }, 'remote');
        const connection = new LinkRpcConnection(sender(error));
        const result = await connection.get(imported).read({});
        expect(result).toEqual(new RpcFailure({
            kind: 'application', code: 1, type: 'Missing',
            message: 'Frame 17 not found', data: { frame_index: 17 },
        }));
        const read = imported.members.read;
        if (read.kind !== 'request') throw new Error('request expected');
        expect(read.errors[0].is(result)).toBe(true);
        expect(imported.toSchema().methods.read.errors![0].message).toBe('Frame {frame_index} not found');
    });

    it('preserves qualified and default routing in both client error policies', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const connection = LinkRpcConnection.fromTransport(pair.b);
        const target = interfaceTarget(contract, { serviceId: 'documents' });
        server.register(defaultInterfaceTarget(contract), {
            read: () => notFound.create({ id: 'missing' }),
            plain: () => 'ok',
            stream: () => denied.create(),
        }, { serviceId: 'documents' });
        for (const route of [target, defaultInterfaceTarget(contract)]) {
            const regular = connection.get(route);
            const safe = connection.getResultClient(route);
            expect(await regular.plain({})).toBe('ok');
            expect(await safe.plain({})).toBe('ok');
            expect(notFound.is(await regular.read({ id: 'missing' }))).toBe(true);
            expect(await safe.read({ id: 'missing' })).toMatchObject({
                error: { kind: 'application', error: { type: 'NotFound' } },
            });
            expect(await safe.stream({})).toMatchObject({
                error: { kind: 'application', error: { type: 'Denied' } },
            });
        }
        server.close();
        connection.close();
    });

    it('uses code 1 with tagged inner payloads and omits unit data', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const connection = LinkRpcConnection.fromTransport(pair.b);
        const imported = interfaceFromSchema(contract.toSchema());
        expect(imported.toSchema()).toEqual(contract.toSchema());
        expect(contract.toSchema().methods.read.errors).toMatchObject([
            { type: 'NotFound', code: 1, message: 'Not found', data: { type: 'object' } },
            { type: 'Denied', code: 1, message: 'Denied' },
            { type: 'Custom', code: 42, message: 'Custom' },
        ]);
        const read = imported.members.read;
        if (read.kind !== 'request') throw new Error('expected request');
        server.register(imported, {
            read: (params: { id: string }) => params.id === 'unit' ? read.errors[1].create()
                : params.id === 'null' ? read.errors[2].create(null)
                : read.errors[0].create({ id: params.id }),
            plain: () => 'ok',
            stream: () => 'ok',
        });
        for (const [id, data, code, message] of [
            ['missing', { type: 'NotFound', data: { id: 'missing' } }, 1, 'Not found'],
            ['unit', { type: 'Denied' }, 1, 'Denied'],
            ['null', { type: 'Custom', data: null }, 42, 'Custom'],
        ] as const) {
            await expect(connection.channel.sendRequest(`${contract.info.id}::read`, { id }))
                .rejects.toMatchObject({ code, message, data, origin: 'remote' });
        }
        const value = await connection.get(contract).read({ id: 'missing' });
        expect(isRpcFailure(value)).toBe(true);
        if (!isRpcFailure(value)) throw new Error('expected failure');
        expect(notFound.is(value)).toBe(true);
        if (notFound.is(value.error)) {
            expectTypeOf(value.error.data.id).toEqualTypeOf<string>();
            expect(value.error.data).toEqual({ id: 'missing' });
        }
        expect(await connection.getResultClient(contract).read({ id: 'unit' }))
            .toEqual(new RpcFailure({ kind: 'application', error: {
                kind: 'application', type: 'Denied', code: 1, message: 'Denied',
            } }));
        expect(await connection.getResultClient(contract).plain({})).toBe('ok');
        server.close();
        connection.close();
    });

    it('matches named errors by type, code and payload, not diagnostic message', async () => {
        const error = new RpcError('Localized diagnostic', 1, { type: 'NotFound', data: { id: 'x' } }, 'remote');
        const result = await new LinkRpcConnection(sender(error)).get(contract).read({ id: 'x' });
        expect(result).toEqual(new RpcFailure({
            kind: 'application', type: 'NotFound', code: 1, message: 'Localized diagnostic', data: { id: 'x' },
        }));
        if (notFound.is(result)) {
            expectTypeOf(result.error.data.id).toEqualTypeOf<string>();
        } else {
            throw new Error('descriptor did not match the failure wrapper');
        }
        expect(isRpcFailure({ error: result.error })).toBe(false);
        expect(notFound.is({ kind: 'application', type: 'NotFound', code: 1, message: 'x', data: { id: 2 } }))
            .toBe(false);
    });

    it('throws generic errors by default, and safe clients preserve remote origin even for standard codes', async () => {
        for (const error of [
            new RpcError('Unknown type', 1, { type: 'Unknown' }, 'remote'),
            new RpcError('Missing type', 1, { data: { id: 'x' } }, 'remote'),
            new RpcError('Wrong code', 42, { type: 'Denied' }, 'remote'),
            new RpcError('Wrong explicit override', 1, { type: 'Custom', data: null }, 'remote'),
            new RpcError('Wrong payload', 1, { type: 'NotFound', data: { id: 4 } }, 'remote'),
            new RpcError('Missing payload', 1, { type: 'NotFound' }, 'remote'),
            new RpcError('Extra payload', 1, { type: 'Denied', data: null }, 'remote'),
            new RpcError('Extra envelope field', 1, { type: 'Denied', extra: true }, 'remote'),
            new RpcError('Invalid request', -32600, undefined, 'remote'),
        ]) {
            const connection = new LinkRpcConnection(sender(error));
            if (error.code === -32600) {
                await expect(connection.get(contract).read({ id: 'x' })).rejects.toBe(error);
            } else {
                await expect(connection.get(contract).read({ id: 'x' })).rejects.toBeInstanceOf(NonCompliantServerError);
            }
            const safe = await connection.getResultClient(contract).read({ id: 'x' });
            expect(safe).toMatchObject({ error: { kind: 'generic', error: error.code === -32600
                ? { kind: 'remote', code: error.code }
                : { kind: 'nonCompliantServer', original: { code: error.code } } } });
            expect(await connection.getResultClient(contract).plain({}))
                .toMatchObject({ error: { kind: 'generic', error: { kind: 'remote' } } });
        }
    });

    it('distinguishes an absent nullable field from an explicit null', async () => {
        const state = applicationError('State', {
            data: z.object({ actual: z.string().nullable() }),
        });
        const definition = defineInterface({ id: 'test.nullable-field-error' }, {
            read: requestType(z.object({}), z.string()).withErrors([state]),
        });
        const explicitNull = new RpcError('Changed message', 1, { type: 'State', data: { actual: null } }, 'remote');
        expect(await new LinkRpcConnection(sender(explicitNull)).get(definition).read({})).toEqual(new RpcFailure({
            kind: 'application', type: 'State', code: 1, message: 'Changed message', data: { actual: null },
        }));
        for (const data of [{ type: 'State', data: {} }, { type: 'State', data: null }, { type: 'State' }]) {
            const invalid = new RpcError('State', 1, data, 'remote');
            const connection = new LinkRpcConnection(sender(invalid));
            await expect(connection.get(definition).read({})).rejects.toBeInstanceOf(NonCompliantServerError);
            expect(await connection.getResultClient(definition).read({}))
                .toMatchObject({ error: { kind: 'generic', error: { kind: 'nonCompliantServer' } } });
        }
    });

    it('never treats an unbranded successful object as a failure', async () => {
        const payload = z.object({
            kind: z.literal('application'), type: z.literal('NotFound'),
            code: z.number(), message: z.string(), data: z.object({ id: z.string() }),
        });
        const definition = defineInterface({ id: 'test.named-success-collision' }, {
            read: requestType(z.object({}), z.object({ error: payload })).withErrors([notFound]),
            direct: requestType(z.object({}), payload).withErrors([notFound]),
        });
        const success = {
            error: { kind: 'application' as const, type: 'NotFound' as const,
                code: 1, message: 'Not found', data: { id: 'x' } },
        };
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const connection = LinkRpcConnection.fromTransport(pair.b);
        server.register(definition, { read: () => success, direct: () => success.error });
        for (const value of [
            await connection.get(definition).read({}),
            await connection.getResultClient(definition).read({}),
        ]) {
            expect(value).toEqual(success);
            expect(isRpcFailure(value)).toBe(false);
            expect(notFound.is(value)).toBe(false);
            expect(notFound.is(value.error)).toBe(false);
        }
        for (const value of [
            await connection.get(definition).direct({}),
            await connection.getResultClient(definition).direct({}),
        ]) {
            expect(value).toEqual(success.error);
            expect(isRpcFailure(value)).toBe(false);
            expect(notFound.is(value)).toBe(false);
        }
        expect(notFound.is(notFound.create({ id: 'x' }))).toBe(true);
        expect(denied.is(denied.create())).toBe(true);
        server.close();
        connection.close();
    });

    it('supports safe metadata-free targets without sending LinkRPC routing metadata', async () => {
        const definition = defineInterface({ id: 'test.bare-safe-errors' }, {
            read: contract.members.read,
        });
        const target = bareInterfaceTarget(definition, { prefix: 'legacy/' });
        const failure = new RpcError('Different diagnostic', ErrorCode.applicationError,
            { type: 'NotFound', data: { id: 'missing' } }, 'remote');
        const initiationError = new Error('Synchronous initiation failure');
        const connection = new LinkRpcConnection({
            ...sender(failure),
            sendRequest(method, params, opts) {
                expect(method).toBe('legacy/read');
                expect(opts).toBeUndefined();
                if ((params as { id: string }).id === 'local') throw initiationError;
                return (params as { id: string }).id === 'ok' ? Promise.resolve('ok') : Promise.reject(failure);
            },
        });
        const safe = connection.getResultClient(target);
        expectTypeOf(safe).toEqualTypeOf<InterfaceResultClient<typeof definition>>();
        expect(await safe.read({ id: 'ok' })).toBe('ok');
        const missing = await safe.read({ id: 'missing' });
        expect(missing).toMatchObject({ error: { kind: 'application', error: { type: 'NotFound' } } });
        if (!isRpcFailure(missing) || missing.error.kind !== 'application') throw new Error('expected application failure');
        expect(notFound.is(missing.error.error)).toBe(true);
        expect(await safe.read({ id: 'local' })).toMatchObject({
            error: { kind: 'generic', error: { kind: 'local', cause: initiationError } },
        });
        // @ts-expect-error metadata-free targets do not accept LinkRPC routing options
        expect(() => connection.getResultClient(target, { serviceId: 'forbidden' })).toThrow(/do not accept/);
        expect(() => connection.getResultClient(bareInterfaceTarget(contract))).toThrow(/streaming method/);
    });

    it('captures synchronous initiation failures including streaming and preserves controls', async () => {
        for (const error of [new Error('Local initiation'), new RpcError('Transport closed', 1, undefined, 'transport')]) {
            const connection = new LinkRpcConnection(sender(error, true));
            const safe = connection.getResultClient(contract);
            const expected = { error: { kind: 'generic', error: {
                kind: error instanceof RpcError ? 'transport' : 'local', cause: error,
            } } };
            expect(await safe.plain({})).toMatchObject(expected);
            const stream = safe.stream({});
            expect(await stream).toMatchObject(expected);
            await expect(stream.send('x')).rejects.toBe(error);
            await expect(stream.cancel()).rejects.toBe(error);
            await expect(stream.ping()).rejects.toBe(error);
        }
        const safe = new LinkRpcConnection(sender(new Error('must not send'))).getResultClient(contract);
        expect(await safe.read({ id: 42 } as never)).toMatchObject({
            error: { kind: 'generic', error: { kind: 'local', cause: { code: -32602 } } },
        });
    });

    it('applies the default and safe policies to streaming terminal responses', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const connection = LinkRpcConnection.fromTransport(pair.b);
        server.register(contract, {
            read: () => 'ok', plain: () => 'ok',
            stream: async (_params, _ctx, stream) => {
                await stream.send('progress');
                return denied.create();
            },
        });
        const progress: string[] = [];
        const stream = connection.get(contract).stream({}, { onMessage: (value) => progress.push(value) });
        expect(stream.send).toBeTypeOf('function');
        expect(stream.cancel).toBeTypeOf('function');
        expect(stream.ping).toBeTypeOf('function');
        expect(await stream).toMatchObject({ error: { type: 'Denied' } });
        const safeStream = connection.getResultClient(contract).stream({});
        expect(safeStream.send).toBeTypeOf('function');
        expect(safeStream.cancel).toBeTypeOf('function');
        expect(safeStream.ping).toBeTypeOf('function');
        expect(await safeStream).toMatchObject({ error: { kind: 'application', error: { type: 'Denied' } } });
        expect(progress).toEqual(['progress']);
        server.close();
        connection.close();
    });

    it('rejects duplicate named types but permits shared codes', () => {
        expect(() => requestType(z.object({}), z.string()).withErrors([notFound, denied])).not.toThrow();
        expect(() => requestType(z.object({}), z.string()).withErrors([
            notFound, applicationError('NotFound', { code: 99 }),
        ])).toThrow(/Duplicate/);
        expect(() => applicationError('Reserved', { code: -32600 })).toThrow(/reserved/);
        expect(() => applicationError('')).toThrow(/nonempty/);
        const schema = contract.toSchema();
        expect(() => interfaceFromSchema({
            ...schema, methods: { read: { params: true, result: true,
                errors: [{ type: '', code: 1, message: 'Invalid' }],
            } },
        })).toThrow(/nonempty/);
    });

    it('recognizes named errors before legacy errors sharing their code', async () => {
        const legacy = applicationError(1, 'Not found', z.unknown());
        const mixed = defineInterface({ id: 'test.mixed-errors' }, {
            read: requestType(z.object({}), z.string()).withErrors([legacy, notFound]),
        });
        const named = new RpcError('Not found', 1, { type: 'NotFound', data: { id: 'x' } }, 'remote');
        expect(await new LinkRpcConnection(sender(named)).get(mixed).read({})).toEqual(new RpcFailure({
            kind: 'application', code: 1, message: 'Not found', type: 'NotFound', data: { id: 'x' },
        }));
        const old = new RpcError('Not found', 1, { id: 'x' }, 'remote');
        expect(await new LinkRpcConnection(sender(old)).get(mixed).read({})).toEqual(new RpcFailure({
            kind: 'application', code: 1, message: 'Not found', data: { id: 'x' },
        }));
        for (const data of [
            { type: 'NotFound', data: { id: 42 } },
            { type: 'NotFound', data: {} },
            { type: 'NotFound' },
            { type: 'NotFound', data: { id: 'x' }, extra: true },
        ]) {
            const malformed = new RpcError('Not found', 1, data, 'remote');
            const connection = new LinkRpcConnection(sender(malformed));
            expect(await connection.get(mixed).read({})).toEqual(new RpcFailure({
                kind: 'application', code: 1, message: 'Not found', data,
            }));
            expect(await connection.getResultClient(mixed).read({}))
                .toMatchObject({ error: { kind: 'application', error: { kind: 'application', data } } });
        }
        const unknownType = { type: 'Other', data: { id: 'x' } };
        expect(await new LinkRpcConnection(sender(new RpcError('Not found', 1, unknownType, 'remote')))
            .get(mixed).read({})).toEqual(new RpcFailure({
                kind: 'application', code: 1, message: 'Not found', data: unknownType,
            }));
    });
});

function checkTypes(
    client: InterfaceClient<typeof contract>,
    safe: InterfaceResultClient<typeof contract>,
): void {
    expectTypeOf<Awaited<ReturnType<typeof client.read>>>().toEqualTypeOf<Result<string,
        ApplicationErrorValue<1, string, { id: string }, 'NotFound'>
        | ApplicationErrorValue<1, string, never, 'Denied'>
        | ApplicationErrorValue<42, string, string | null, 'Custom'>>>();
    expectTypeOf(client.plain({})).toEqualTypeOf<Promise<string>>();
    void safe.plain({}).then((value) => {
        if (isRpcFailure(value)) {
            expectTypeOf(value.error.kind).toEqualTypeOf<'application' | 'generic'>();
        }
    });
    const handler: InterfaceHandlers<typeof contract>['read'] = () => notFound.create({ id: 'x' });
    void handler;
    // @ts-expect-error undeclared named types must not be accepted just because their codes match
    const bad: InterfaceHandlers<typeof contract>['read'] = () => applicationError('Other').create();
    void bad;
    // @ts-expect-error a unit error has no payload argument
    denied.create(null);
}
void checkTypes;
