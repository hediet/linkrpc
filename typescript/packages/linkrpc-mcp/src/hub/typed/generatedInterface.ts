import {
    computeInterfaceHash,
    type InterfaceDefinition,
    interfaceFromSchema,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
    type MemberMap,
    normalizeJsonSchema,
} from "@hediet/linkrpc";
import type { McpToolDefinition } from "../clientSession";
import { generatedMcpToolsInterfacePrefix } from "../contracts";

/** A generated `mcp.tools.<name>` interface plus its method → tool routing. */
export interface GeneratedMcpToolsInterface {
    readonly interface: InterfaceDefinition<MemberMap>;
    /** Generated method name → MCP tool name. */
    readonly routes: ReadonlyMap<string, string>;
}

const interfaceIdPattern = /^mcp\.tools\.[a-z0-9][a-z0-9.-]*$/;

export function assertGeneratedInterfaceId(interfaceId: string): void {
    if (!interfaceIdPattern.test(interfaceId)) {
        throw new Error(
            `Generated MCP tools interface id must match '${generatedMcpToolsInterfacePrefix}<name>' `
            + `(lowercase letters, digits, dots, hyphens): ${interfaceId}`,
        );
    }
}

/**
 * One method per MCP tool. Params are the tool's input schema plus an optional
 * `sessionId`; the result is the complete MCP `CallToolResult`, with
 * `structuredContent` typed by the tool's output schema.
 */
export function createMcpToolsInterface(
    tools: readonly McpToolDefinition[],
    interfaceId: string,
): GeneratedMcpToolsInterface {
    assertGeneratedInterfaceId(interfaceId);
    const routes = new Map<string, string>();
    const methods: LinkRpcInterfaceSchema["methods"] = {};
    for (const tool of tools) {
        const methodName = encodeToolMethodName(tool.name);
        const previous = routes.get(methodName);
        if (previous !== undefined) {
            throw new Error(
                `MCP tools '${previous}' and '${tool.name}' map to the same LinkRPC method '${methodName}'`,
            );
        }
        routes.set(methodName, tool.name);
        const method: LinkRpcInterfaceSchema["methods"][string] = {
            params: injectSessionId(normalizeMcpSchema(tool.inputSchema), tool.name),
            result: callToolResultSchema(tool.outputSchema),
        };
        const description = tool.description ?? tool.title;
        if (description !== undefined) method.description = description;
        const annotations = toLinkRpcAnnotations(tool.annotations);
        if (annotations !== undefined) method.annotations = annotations;
        methods[methodName] = method;
    }
    const schema: LinkRpcInterfaceSchema = {
        id: interfaceId,
        hash: "",
        description: "MCP tools exposed as LinkRPC methods. Each method returns the complete MCP CallToolResult.",
        methods,
    };
    schema.hash = computeInterfaceHash(schema);
    return { interface: interfaceFromSchema(schema), routes };
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

function normalizeMcpSchema(schema: unknown): LinkRpcJsonSchema {
    return normalizeJsonSchema(withJsonSchemaObjectDefaults(schema));
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

function callToolResultSchema(outputSchema: unknown): LinkRpcJsonSchema {
    const properties: Record<string, LinkRpcJsonSchema> = {
        content: { type: "array", items: true },
        isError: { type: "boolean" },
        _meta: true,
    };
    if (outputSchema !== undefined) properties.structuredContent = normalizeMcpSchema(outputSchema);
    return {
        type: "object",
        properties,
        required: ["content"],
        additionalProperties: true,
    };
}

function injectSessionId(schema: LinkRpcJsonSchema, toolName: string): LinkRpcJsonSchema {
    if (schema === true) {
        return { type: "object", properties: { sessionId: sessionIdSchema() }, additionalProperties: true };
    }
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
