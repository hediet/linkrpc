import { defineInterface, requestType } from '@hediet/linkrpc';
import {
    ConsoleTemplate,
    consoleAttachParamsSchema,
    consoleClientMessageSchema,
    consoleExitSchema,
    consoleModeSchema,
    consoleServerMessageSchema,
} from '@hediet/linkrpc-infra/console';
import { z } from 'zod';
import { ServiceStatusSchema } from './managementInterface';

export const endpointAddress = z.object({
    namespace: z.string().min(1),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default('main'),
});
export const processSource = z.object({
    kind: z.literal('process'),
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    rpc: z.boolean().default(true),
    /** Run in a pseudoterminal: stdout and stderr merge, and attachments can resize it. */
    tty: z.boolean().default(false),
    readiness: z.enum(['connected', 'spawned']).default('connected'),
});
export const endpointDefinition = endpointAddress.extend({
    source: z.discriminatedUnion('kind', [
        processSource,
        z.object({ kind: z.literal('connection'), endpoint: z.string().min(1) }),
    ]),
    persistent: z.boolean().default(false),
    restart: z.enum(['never', 'on-failure', 'always']).default('never'),
});
export type EndpointDefinition = z.infer<typeof endpointDefinition>;
export type EndpointAddress = z.infer<typeof endpointAddress>;
export const endpointStatus = endpointAddress.extend({
    instanceId: z.string(),
    serviceId: z.string(),
    persistent: z.boolean(),
    restart: endpointDefinition.shape.restart,
    desired: z.boolean(),
    /** Owned by a `run` call that stops and removes it when the call ends. */
    owned: z.boolean(),
    sourceKind: z.enum(['process', 'connection']),
    rpc: z.boolean(),
    /** Process endpoints have a console, reachable through the `consoles` template instance. */
    console: z.object({ mode: consoleModeSchema }).optional(),
    runtime: ServiceStatusSchema,
});
export type EndpointStatus = z.infer<typeof endpointStatus>;

const replace = z.boolean().optional()
    .describe('Stop and remove an existing endpoint with the same address first, including persistent and owned ones.');
export const runParams = z.object({
    definition: endpointDefinition.extend({ source: processSource }),
    /** The call owns the endpoint: ending it (cancellation, disconnect, or completion) stops and removes it. */
    owner: z.boolean().optional(),
    replace,
    console: consoleAttachParamsSchema,
});
export type RunParams = z.infer<typeof runParams>;
export const runEvent = z.union([
    consoleServerMessageSchema,
    z.object({ t: z.literal('status'), status: endpointStatus }),
]);
export type RunEvent = z.infer<typeof runEvent>;
export const watchEvent = z.discriminatedUnion('t', [
    z.object({ t: z.literal('status'), status: endpointStatus }),
    z.object({ t: z.literal('removed') }),
]);
export type WatchEvent = z.infer<typeof watchEvent>;

/** Console template parameters: the endpoint whose process console to use. */
export const consoleAddress = z.object({ namespace: z.string().min(1), id: z.string().min(1) });

export const managedEndpointsInterface = defineInterface({
    id: 'linkrpc.managedEndpoints',
    description: 'Manage named processes and connections on this execution host. Starting endpoints executes with this host user\'s privileges. '
        + 'Process consoles are served by the `consoles` instance of the `linkrpc.console.v1` template, with the endpoint address as params.',
}, {
    consoles: ConsoleTemplate({ params: consoleAddress }).mapMembers({ info: 'consoleInfo', attach: 'attachConsole' }),
    info: requestType(z.object({}), z.object({ hostname: z.string(), platform: z.string(), cwd: z.string(), servicePrefix: z.string() })),
    list: requestType(z.object({ namespace: z.string().optional() }), z.array(endpointStatus)),
    create: requestType(endpointDefinition.extend({ replace }), endpointStatus),
    run: requestType(runParams, z.object({ exit: z.nullable(consoleExitSchema) }), {
        description: 'Create a process endpoint and attach to its console in one call. The stream carries the '
            + '`linkrpc.console` attach protocol plus `status` events. Without `owner`, cancelling detaches.',
    }).withStream({ client: consoleClientMessageSchema, server: runEvent }),
    watch: requestType(endpointAddress, z.object({})).withStream({ server: watchEvent }),
    start: requestType(endpointAddress, endpointStatus),
    stop: requestType(endpointAddress, z.object({})),
    remove: requestType(endpointAddress, z.object({})),
    configure: requestType(endpointAddress.extend({
        persistent: z.boolean().optional(),
        restart: z.enum(['never', 'on-failure', 'always']).optional(),
    }), endpointStatus),
});
