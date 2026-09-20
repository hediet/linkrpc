import { InterfaceDefinition, notificationType, requestType, type LinkRpcInterfaceSchema } from "@hediet/linkrpc";
import { z } from "zod";

const CommandSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("add"),
        value: z.int(),
    }),
    z.object({
        kind: z.literal("finish"),
    }),
]);

const wireSchema: LinkRpcInterfaceSchema = JSON.parse("{\"id\":\"dev.linkrpc.streaming-interop\",\"hash\":\"5f78a76e3c307c41\",\"methods\":{\"cancellable\":{\"params\":{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false},\"result\":{\"type\":\"string\"},\"serverStream\":{\"type\":\"string\"}},\"exchange\":{\"params\":{\"type\":\"object\",\"required\":[\"fail\"],\"properties\":{\"fail\":{\"type\":\"boolean\"}},\"additionalProperties\":false},\"result\":{\"type\":\"integer\"},\"clientStream\":{\"$ref\":\"#/components/schemas/Command\"},\"serverStream\":{\"type\":[\"integer\",\"null\"],\"format\":\"int64\"}}},\"components\":{\"schemas\":{\"Command\":{\"oneOf\":[{\"type\":\"object\",\"required\":[\"kind\",\"value\"],\"properties\":{\"kind\":{\"type\":\"string\",\"const\":\"add\"},\"value\":{\"type\":\"integer\"}},\"additionalProperties\":false},{\"type\":\"object\",\"required\":[\"kind\"],\"properties\":{\"kind\":{\"type\":\"string\",\"const\":\"finish\"}},\"additionalProperties\":false}],\"discriminator\":{\"propertyName\":\"kind\"}}}}}");

export const streamingInterop = new InterfaceDefinition(
    {
        id: "dev.linkrpc.streaming-interop",
        hash: "5f78a76e3c307c41",
    },
    {
        cancellable: requestType(
            z.object({}),
            z.string(),
        ).withStream({
            server: z.string(),
        }),
        exchange: requestType(
            z.object({
                fail: z.boolean(),
            }),
            z.int(),
        ).withStream({
            client: CommandSchema,
            server: z.union([
                z.int(),
                z.null(),
            ]),
        }),
    },
    { frozenSchema: wireSchema },
);
