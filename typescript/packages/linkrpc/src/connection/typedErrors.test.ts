import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { TransportPair } from '../transport/messageTransport';
import { applicationError, RequestType, requestType } from '../schema/memberTypes';
import {
    defineInterface, type InterfaceClient, type InterfaceHandlers, type StreamingCall,
} from './interfaceDefinition';
import { LinkRpcConnection } from './linkRpcConnection';
import { RpcError, type IRequestSender } from './channel';

const notFound = applicationError(404, 'Not found');
const invalidState = applicationError(
    409,
    'Invalid state',
    z.object({ expected: z.string(), actual: z.string().nullable() }),
);
const nullable = applicationError(410, 'Nullable', z.string().nullable());
const loose = applicationError(411, 'Loose', z.unknown());
const undeclared = applicationError(499, 'Undeclared');

const typedErrorsInterface = defineInterface(
    { id: 'test.typed-errors' },
    {
        read: requestType(z.object({ id: z.string() }), z.string())
            .withErrors([notFound, invalidState, nullable] as const),
        watch: requestType(z.object({}), z.string())
            .withErrors([notFound] as const)
            .withStream({ server: z.string() }),
        collision: requestType(
            z.object({}),
            z.object({
                kind: z.literal('application'),
                code: z.number(),
                message: z.string(),
            }),
        ).withErrors([notFound] as const),
        opaque: requestType(z.object({}), z.unknown()).withErrors([notFound] as const),
        loose: requestType(z.object({}), z.string()).withErrors([loose] as const),
    },
);

function makePair(): { client: LinkRpcConnection; server: LinkRpcConnection; close(): void; } {
    const pair = new TransportPair();
    const client = LinkRpcConnection.fromTransport(pair.a);
    const server = LinkRpcConnection.fromTransport(pair.b);
    return { client, server, close: () => { client.close(); server.close(); } };
}

describe('typed application errors', () => {
    it('preserves Promise behavior and exposes explicit success/error results', async () => {
        const pair = makePair();
        pair.server.register(typedErrorsInterface, {
            read: ({ id }) => id === 'missing'
                ? notFound.create()
                : id === 'stale'
                    ? invalidState.create({ expected: 'new', actual: null })
                    : id === 'null'
                        ? nullable.create(null)
                    : `value:${id}`,
            watch: async (_params, _ctx, stream) => {
                await stream.send('progress');
                return notFound.create();
            },
            collision: () => ({ kind: 'application', code: 404, message: 'Not found' }),
            opaque: () => 'ok',
            loose: () => 'ok',
        });
        const client = pair.client.get(typedErrorsInterface);

        await expect(client.read({ id: 'ok' })).resolves.toBe('value:ok');
        expect(await client.read({ id: 'ok' }).result()).toEqual({
            ok: true,
            value: 'value:ok',
        });
        await expect(client.read({ id: 'missing' })).resolves.toMatchObject({ error: {
            code: 404,
            message: 'Not found',
        } });
        expect(await client.read({ id: 'missing' }).result()).toEqual({
            ok: false,
            error: { kind: 'application', code: 404, message: 'Not found' },
        });
        expect(await client.read({ id: 'stale' }).result()).toEqual({
            ok: false,
            error: {
                kind: 'application',
                code: 409,
                message: 'Invalid state',
                data: { expected: 'new', actual: null },
            },
        });
        expect(await client.read({ id: 'null' }).result()).toEqual({
            ok: false,
            error: {
                kind: 'application',
                code: 410,
                message: 'Nullable',
                data: null,
            },
        });
        await expect(client.collision({})).resolves.toEqual({
            kind: 'application',
            code: 404,
            message: 'Not found',
        });
        const progress: string[] = [];
        const stream = client.watch({}, { onMessage: (message) => progress.push(message) });
        expect(await stream.result()).toEqual({
            ok: false,
            error: { kind: 'application', code: 404, message: 'Not found' },
        });
        expect(progress).toEqual(['progress']);
        pair.close();
    });

    it('rejects undeclared branded errors and non-JSON declared data before encoding', async () => {
        const pair = makePair();
        let data: unknown;
        pair.server.register(typedErrorsInterface, {
            read: () => 'ok',
            watch: () => 'done',
            collision: () => ({ kind: 'application', code: 1, message: 'success' }),
            opaque: () => undeclared.create(),
            loose: () => loose.create(data),
        });
        const client = pair.client.get(typedErrorsInterface);

        await expect(client.opaque({})).rejects.toMatchObject({
            code: -32603,
            message: 'Undeclared application error 499',
        });
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        for (data of [undefined, { value: undefined }, [undefined], new Date(), cyclic, NaN, Infinity]) {
            const nonJson = await client.loose({}).result();
            expect(nonJson).toMatchObject({
                ok: false,
                error: { kind: 'remote', code: -32603 },
            });
        }
        pair.close();
    });

    it('does not promote unknown, wrong-message, or malformed errors', async () => {
        const peer = (error: RpcError): IRequestSender => ({
            sendRequest: async () => { throw error; },
            sendNotification: async () => {},
            sendRequestWithStream: () => ({
                result: Promise.reject(error),
                send: () => {},
                cancel: () => {},
                ping: async () => {},
            }),
            close: () => {},
        });

        for (const error of [
            new RpcError('Different', 404, undefined, 'remote', false),
            new RpcError('Invalid state', 409, { expected: 1, actual: null }, 'remote', true),
            new RpcError(
                'Invalid state',
                409,
                { expected: 'new', actual: null, extra: true },
                'remote',
                true,
            ),
            new RpcError('Not found', 404, null, 'remote', true),
            new RpcError('Other', 777, { preserved: true }, 'remote', true),
        ]) {
            const result = await new LinkRpcConnection(peer(error))
                .get(typedErrorsInterface).read({ id: 'x' }).result();
            expect(result).toMatchObject({
                ok: false,
                error: { kind: 'remote', code: error.code, message: error.message },
            });
        }
    });

    it('recognizes a later closed union branch without stripping its data', async () => {
        const failure = applicationError(412, 'Union', z.union([
            z.object({ a: z.string() }),
            z.object({ a: z.string(), b: z.string() }),
        ]));
        const definition = defineInterface({ id: 'test.union-errors' }, {
            read: requestType(z.object({ malformed: z.boolean() }), z.string()).withErrors([failure]),
        });
        const pair = makePair();
        pair.server.register(definition, {
            read: ({ malformed }) => {
                const data = malformed ? { a: 'a', b: 'b', extra: true } : { a: 'a', b: 'b' };
                return failure.create(data);
            },
        });
        const client = pair.client.get(definition);
        expect(await client.read({ malformed: false }).result()).toEqual({
            ok: false,
            error: { kind: 'application', code: 412, message: 'Union', data: { a: 'a', b: 'b' } },
        });
        expect(await client.read({ malformed: true }).result()).toMatchObject({
            ok: false,
            error: { kind: 'remote', code: -32603 },
        });
        pair.close();
    });

    it('keeps local and transport failures distinct and supports streaming calls', async () => {
        const local = new Error('transport unavailable');
        const sender: IRequestSender = {
            sendRequest: async () => { throw local; },
            sendNotification: async () => {},
            sendRequestWithStream: () => ({
                result: Promise.reject(local),
                send: () => {},
                cancel: () => {},
                ping: async () => {},
            }),
            close: () => {},
        };
        const client = new LinkRpcConnection(sender).get(typedErrorsInterface);
        expect(await client.read({ id: 'x' }).result()).toEqual({
            ok: false,
            error: { kind: 'local', cause: local },
        });
        const streaming = client.watch({});
        expectTypeOf(streaming.send).toBeFunction();
        expect(await streaming.result()).toEqual({
            ok: false,
            error: { kind: 'local', cause: local },
        });
    });

    it('exports normalized error schemas and validates descriptors', () => {
        const schema = typedErrorsInterface.toSchema();
        expect(schema.methods.read.errors).toEqual([
            { code: 404, message: 'Not found' },
            {
                code: 409,
                message: 'Invalid state',
                data: expect.objectContaining({ type: 'object' }),
            },
            {
                code: 410,
                message: 'Nullable',
                data: {
                    anyOf: [{ type: 'string' }, { type: 'null' }],
                },
            },
        ]);
        expect(() => applicationError(-32600, 'reserved')).toThrow(/reserved/);
        expect(() => applicationError(-32800, 'cancelled')).toThrow(/reserved/);
        expect(() => Reflect.apply(notFound.create, undefined, [{ unexpected: true }]))
            .toThrow(/does not accept data/);
        expect(() => Reflect.apply(invalidState.create, undefined, []))
            .toThrow(/requires exactly one data value/);
        expect(() => requestType(z.object({}), z.string()).withErrors([
            applicationError(1, 'one'),
            applicationError(1, 'duplicate'),
        ])).toThrow(/Duplicate/);
        expect(() => new RequestType(z.object({}), z.string(), z.void(), {}, undefined, undefined, [
            applicationError(1, 'one'),
            applicationError(1, 'duplicate'),
        ])).toThrow(/Duplicate/);
    });
});

type Handlers = InterfaceHandlers<typeof typedErrorsInterface>;
const generatedStyleValue = typedErrorsInterface.members.read.errors[1].create({
    expected: 'ready',
    actual: null,
});
void generatedStyleValue;
const validHandler: Handlers['read'] = () => invalidState.create({
    expected: 'ready',
    actual: null,
});
void validHandler;

// @ts-expect-error application error data is required and statically typed
invalidState.create({ expected: 42, actual: null });
// @ts-expect-error the descriptor tuple retains each error's data type
typedErrorsInterface.members.read.errors[1].create({ expected: 42, actual: null });
// @ts-expect-error undeclared application errors cannot be returned by this handler
const invalidHandler: Handlers['read'] = () => applicationError(500, 'Other').create();
void invalidHandler;

function checkLegacyClientCompatibility(stream: StreamingCall<string, never>): void {
    const legacy = defineInterface({ id: 'test.legacy-errors' }, {
        read: requestType(z.object({}), z.string()),
        legacyError: requestType(z.object({}), z.string(), z.any()),
        watch: requestType(z.object({}), z.string()).withStream({ server: z.string() }),
    });
    const client: InterfaceClient<typeof legacy> = {
        read: async () => 'ok',
        legacyError: async () => 'ok',
        watch: () => stream,
    };
    void client;
    const handler: InterfaceHandlers<typeof legacy> = {
        read: () => 'ok',
        // @ts-expect-error legacy any error schemas must not erase the success return type
        legacyError: () => 42,
        watch: () => 'ok',
    };
    void handler;
}
void checkLegacyClientCompatibility;
