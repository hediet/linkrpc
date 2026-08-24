import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
    computeInterfaceHash,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
} from "@hediet/linkrpc";

const [commandsSchemaPath, messagesPath, outputPath] = process.argv.slice(2);
if (!commandsSchemaPath || !messagesPath || !outputPath) {
    throw new Error("Expected commands schema, messages source, and output paths");
}

const commandsDocument = JSON.parse(await readFile(commandsSchemaPath, "utf8")) as {
    $defs: Record<string, unknown>;
};
const messagesSource = await readFile(messagesPath, "utf8");
const commandTypesSource = await readFile(resolve(dirname(messagesPath), "commands.ts"), "utf8");
const commandMapSource = /export interface CommandMap \{([\s\S]*?)\n\}/.exec(messagesSource)?.[1];
if (!commandMapSource) {
    throw new Error("Could not find CommandMap");
}

const commandPattern = /'([^']+)': \{ params: (\w+); result: (\w+|null) \};/g;
const commands = [...commandMapSource.matchAll(commandPattern)].map((match) => ({
    name: match[1]!,
    params: match[2]!,
    result: match[3]!,
}));
if (commands.length === 0) {
    throw new Error("CommandMap did not contain any commands");
}

const ensureDefinition = (name: string): void => {
    if (name === "null" || name in commandsDocument.$defs) {
        return;
    }
    const typeAlias = new RegExp(`export type ${name} = ([^;]+);`).exec(commandTypesSource)?.[1];
    if (!typeAlias) {
        throw new Error(`Missing schema and type alias for ${name}`);
    }
    commandsDocument.$defs[name] = {
        anyOf: typeAlias.split("|").map((member) => {
            const typeName = member.trim();
            return typeName === "null"
                ? { type: "null" }
                : { $ref: `#/$defs/${typeName}` };
        }),
    };
};

const transformSchema = (value: unknown): LinkRpcJsonSchema => {
    if (typeof value === "boolean") {
        return value;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Unsupported JSON Schema value: ${JSON.stringify(value)}`);
    }

    const source = value as Record<string, unknown>;
    if (Object.keys(source).length === 0) {
        return true;
    }

    const metadata = {
        ...(typeof source.title === "string" ? { title: source.title } : {}),
        ...(typeof source.description === "string" ? { description: source.description } : {}),
    };
    if (Object.keys(source).every((key) =>
        key === "title" || key === "description" || key === "$comment" || key === "default"
    )) {
        return true;
    }
    if (typeof source.$ref === "string") {
        return {
            ...metadata,
            $ref: source.$ref.replace(/^#\/\$defs\//, "#/components/schemas/"),
        };
    }
    if ("const" in source) {
        return { ...metadata, const: source.const as never };
    }
    if (Array.isArray(source.enum)) {
        return { ...metadata, enum: source.enum as never[] };
    }
    if (Array.isArray(source.anyOf)) {
        return { ...metadata, anyOf: source.anyOf.map(transformSchema) };
    }
    if (Array.isArray(source.oneOf)) {
        return { ...metadata, oneOf: source.oneOf.map(transformSchema) };
    }

    switch (source.type) {
        case "null":
        case "boolean":
        case "number":
        case "integer":
        case "string":
            return { ...metadata, type: source.type };
        case "array":
            return {
                ...metadata,
                type: "array",
                items: transformSchema(source.items ?? {}),
            };
        case "object": {
            const properties = source.properties && typeof source.properties === "object"
                ? Object.fromEntries(
                    Object.entries(source.properties).map(([name, schema]) => [
                        name,
                        transformSchema(schema),
                    ]),
                )
                : {};
            return {
                ...metadata,
                type: "object",
                properties,
                ...(Array.isArray(source.required)
                    ? { required: source.required as string[] }
                    : {}),
                additionalProperties: source.additionalProperties === undefined
                    ? true
                    : transformSchema(source.additionalProperties),
            };
        }
        default:
            throw new Error(`Unsupported JSON Schema: ${JSON.stringify(source)}`);
    }
};

for (const command of commands) {
    ensureDefinition(command.params);
    ensureDefinition(command.result);
}

const interfaceSchema: LinkRpcInterfaceSchema = {
    id: "ahp",
    hash: "",
    description: "Agent Host Protocol commands.",
    methods: Object.fromEntries(commands.map((command) => [
        command.name,
        {
            params: {
                $ref: `#/components/schemas/${command.params}`,
            },
            result: command.result === "null"
                ? { type: "null" }
                : { $ref: `#/components/schemas/${command.result}` },
        },
    ])),
    components: {
        schemas: Object.fromEntries(
            Object.entries(commandsDocument.$defs).map(([name, schema]) => [
                name,
                transformSchema(schema),
            ]),
        ),
    },
};
interfaceSchema.hash = computeInterfaceHash(interfaceSchema);

const interfaceRef = {
    interfaceId: interfaceSchema.id,
    interfaceHash: interfaceSchema.hash,
};
const output = {
    services: [{
        serviceId: "",
        interfaces: [interfaceRef],
    }],
    defaultInterface: interfaceRef,
    interfaceSchemas: [interfaceSchema],
};

await writeFile(outputPath, `${JSON.stringify(output, undefined, 2)}\n`);
console.log(
    `${commands.length} commands, ${Object.keys(commandsDocument.$defs).length} schemas, ${interfaceSchema.hash}`,
);
