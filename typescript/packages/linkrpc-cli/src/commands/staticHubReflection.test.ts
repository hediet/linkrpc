import {
    defineInterface,
    type IRequestSender,
    requestType,
} from '@hediet/linkrpc';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StaticHubSchema } from '../staticHubSchema';
import { withStaticHubReflection } from './staticHubReflection';

const greeter = defineInterface(
    { id: 'example.greeter' },
    {
        hello: requestType(
            z.object({ name: z.string() }),
            z.object({ greeting: z.string() }),
        ),
    },
);

function schema(): StaticHubSchema {
    const interfaceSchema = greeter.toSchema();
    const ref = {
        interfaceId: interfaceSchema.id,
        interfaceHash: interfaceSchema.hash,
    };
    return {
        services: [{
            serviceId: 'service',
            interfaces: [ref],
        }],
        defaultInterface: {
            interfaceId: interfaceSchema.id,
            interfaceHash: interfaceSchema.hash,
        },
        interfaceSchemas: [interfaceSchema],
    };
}

describe('withStaticHubReflection', () => {
    it('serves reflection locally and forwards application requests', async () => {
        const sendRequest = vi.fn(async () => ({ remote: true }));
        const remote = {
            sendRequest,
            sendNotification: vi.fn(async () => { }),
            sendRequestWithStream: () => {
                throw new Error('unexpected streaming request');
            },
            close: vi.fn(),
        } satisfies IRequestSender;
        const sender = withStaticHubReflection(remote, schema());

        await expect(sender.sendRequest('hubrpc.defaults::get', undefined))
            .resolves.toEqual({
                interfaceId: greeter.info.id,
                interfaceHash: greeter.toSchema().hash,
            });
        expect(sendRequest).not.toHaveBeenCalled();

        await expect(sender.sendRequest('hello', { name: 'Ada' }))
            .resolves.toEqual({ remote: true });
        expect(sendRequest).toHaveBeenCalledWith('hello', { name: 'Ada' }, undefined);
    });

    it('serves service-qualified reflection methods locally', async () => {
        const sendRequest = vi.fn(async () => ({ remote: true }));
        const remote = {
            sendRequest,
            sendNotification: vi.fn(async () => { }),
            sendRequestWithStream: () => {
                throw new Error('unexpected streaming request');
            },
            close: vi.fn(),
        } satisfies IRequestSender;
        const sender = withStaticHubReflection(remote, schema());
        const interfaceSchema = greeter.toSchema();

        await expect(sender.sendRequest('service::hubrpc.schemas::get', {
            interfaceId: interfaceSchema.id,
            hash: interfaceSchema.hash,
        })).resolves.toEqual({ schema: interfaceSchema });
        expect(sendRequest).not.toHaveBeenCalled();
    });

    it('uses the service mapping to disambiguate an omitted schema hash', async () => {
        const alternate = defineInterface(
            { id: 'example.greeter' },
            {
                goodbye: requestType(
                    z.object({ name: z.string() }),
                    z.object({ greeting: z.string() }),
                ),
            },
        ).toSchema();
        const primary = greeter.toSchema();
        const catalog: StaticHubSchema = {
            services: [
                {
                    serviceId: 'service-a',
                    interfaces: [{
                        interfaceId: primary.id,
                        interfaceHash: primary.hash,
                    }],
                },
                {
                    serviceId: 'service-b',
                    interfaces: [{
                        interfaceId: alternate.id,
                        interfaceHash: alternate.hash,
                    }],
                },
            ],
            interfaceSchemas: [primary, alternate],
        };
        const remote = {
            sendRequest: vi.fn(async () => ({ remote: true })),
            sendNotification: vi.fn(async () => { }),
            sendRequestWithStream: () => {
                throw new Error('unexpected streaming request');
            },
            close: vi.fn(),
        } satisfies IRequestSender;
        const sender = withStaticHubReflection(remote, catalog);

        await expect(sender.sendRequest('service-a::hubrpc.schemas::get', {
            interfaceId: primary.id,
        })).resolves.toEqual({ schema: primary });
    });
});
