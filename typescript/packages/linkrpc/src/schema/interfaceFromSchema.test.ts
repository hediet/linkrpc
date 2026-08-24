import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { requestType } from '../schema/memberTypes';
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
});
