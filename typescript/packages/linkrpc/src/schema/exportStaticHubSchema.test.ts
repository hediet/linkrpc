import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    bareInterfaceTarget, defaultsInterface, defineInterface, directoryInterface,
    LinkRpcConnection, requestType, schemasInterface, TransportPair,
} from '../index';
import { exportStaticHubSchema } from './exportStaticHubSchema';

const echo = defineInterface({ id: 'test.echo' }, { echo: requestType(z.string(), z.string()) });

function fixture() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    return { server, client, close: () => { server.close(); client.close(); } };
}

describe('exportStaticHubSchema', () => {
    it('exports schemas and exact directory/default/bare refs, not diagnostic directories', async () => {
        const f = fixture();
        f.server.register(bareInterfaceTarget(echo), { echo: (text) => text });
        f.server.enableReflection();
        try {
            const document = await exportStaticHubSchema(f.client.channel);
            expect(document.defaultInterface).toEqual({ interfaceId: echo.info.id, interfaceHash: echo.schemaHash });
            expect(document.bareInterfaces).toContainEqual({ interface: document.defaultInterface, prefix: '' });
            expect(document.services).toContainEqual(expect.objectContaining({ serviceId: '' }));
            expect(document.interfaceSchemas).toContainEqual(echo.toSchema());
            expect(document).not.toHaveProperty('directories');
        } finally { f.close(); }
    });

    it.each(['missing', 'truncated', 'depth', 'schema', 'default-hash', 'bindings'])(
        'fails explicitly for incomplete %s reflection', async (failure) => {
            const f = fixture();
            const ref = { interfaceId: echo.info.id, interfaceHash: echo.schemaHash };
            if (failure !== 'missing') {
                f.server.register(directoryInterface, {
                    list: () => ({
                        items: failure === 'depth'
                            ? [{ serviceId: 'nested', interfaceId: directoryInterface.info.id, interfaceHash: directoryInterface.schemaHash }]
                            : [{ serviceId: '', ...ref }],
                        ...(failure === 'truncated' ? { truncated: true } : {}),
                    }),
                    watch: () => ({}),
                });
                f.server.register(defaultsInterface, {
                    get: () => failure === 'default-hash' ? { interfaceId: echo.info.id } : {},
                    listBindings: () => {
                        if (failure === 'bindings') throw new Error('bindings unavailable');
                        return { bindings: [] };
                    },
                });
                f.server.register(schemasInterface, {
                    get: () => {
                        if (failure === 'schema') throw new Error('schema unavailable');
                        return { schema: echo.toSchema() };
                    },
                });
            }
            try {
                await expect(exportStaticHubSchema(f.client.channel, { maxDepth: 0 })).rejects.toThrow();
            } finally { f.close(); }
        },
    );
});
