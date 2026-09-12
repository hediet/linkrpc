import {
    createSchemaToZod,
    InterfaceDefinition,
    notificationType,
    requestType,
    type LinkRpcInterfaceSchema,
    type MemberMap,
} from "@hediet/linkrpc";

/**
 * Build an imported contract as a runtime definition with recursive Zod
 * validators. Unlike the generic reflection fallback, this validates params,
 * results, and stream payloads against the imported protocol corpus.
 */
export function createProtocolInterfaceDefinition(
    schema: LinkRpcInterfaceSchema,
): InterfaceDefinition<MemberMap> {
    const toZod = createSchemaToZod(schema.components?.schemas).toZod;
    const members: MemberMap = {};
    for (const [name, method] of Object.entries(schema.methods)) {
        const docs = {
            ...(method.description === undefined ? {} : { description: method.description }),
            ...(method.comment === undefined ? {} : { comment: method.comment }),
            ...(method.annotations === undefined ? {} : { annotations: method.annotations }),
        };
        if (method.result === undefined) {
            members[name] = notificationType(toZod(method.params), docs);
            continue;
        }
        const request = requestType(toZod(method.params), toZod(method.result), docs);
        members[name] = method.clientStream === undefined && method.serverStream === undefined
            ? request
            : request.withStream({
                client: method.clientStream === undefined ? undefined : toZod(method.clientStream),
                server: method.serverStream === undefined ? undefined : toZod(method.serverStream),
            });
    }
    return new InterfaceDefinition(
        {
            id: schema.id,
            ...(schema.description === undefined ? {} : { description: schema.description }),
            ...(schema.comment === undefined ? {} : { comment: schema.comment }),
            hash: schema.hash,
        },
        members,
        { frozenSchema: schema },
    );
}
