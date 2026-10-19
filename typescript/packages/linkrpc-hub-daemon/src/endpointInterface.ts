import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';
import { ServiceStatusSchema } from './managementInterface';

export const endpointAddress = z.object({
    namespace: z.string().min(1),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default('main'),
});
export const endpointDefinition = endpointAddress.extend({
    source: z.discriminatedUnion('kind', [
        z.object({
            kind: z.literal('process'),
            command: z.array(z.string().min(1)).min(1),
            cwd: z.string().optional(),
            env: z.record(z.string(), z.string()).default({}),
            rpc: z.boolean().default(true),
            readiness: z.enum(['connected', 'spawned']).default('connected'),
        }),
        z.object({ kind: z.literal('connection'), endpoint: z.string().min(1) }),
    ]),
    persistent: z.boolean().default(false),
    restart: z.enum(['never', 'on-failure', 'always']).default('never'),
});
export type EndpointDefinition = z.infer<typeof endpointDefinition>;
export const foregroundEndpointDefinition = endpointDefinition.extend({
    source: endpointDefinition.shape.source.options[0],
    persistent: z.literal(false).default(false),
});
export type ForegroundEndpointDefinition = z.infer<typeof foregroundEndpointDefinition>;
export type EndpointAddress = z.infer<typeof endpointAddress>;
export const endpointStatus = endpointAddress.extend({
    instanceId: z.string(),
    serviceId: z.string(),
    persistent: z.boolean(),
    restart: endpointDefinition.shape.restart,
    desired: z.boolean(),
    sourceKind: z.enum(['process', 'connection']),
    rpc: z.boolean(),
    runtime: ServiceStatusSchema,
});
export type EndpointStatus = z.infer<typeof endpointStatus>;
export const endpointEvent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('status'), status: endpointStatus }),
    z.object({ type: z.literal('output'), sequence: z.number(), stream: z.enum(['stdout', 'stderr', 'daemon']), text: z.string() }),
    z.object({ type: z.literal('removed') }),
]);
export type EndpointEvent = z.infer<typeof endpointEvent>;

export const managedEndpointsInterface = defineInterface({
    id: 'linkrpc.managedEndpoints',
    description: 'Manage named processes and connections on this execution host. Starting endpoints executes with this host user\'s privileges.',
}, {
    info: requestType(z.object({}), z.object({ hostname: z.string(), platform: z.string(), cwd: z.string(), servicePrefix: z.string() })),
    list: requestType(z.object({ namespace: z.string().optional() }), z.array(endpointStatus)),
    create: requestType(endpointDefinition, endpointStatus),
    runForeground: requestType(foregroundEndpointDefinition, z.object({}))
        .withStream({ server: endpointEvent }),
    start: requestType(endpointAddress, endpointStatus),
    stop: requestType(endpointAddress, z.object({})),
    remove: requestType(endpointAddress, z.object({})),
    configure: requestType(endpointAddress.extend({
        persistent: z.boolean().optional(),
        restart: z.enum(['never', 'on-failure', 'always']).optional(),
    }), endpointStatus),
    attach: requestType(endpointAddress.extend({ instanceId: z.string().optional(), after: z.number().int().nonnegative().default(0) }), z.object({}))
        .withStream({ server: endpointEvent }),
    input: requestType(endpointAddress.extend({
        instanceId: z.string(),
        input: z.discriminatedUnion('type', [
            z.object({ type: z.literal('stdin'), data: z.string() }),
            z.object({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM']) }),
        ]),
    }), z.object({})),
});
