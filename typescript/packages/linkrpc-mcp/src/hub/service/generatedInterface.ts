import {
    assertSchemaReferences,
    componentSchemaRef,
    computeInterfaceHash,
    type InterfaceDefinition,
    interfaceFromSchema,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
    type MemberMap,
    normalizeJsonSchema,
    schemaToZod,
} from "@hediet/linkrpc";
import type { McpToolDefinition } from "../clientSession";
import { generatedMcpToolsInterfacePrefix } from "../contracts";

/**
 * Assigns tools to an extra generated interface `<base>.<name>`. A tool joins
 * the first group (in configuration order) that lists it in `tools`, or whose
 * `prefixes` or `keywords` (case-insensitive substrings) match its name. Tools
 * in no group stay in the base interface.
 */
export interface McpToolGroup {
    readonly name: string;
    readonly tools?: readonly string[];
    readonly prefixes?: readonly string[];
    readonly keywords?: readonly string[];
}

/** Generated interfaces of one MCP server. */
export interface GeneratedMcpToolsInterfaces {
    /** Non-empty generated interfaces by id. */
    readonly interfaces: ReadonlyMap<string, InterfaceDefinition<MemberMap>>;
    /** MCP tool name → generated interface and method that invoke it. */
    readonly tools: ReadonlyMap<string, GeneratedToolMethod>;
    /** Tools published with permissive params because their schema could not be converted. */
    readonly warnings: readonly string[];
}

export interface GeneratedToolMethod {
    readonly interfaceId: string;
    readonly method: string;
    /** Params schema of the method, including `sessionId`. */
    readonly params: LinkRpcJsonSchema;
    readonly result: LinkRpcJsonSchema;
    /** Components the method's schemas reference. */
    readonly components: Readonly<Record<string, LinkRpcJsonSchema>>;
}

const interfaceIdPattern = /^mcp\.tools\.[a-z0-9][a-z0-9.-]*$/;
const groupNamePattern = /^[a-z0-9][a-z0-9-]*$/;

export function assertGeneratedInterfaceId(interfaceId: string): void {
    if (!interfaceIdPattern.test(interfaceId)) {
        throw new Error(
            `Generated MCP tools interface id must match '${generatedMcpToolsInterfacePrefix}<name>' `
            + `(lowercase letters, digits, dots, hyphens): ${interfaceId}`,
        );
    }
}

export function assertToolGroups(groups: readonly McpToolGroup[]): void {
    const names = new Set<string>();
    for (const group of groups) {
        if (!groupNamePattern.test(group.name)) {
            throw new Error(`MCP tool group names must be lowercase letters, digits, and hyphens: ${group.name}`);
        }
        if (names.has(group.name)) throw new Error(`Duplicate MCP tool group: ${group.name}`);
        names.add(group.name);
    }
}

/**
 * One method per MCP tool, in the base interface or its group's interface.
 * Params are the tool's input schema plus an optional `sessionId`; the result
 * is the complete MCP `CallToolResult`, with `structuredContent` typed by the
 * tool's output schema. Schema definitions (`$defs`, `definitions`) become
 * interface components.
 */
export function createMcpToolsInterfaces(
    tools: readonly McpToolDefinition[],
    baseInterfaceId: string,
    groups: readonly McpToolGroup[] = [],
): GeneratedMcpToolsInterfaces {
    assertGeneratedInterfaceId(baseInterfaceId);
    assertToolGroups(groups);
    const schemas = new Map<string, LinkRpcInterfaceSchema>();
    const methodOwners = new Map<string, string>();
    const toolMethods = new Map<string, GeneratedToolMethod>();
    const warnings: string[] = [];
    for (const tool of tools) {
        const group = groups.find((candidate) => matchesGroup(candidate, tool.name));
        const interfaceId = group === undefined ? baseInterfaceId : `${baseInterfaceId}.${group.name}`;
        const methodName = encodeToolMethodName(tool.name);
        const key = `${interfaceId}::${methodName}`;
        const previous = methodOwners.get(key);
        if (previous !== undefined) {
            throw new Error(
                `MCP tools '${previous}' and '${tool.name}' map to the same LinkRPC method '${methodName}'`,
            );
        }
        methodOwners.set(key, tool.name);

        let converted: ConvertedTool;
        try {
            converted = convertTool(tool);
        } catch (error) {
            warnings.push(
                `MCP tool '${tool.name}' is published with unchecked params: `
                + (error instanceof Error ? error.message : String(error)),
            );
            converted = { params: permissiveParams(), result: callToolResultSchema(undefined), components: {} };
        }

        const schema = schemas.get(interfaceId) ?? newSchema(interfaceId);
        schemas.set(interfaceId, schema);
        const method: LinkRpcInterfaceSchema["methods"][string] = { params: converted.params, result: converted.result };
        const description = tool.description ?? tool.title;
        if (description !== undefined) method.description = description;
        const annotations = toLinkRpcAnnotations(tool.annotations);
        if (annotations !== undefined) method.annotations = annotations;
        schema.methods[methodName] = method;
        if (Object.keys(converted.components).length > 0) {
            schema.components = { schemas: { ...schema.components?.schemas, ...converted.components } };
        }
        toolMethods.set(tool.name, { interfaceId, method: methodName, ...converted });
    }
    const interfaces = new Map<string, InterfaceDefinition<MemberMap>>();
    for (const [interfaceId, schema] of schemas) {
        schema.hash = computeInterfaceHash(schema);
        interfaces.set(interfaceId, interfaceFromSchema(schema));
    }
    return { interfaces, tools: toolMethods, warnings };
}

export function encodeToolMethodName(toolName: string): string {
    if (toolName.length === 0) throw new Error("MCP tool names must not be empty");
    return toolName.replaceAll("%", "%25").replaceAll(":", "%3A");
}

/**
 * MCP hint defaults: a tool is read-only only if it says so; a non-read-only
 * tool is destructive unless it says otherwise.
 */
export function toLinkRpcAnnotations(
    annotations: McpToolDefinition["annotations"],
): LinkRpcInterfaceSchema["methods"][string]["annotations"] | undefined {
    const result: NonNullable<LinkRpcInterfaceSchema["methods"][string]["annotations"]> = {};
    if (annotations?.readOnlyHint === true) result.readOnly = true;
    else if (annotations?.destructiveHint !== false) result.dangerous = true;
    if (annotations?.idempotentHint === true) result.idempotent = true;
    return Object.keys(result).length === 0 ? undefined : result;
}

function matchesGroup(group: McpToolGroup, toolName: string): boolean {
    const lower = toolName.toLowerCase();
    return (group.tools?.includes(toolName) ?? false)
        || (group.prefixes?.some((prefix) => toolName.startsWith(prefix)) ?? false)
        || (group.keywords?.some((keyword) => lower.includes(keyword.toLowerCase())) ?? false);
}

function newSchema(interfaceId: string): LinkRpcInterfaceSchema {
    return {
        id: interfaceId,
        hash: "",
        description: "MCP tools exposed as LinkRPC methods. Each method returns the complete MCP CallToolResult.",
        methods: {},
    };
}

interface ConvertedTool {
    readonly params: LinkRpcJsonSchema;
    readonly result: LinkRpcJsonSchema;
    readonly components: Readonly<Record<string, LinkRpcJsonSchema>>;
}

/** Converts a tool's schemas and checks that they can validate values. */
function convertTool(tool: McpToolDefinition): ConvertedTool {
    const components: Record<string, LinkRpcJsonSchema> = {};
    const input = convertSchema(tool.inputSchema, `${tool.name}.input`, components);
    const params = injectSessionId(asObjectSchema(input), tool.name);
    const output = tool.outputSchema === undefined
        ? undefined
        : convertSchema(tool.outputSchema, `${tool.name}.output`, components);
    const result = callToolResultSchema(output);
    assertSchemaReferences([params, result], components);
    schemaToZod(params, components);
    schemaToZod(result, components);
    return { params, result, components };
}

/**
 * Normalize an MCP JSON Schema. Root-level `$defs` / `definitions` become
 * components named `<scope>.<definition>`, and references to them are rewritten.
 */
function convertSchema(
    schema: unknown,
    scope: string,
    components: Record<string, LinkRpcJsonSchema>,
): LinkRpcJsonSchema {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return normalizeJsonSchema(withJsonSchemaObjectDefaults(schema));
    }
    const { $defs, definitions, ...root } = schema as Record<string, unknown>;
    const defs = { ...asRecord(definitions), ...asRecord($defs) };
    const rename = (name: string) => componentSchemaRef(`${scope}.${name}`);
    const rewrite = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(rewrite);
        if (value === null || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
            if (key === "$ref" && typeof child === "string") {
                const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(child);
                if (match) return [key, rename(decodePointerSegment(match[1]))];
                throw new Error(`unsupported $ref '${child}'`);
            }
            return [key, rewrite(child)];
        }));
    };
    for (const [name, definition] of Object.entries(defs)) {
        components[`${scope}.${name}`] = normalizeJsonSchema(withJsonSchemaObjectDefaults(rewrite(definition)));
    }
    return normalizeJsonSchema(withJsonSchemaObjectDefaults(rewrite(root)));
}

/** MCP requires object-shaped input; some servers omit `"type": "object"`. */
function asObjectSchema(schema: LinkRpcJsonSchema): LinkRpcJsonSchema {
    if (schema !== null && typeof schema === "object" && !("type" in schema) && "properties" in schema) {
        return { ...(schema as object), type: "object" } as LinkRpcJsonSchema;
    }
    return schema;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decodePointerSegment(segment: string): string {
    return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function withJsonSchemaObjectDefaults(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withJsonSchemaObjectDefaults);
    if (value === null || typeof value !== "object") return value;
    const input = value as Readonly<Record<string, unknown>>;
    const result = Object.fromEntries(
        Object.entries(input).map(([key, child]) => [key, withJsonSchemaObjectDefaults(child)]),
    );
    if (result.type === "object" && result.additionalProperties === undefined) {
        result.additionalProperties = true;
    }
    return result;
}

function callToolResultSchema(outputSchema: LinkRpcJsonSchema | undefined): LinkRpcJsonSchema {
    const properties: Record<string, LinkRpcJsonSchema> = {
        content: { type: "array", items: true },
        isError: { type: "boolean" },
        _meta: true,
    };
    if (outputSchema !== undefined) properties.structuredContent = outputSchema;
    return {
        type: "object",
        properties,
        required: ["content"],
        additionalProperties: true,
    };
}

function permissiveParams(): LinkRpcJsonSchema {
    return { type: "object", properties: { sessionId: sessionIdSchema() }, additionalProperties: true };
}

function injectSessionId(schema: LinkRpcJsonSchema, toolName: string): LinkRpcJsonSchema {
    if (schema === true) return permissiveParams();
    if (schema === false) {
        throw new Error(`MCP tool '${toolName}' has an input schema that accepts no values`);
    }
    if ("type" in schema && schema.type === "object") {
        const properties = schema.properties ?? {};
        if ("sessionId" in properties) {
            throw new Error(`MCP tool '${toolName}' uses the reserved input property 'sessionId'`);
        }
        return { ...schema, properties: { ...properties, sessionId: sessionIdSchema() } };
    }
    if ("anyOf" in schema) {
        return { ...schema, anyOf: schema.anyOf.map((branch) => injectSessionId(branch, toolName)) };
    }
    if ("oneOf" in schema) {
        return { ...schema, oneOf: schema.oneOf.map((branch) => injectSessionId(branch, toolName)) };
    }
    throw new Error(`MCP tool '${toolName}' must have an object-shaped input schema`);
}

function sessionIdSchema(): LinkRpcJsonSchema {
    return {
        type: "string",
        description: "Exclusive bridge session from mcp.server::openSession. Omitted means the shared session.",
    };
}
