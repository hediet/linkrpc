import {
    computeInterfaceHash,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
    InterfaceDefinition,
    interfaceFromSchema,
    type MemberMap,
    NotificationType,
    RequestType,
} from '@hediet/linkrpc';

export const jsonRpcConnectionIdParameter = 'jsonRpcConnectionId';

export interface JsonRpcBridgeParams {
    readonly jsonRpcConnectionId?: string;
}

type BridgeMember<T> = T extends RequestType<infer P, infer R, infer E, infer TC, infer TS> ?
    RequestType<P & JsonRpcBridgeParams, R, E, TC, TS> :
    T extends NotificationType<infer P> ? NotificationType<P & JsonRpcBridgeParams> :
    never;

export interface AcknowledgedNotificationResult {
    readonly sent: true;
}

type NotificationMemberName<T extends InterfaceDefinition<MemberMap>> = Extract<
    {
        [K in keyof T['members']]: T['members'][K] extends NotificationType<unknown> ? K : never;
    }[keyof T['members']],
    string
>;

type ConfiguredBridgeMember<T, TName, TAcknowledged> = T extends NotificationType<infer P> ?
    TName extends TAcknowledged ? RequestType<P & JsonRpcBridgeParams, AcknowledgedNotificationResult> :
    NotificationType<P & JsonRpcBridgeParams> :
    BridgeMember<T>;

export interface JsonRpcBridgeInterfaceOptions<
    T extends InterfaceDefinition<MemberMap>,
    TAcknowledged extends NotificationMemberName<T>,
> {
    readonly acknowledgeNotifications?: readonly TAcknowledged[];
}

export type JsonRpcBridgeInterface<
    T extends InterfaceDefinition<MemberMap>,
    TAcknowledged extends NotificationMemberName<T> = never,
> = InterfaceDefinition<
    {
        [K in keyof T['members']]: ConfiguredBridgeMember<T['members'][K], K, TAcknowledged>;
    }
>;

export function createJsonRpcBridgeInterface<
    T extends InterfaceDefinition<MemberMap>,
    TAcknowledged extends NotificationMemberName<T> = never,
>(
    source: T,
    options: JsonRpcBridgeInterfaceOptions<T, TAcknowledged> = {},
): JsonRpcBridgeInterface<T, TAcknowledged> {
    const schema = injectJsonRpcConnectionId(source.toSchema());
    for (const name of options.acknowledgeNotifications ?? []) {
        const method = schema.methods[name];
        if (!method || method.result !== undefined) {
            throw new Error(`JSON-RPC bridge member '${name}' is not a notification`);
        }
        schema.methods[name] = {
            ...method,
            result: {
                type: 'object',
                properties: {
                    sent: { const: true },
                },
                required: ['sent'],
                additionalProperties: false,
            },
        };
    }
    schema.hash = computeInterfaceHash(schema);
    return interfaceFromSchema(schema) as JsonRpcBridgeInterface<T, TAcknowledged>;
}

export function injectJsonRpcConnectionId(source: LinkRpcInterfaceSchema): LinkRpcInterfaceSchema {
    const components = source.components?.schemas ?? {};
    const methods = Object.fromEntries(
        Object.entries(source.methods).map(([name, method]) => [
            name,
            {
                ...method,
                params: injectIntoParams(method.params, components, name, new Set()),
            },
        ]),
    );
    const result: LinkRpcInterfaceSchema = { ...source, methods, hash: '' };
    result.hash = computeInterfaceHash(result);
    return result;
}

function injectIntoParams(
    schema: LinkRpcJsonSchema,
    components: Record<string, LinkRpcJsonSchema>,
    methodName: string,
    resolving: Set<string>,
): LinkRpcJsonSchema {
    if (typeof schema === 'boolean') {
        if (!schema) throw unsupportedParams(methodName);
        return connectionParamsObject(true);
    }
    if ('$ref' in schema) {
        const name = schema.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];
        if (!name || resolving.has(name) || components[name] === undefined) throw unsupportedParams(methodName);
        const nextResolving = new Set(resolving);
        nextResolving.add(name);
        return injectIntoParams(components[name], components, methodName, nextResolving);
    }
    if ('type' in schema && schema.type === 'object') {
        if (jsonRpcConnectionIdParameter in schema.properties) {
            throw new Error(
                `JSON-RPC bridge interface '${methodName}' already defines reserved parameter '${jsonRpcConnectionIdParameter}'`,
            );
        }
        return {
            ...schema,
            properties: {
                ...schema.properties,
                [jsonRpcConnectionIdParameter]: {
                    type: 'string',
                    description:
                        'Optional bridge connection identifier. When omitted, the bridge uses a new ephemeral connection for this operation.',
                },
            },
        };
    }
    if ('anyOf' in schema) {
        return {
            ...schema,
            anyOf: schema.anyOf.map((branch) => injectIntoParams(branch, components, methodName, resolving)),
        };
    }
    if ('oneOf' in schema) {
        return {
            ...schema,
            oneOf: schema.oneOf.map((branch) => injectIntoParams(branch, components, methodName, resolving)),
        };
    }
    throw unsupportedParams(methodName);
}

function connectionParamsObject(additionalProperties: LinkRpcJsonSchema): LinkRpcJsonSchema {
    return {
        type: 'object',
        properties: {
            [jsonRpcConnectionIdParameter]: {
                type: 'string',
                description:
                    'Optional bridge connection identifier. When omitted, the bridge uses a new ephemeral connection for this operation.',
            },
        },
        additionalProperties,
    };
}

function unsupportedParams(methodName: string): Error {
    return new Error(`JSON-RPC bridge interface '${methodName}' must use object-shaped params`);
}
