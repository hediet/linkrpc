import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { applicationError, requestType } from '../schema/memberTypes';
import { TransportPair } from '../transport/messageTransport';
import { defineInterface, interfaceFromSchema } from '../connection/interfaceDefinition';

describe('interfaceFromSchema', () => {
    const sourceIface = defineInterface(
        { id: 'demo.example', description: 'd' },
        {
            add: requestType(
                z.object({ a: z.number(), b: z.number() }),
                z.object({ sum: z.number() }),
            ),
        },
    );

    it('preserves the original schema verbatim (description, methods, hash)', () => {
        const built = interfaceFromSchema(sourceIface.toSchema());
        expect(built.info.id).toBe('demo.example');
        expect(built.info.description).toBe('d');
        expect(built.schemaHash).toBe(sourceIface.schemaHash);
        expect(Object.keys(built.toSchema().methods)).toEqual(['add']);
    });

    it('exposes members keyed by method name so the connection can dispatch', () => {
        const built = interfaceFromSchema(sourceIface.toSchema());
        expect(Object.keys(built.members)).toEqual(['add']);
        expect(built.members['add']!.kind).toBe('request');
    });

    it('end-to-end: a connection can register handlers and serve calls', async () => {
        const pair = new TransportPair();
        const serverConn = LinkRpcConnection.fromTransport(pair.a);
        const clientConn = LinkRpcConnection.fromTransport(pair.b);

        const built = interfaceFromSchema(sourceIface.toSchema());
        serverConn.register(built, {
            add: (params: unknown) => {
                const p = params as { a: number; b: number; };
                return { sum: p.a + p.b };
            },
        } as never);

        // Client uses the original strongly-typed definition; same id+hash so
        // the server's frozen-schema registration matches.
        const client = clientConn.get(sourceIface);
        const out = await client.add({ a: 2, b: 3 });
        expect(out).toEqual({ sum: 5 });
    });

    it('imports referenced error contracts and validates dynamic server error values', async () => {
        const node = z.strictObject({
            label: z.string(),
            get children() { return z.array(node); },
        });
        const failure = applicationError(77, 'Tree', node);
        const source = defineInterface({ id: 'demo.imported-errors' }, {
            read: requestType(z.object({ malformed: z.boolean() }), z.string()).withErrors([failure]),
        });
        const imported = interfaceFromSchema(source.toSchema());
        expect(imported.toSchema()).toEqual(source.toSchema());
        const member = imported.members.read;
        if (member.kind !== 'request') throw new Error('expected imported request');
        const descriptor = member.errors[0];
        if (descriptor === undefined) throw new Error('missing imported error');
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        server.register(imported, {
            read: (params: unknown) => {
                const { malformed } = z.object({ malformed: z.boolean() }).parse(params);
                return descriptor.create({
                    label: 'root', children: [{ label: malformed ? 42 : 'leaf', children: [] }],
                });
            },
        });
        const remote = client.get(source);
        expect(await remote.read({ malformed: false }).result()).toEqual({
            ok: false,
            error: {
                kind: 'application', code: 77, message: 'Tree',
                data: { label: 'root', children: [{ label: 'leaf', children: [] }] },
            },
        });
        expect(await remote.read({ malformed: true }).result()).toMatchObject({
            ok: false, error: { kind: 'remote', code: -32603 },
        });
        server.close();
        client.close();
    });
});
