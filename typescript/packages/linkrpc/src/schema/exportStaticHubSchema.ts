import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { withRpcTimeout } from '../connection/requestTimeout';
import { HubDirectoryExplorer, type ReflectionChannel } from '../hub/common/directoryWalk';
import { defaultsInterface, directoryInterface, schemasInterface } from '../hub/common/reflection.interfaces';
import { safeParse } from 'zod/v4/core';
import { parseStaticHubSchema, type InterfaceRef, type StaticHubSchemaDocument } from './staticHubSchema';
import type { LinkRpcInterfaceSchema } from './linkRpcInterfaceSchema';

export interface ExportStaticHubSchemaOptions {
    /** Directory and default-binding reflection scope; omitted means the connection root. */
    serviceId?: string;
    maxDepth?: number;
    timeoutMs?: number;
}

/** Export a complete static contract, failing on missing reflection, schemas, or truncated discovery. */
export async function exportStaticHubSchema(
    channel: ReflectionChannel,
    options: ExportStaticHubSchemaOptions = {},
): Promise<StaticHubSchemaDocument> {
    if (options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)) {
        throw new Error('maxDepth must be a non-negative integer');
    }
    const cursors = new Map<string, Set<string>>();
    const timed: ReflectionChannel = {
        close: () => {},
        sendRequest: (method, params, opts) => {
            const call = channel.sendRequestWithStream(method, params, opts);
            return withRpcTimeout(Object.assign(call.result, {
                cancel: (reason?: string) => call.cancel(reason),
                dispose: (reason?: string) => call.dispose?.(reason),
            }), `contract export ${method}`, options.timeoutMs);
        },
        sendNotification: (method, params, opts) => channel.sendNotification(method, params, opts),
        sendRequestWithStream: (method, params, opts) => {
            const call = channel.sendRequestWithStream(method, params, opts);
            if (!method.endsWith('hubrpc.directory::list')) return call;
            return {
                send: (payload) => call.send(payload),
                cancel: (reason) => call.cancel(reason),
                dispose: (reason) => call.dispose?.(reason),
                ping: () => call.ping(),
                result: call.result.then((raw) => {
                    const parsed = safeParse(directoryInterface.members.list.resultSchema, raw);
                    if (!parsed.success) throw new Error(`Invalid directory response from ${method}`);
                    const page = parsed.data;
                    if (page.truncated) throw new Error(`Truncated directory response from ${method}`);
                    if (!params || typeof params !== 'object' || !('cursor' in params)) cursors.set(method, new Set());
                    if (page.nextCursor !== undefined) {
                        const seen = cursors.get(method)!;
                        if (seen.has(page.nextCursor)) throw new Error(`Repeated directory cursor from ${method}`);
                        seen.add(page.nextCursor);
                    }
                    return raw;
                }),
            };
        },
    };
    const connection = new LinkRpcConnection(timed);
    const explorer = new HubDirectoryExplorer(timed, {
        rootTarget: options.serviceId,
        maxDepth: options.maxDepth,
        timeoutMs: options.timeoutMs,
    });
    try {
        await explorer.explore();
        const snapshot = explorer.graphSnapshot;
        const incomplete = [snapshot.root, ...snapshot.directories].filter((node) => node.state !== 'loaded');
        if (!snapshot.complete || incomplete.length !== 0 || snapshot.result.inaccessible.length !== 0) {
            throw new Error(`Incomplete contract directory discovery: ${incomplete.map((node) =>
                `${node.target.serviceId ?? '<root>'}: ${node.inaccessibleReason ?? node.state}`).join(', ')}`);
        }
        const explored = new Set([snapshot.root, ...snapshot.directories].map((node) => node.target.serviceId ?? ''));
        for (const listing of snapshot.result.listings) {
            if (listing.interfaceId === directoryInterface.info.id && !explored.has(listing.serviceId)) {
                throw new Error(`Incomplete contract directory discovery: '${listing.serviceId}' exceeds maxDepth`);
            }
        }
        const defaults = connection.get(defaultsInterface, { serviceId: options.serviceId });
        const preset = await defaults.get({});
        const { bindings } = await defaults.listBindings({});
        if ((preset.interfaceId === undefined) !== (preset.interfaceHash === undefined)) {
            throw new Error('Incomplete default interface reference: both interfaceId and interfaceHash are required');
        }
        if (preset.serviceId !== undefined && preset.interfaceId === undefined) {
            throw new Error('A service-only preset cannot be represented by defaultInterface');
        }
        const services = new Map<string, InterfaceRef[]>();
        const schemas = new Map<string, LinkRpcInterfaceSchema>();
        async function resolve(ref: InterfaceRef, serviceId?: string): Promise<void> {
            const key = `${ref.interfaceId}@${ref.interfaceHash}`;
            if (schemas.has(key)) return;
            const { schema } = await connection.get(schemasInterface, { serviceId }).get({
                interfaceId: ref.interfaceId, hash: ref.interfaceHash,
            });
            const validated = parseStaticHubSchema({ interfaceSchemas: [schema] }).interfaceSchemas[0]!;
            if (validated.id !== ref.interfaceId || validated.hash !== ref.interfaceHash) {
                throw new Error(`Schema response does not match ${key}`);
            }
            schemas.set(key, validated);
        }
        for (const listing of snapshot.result.listings) {
            const ref = { interfaceId: listing.interfaceId, interfaceHash: listing.hash };
            const interfaces = services.get(listing.serviceId) ?? [];
            interfaces.push(ref);
            services.set(listing.serviceId, interfaces);
            await resolve(ref, listing.discoveredFrom || undefined);
        }
        const defaultInterface = preset.interfaceId === undefined ? undefined
            : { interfaceId: preset.interfaceId, interfaceHash: preset.interfaceHash! };
        if (defaultInterface) await resolve(defaultInterface, options.serviceId ?? preset.serviceId);
        for (const binding of bindings) {
            await resolve(binding, options.serviceId ?? binding.serviceId);
        }
        const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
        return parseStaticHubSchema({
            interfaceSchemas: [...schemas.values()].sort((a, b) => compare(`${a.id}@${a.hash}`, `${b.id}@${b.hash}`)),
            services: [...services].sort(([a], [b]) => compare(a, b)).map(([serviceId, interfaces]) => ({
                serviceId, interfaces: interfaces.sort((a, b) => compare(a.interfaceId, b.interfaceId)),
            })),
            ...(defaultInterface === undefined ? {} : { defaultInterface }),
            bareInterfaces: bindings.map(({ prefix, interfaceId, interfaceHash }) => ({
                prefix, interface: { interfaceId, interfaceHash },
            })).sort((a, b) => compare(a.prefix, b.prefix)),
        });
    } finally {
        explorer.dispose();
    }
}
