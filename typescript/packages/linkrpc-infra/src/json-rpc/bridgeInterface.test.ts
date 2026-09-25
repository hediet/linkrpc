import { computeInterfaceHash, defineInterface, notificationType, requestType, type LinkRpcInterfaceSchema } from '@hediet/linkrpc';
import { describe, expect, it } from 'vitest';
import { object, string } from 'zod/mini';
import { createJsonRpcBridgeInterface, injectJsonRpcConnectionId } from './bridgeInterface';

describe('JSON-RPC bridge interface', () => {
    it('injects the connection parameter into referenced schemas without mutating the source', () => {
        const original: LinkRpcInterfaceSchema = {
            id: 'test.ref',
            hash: '',
            methods: { call: { params: { $ref: '#/components/schemas/Params' }, result: { type: 'null' } } },
            components: { schemas: { Params: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } },
        };
        const result = injectJsonRpcConnectionId(original);
        expect(result.methods.call?.params).toMatchObject({
            properties: { value: { type: 'string' }, jsonRpcConnectionId: { type: 'string' } },
            required: ['value'],
        });
        expect(result.hash).toBe(computeInterfaceHash(result));
        expect(original.components?.schemas?.Params).not.toHaveProperty('properties.jsonRpcConnectionId');
    });

    it('acknowledges notifications and rejects collisions with the reserved parameter', () => {
        const source = defineInterface({ id: 'test.bridge' }, {
            log: notificationType(object({ text: string() })),
            call: requestType(object({ text: string() }), object({ text: string() })),
        });
        const bridge = createJsonRpcBridgeInterface(source, { acknowledgeNotifications: ['log'] });
        expect(bridge.members.log.kind).toBe('request');
        expect(bridge.members.call.kind).toBe('request');
        expect(bridge.schemaHash).not.toBe(source.schemaHash);
        expect(() => injectJsonRpcConnectionId({
            ...source.toSchema(),
            methods: {
                call: { params: { type: 'object', properties: { jsonRpcConnectionId: { type: 'string' } }, additionalProperties: false } },
            },
        })).toThrow("already defines reserved parameter 'jsonRpcConnectionId'");
    });
});
