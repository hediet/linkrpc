import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineInterface, interfaceFromSchema } from "../connection/interfaceDefinition";
import { requestType } from "./memberTypes";
import { generateTsInterface } from "./codegen/generateTsInterface";
import { validateInterfaceTemplate, validateInterfaceTemplates, type InterfaceTemplateSchema } from "./interfaceTemplates";
import type { LinkRpcInterfaceSchema } from "./linkRpcInterfaceSchema";
import { SchemaValidationError } from "./schemaValidationError";

const valueStore = {
    id: "value-store",
    parameters: ["value"],
    methods: {
        get: {
            params: { type: "object", properties: {}, additionalProperties: false },
            result: { $ref: "#/components/schemas/Box" },
        },
    },
    components: {
        schemas: {
            Box: {
                type: "object", properties: { value: { $parameter: "value" } },
                required: ["value"], additionalProperties: false,
            },
        },
    },
} as const satisfies InterfaceTemplateSchema;

function reflected(): LinkRpcInterfaceSchema {
    const definition = defineInterface({ id: "test.store" }, {
        fetch: requestType(z.object({}), z.object({ value: z.string() })),
    });
    return {
        ...definition.toSchema(),
        "x-interface-templates": {
            templates: { [valueStore.id]: valueStore },
            instances: [{
                name: "users", template: valueStore.id, members: { get: "fetch" },
                arguments: { value: { schema: { type: "string" } } },
            }],
        },
    };
}

function metadata(schema: LinkRpcInterfaceSchema) {
    return schema["x-interface-templates"] as {
        templates: Record<string, InterfaceTemplateSchema>;
        instances: { name: string; template: string; members: Record<string, string>; arguments: Record<string, unknown> }[];
    };
}

describe("interface template reflection", () => {
    it("keeps authoring validation failures compatible with Error and their existing messages", () => {
        const invalid = { ...valueStore, parameters: ["value", "value"] };
        expect(() => validateInterfaceTemplate(invalid)).toThrow(Error);
        expect(() => validateInterfaceTemplate(invalid)).toThrow(SchemaValidationError);
        expect(() => validateInterfaceTemplate(invalid)).toThrow('Interface template "value-store" repeats parameter "value"');
    });

    it("preserves component-based templates through import and code generation", () => {
        const schema = reflected();
        expect(() => validateInterfaceTemplates(schema)).not.toThrow();
        expect(interfaceFromSchema(schema).toSchema()).toEqual(schema);
        const generated = generateTsInterface(schema);
        expect(generated).toContain("const wireSchema: LinkRpcInterfaceSchema");
        expect(generated).toContain("new InterfaceDefinition(");
    });

    it("resolves recursive argument components independently of their names", () => {
        const schema = reflected();
        schema.methods.fetch!.result = { $ref: "#/components/schemas/Container" };
        schema.components = { schemas: {
            Container: {
                type: "object", properties: { value: { $ref: "#/components/schemas/Node" } },
                required: ["value"], additionalProperties: false,
            },
            Node: {
                type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Node" } } },
                required: ["children"], additionalProperties: false,
            },
        } };
        metadata(schema).instances[0]!.arguments.value = {
            schema: { $ref: "#/components/schemas/Tree" },
            components: { schemas: {
                Tree: {
                    type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Tree" } } },
                    required: ["children"], additionalProperties: false,
                },
            } },
        };
        expect(() => validateInterfaceTemplates(schema)).not.toThrow();
    });

    it("rejects duplicate instance names and globally overlapping member ownership", () => {
        const schema = reflected();
        metadata(schema).instances.push(structuredClone(metadata(schema).instances[0]!));
        expect(() => validateInterfaceTemplates(schema)).toThrow(/name collision/);
        metadata(schema).instances[1]!.name = "other";
        expect(() => validateInterfaceTemplates(schema)).toThrow(/member collision/);
    });

    it("rejects missing or extra arguments, unknown templates and inconsistent methods", () => {
        const schema = reflected();
        metadata(schema).instances[0]!.arguments.extra = { schema: true };
        expect(() => validateInterfaceTemplates(schema)).toThrow(/unknown parameter/);
        delete metadata(schema).instances[0]!.arguments.extra;
        delete metadata(schema).instances[0]!.arguments.value;
        expect(() => validateInterfaceTemplates(schema)).toThrow(/missing parameter/);
        metadata(schema).instances[0]!.template = "missing";
        expect(() => validateInterfaceTemplates(schema)).toThrow(/unknown template/);
        const mismatch = reflected();
        mismatch.methods.fetch!.result = { type: "number" };
        expect(() => validateInterfaceTemplates(mismatch)).toThrow(/does not match/);
        expect(() => interfaceFromSchema(mismatch)).toThrow(/does not match/);
        expect(() => generateTsInterface(mismatch)).toThrow(/does not match/);
    });

    it("rejects unknown parameter and component references in templates", () => {
        const schema = reflected();
        metadata(schema).templates[valueStore.id] = {
            ...valueStore, methods: { get: { params: { $parameter: "missing" } } },
        };
        expect(() => validateInterfaceTemplates(schema)).toThrow(/Unknown schema parameter/);
        metadata(schema).templates[valueStore.id] = {
            ...valueStore, methods: { get: { params: { $ref: "#/components/schemas/Missing" } } },
        };
        expect(() => validateInterfaceTemplates(schema)).toThrow(/Unknown interface template component/);
    });
});
