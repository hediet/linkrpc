import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineInterface } from "../connection/interfaceDefinition";
import { notificationType, requestType } from "./memberTypes";
import { computeInterfaceHash, EXTENSION_PREFIX } from "./hash";
import type { LinkRpcInterfaceSchema } from "./linkRpcInterfaceSchema";

describe("computeInterfaceHash", () => {
    it("normalizes and hashes raw error body schemas without changing the legacy projection", () => {
        const data = { type: "number" as const, minimum: 0 };
        const source: LinkRpcInterfaceSchema = {
            id: "test.raw-hash", hash: "", methods: { read: { params: true, result: true, errors: [{
                code: -32001, schema: { type: "object", additionalProperties: false, properties: {
                    message: { type: "string" }, data,
                }, required: ["message", "data"] },
            }] } },
        };
        const normalized: LinkRpcInterfaceSchema = {
            ...source, methods: { read: { params: true, result: true, errors: [{
                code: -32001, schema: { type: "object", additionalProperties: false,
                    properties: { message: { type: "string" }, data: { type: "number" } },
                    required: ["data", "message"] },
            }] } },
        };
        expect(computeInterfaceHash(source)).toBe(computeInterfaceHash(normalized));
        const changed = structuredClone(normalized);
        changed.methods.read.errors = [{ code: -32001, schema: true }];
        expect(computeInterfaceHash(source)).not.toBe(computeInterfaceHash(changed));
    });

    it("normalizes inner error payload schemas and retains named error identity", () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.error-hash", hash: "", methods: {
                read: { params: true, result: true, errors: [
                    { type: "NotFound", code: 1, message: "Missing",
                        data: { type: "object", properties: {} } as import('./linkRpcJsonSchema').LinkRpcJsonSchema },
                ] },
            },
        };
        const normalized = structuredClone(schema);
        normalized.methods.read.errors![0].data = { type: "object", properties: {}, additionalProperties: false };
        expect(computeInterfaceHash(schema)).toBe(computeInterfaceHash(normalized));
        normalized.methods.read.errors![0].type = "Other";
        expect(computeInterfaceHash(schema)).not.toBe(computeInterfaceHash(normalized));
    });

    it("is stable, 16 hex chars, and independent of `comment`", () => {
        const a = defineInterface(
            { id: "test.iface", comment: "first note" },
            { ping: requestType(z.object({}), z.string()) },
        );
        const b = defineInterface(
            { id: "test.iface", comment: "totally different note" },
            { ping: requestType(z.object({}), z.string()) },
        );

        expect(a.schemaHash).toMatch(/^[0-9a-f]{16}$/);
        expect(a.schemaHash).toBe(b.schemaHash);
    });

    it("changes when `description` changes (description is normative)", () => {
        const a = defineInterface(
            { id: "test.iface", description: "first description" },
            { ping: requestType(z.object({}), z.string()) },
        );
        const b = defineInterface(
            { id: "test.iface", description: "totally different description" },
            { ping: requestType(z.object({}), z.string()) },
        );
        expect(a.schemaHash).not.toBe(b.schemaHash);
    });

    it("method-level `description` affects the hash, `comment` does not", () => {
        const base = defineInterface(
            { id: "test.iface" },
            {
                ping: requestType(z.object({}), z.string(), {
                    description: "Returns 'pong'.",
                }),
            },
        );
        const sameDescChangedComment = defineInterface(
            { id: "test.iface" },
            {
                ping: requestType(z.object({}), z.string(), {
                    description: "Returns 'pong'.",
                    comment: "implementation runs in <1ms",
                }),
            },
        );
        const changedDesc = defineInterface(
            { id: "test.iface" },
            {
                ping: requestType(z.object({}), z.string(), {
                    description: "Returns 'pong'. MUST be idempotent.",
                }),
            },
        );

        expect(base.schemaHash).toBe(sameDescChangedComment.schemaHash);
        expect(base.schemaHash).not.toBe(changedDesc.schemaHash);
    });

    it("changes when methods change", () => {
        const a = defineInterface(
            { id: "test.iface" },
            { ping: requestType(z.object({}), z.string()) },
        );
        const b = defineInterface(
            { id: "test.iface" },
            { ping: requestType(z.object({}), z.number()) },
        );
        expect(a.schemaHash).not.toBe(b.schemaHash);
    });

    it("is independent of method-declaration order", () => {
        const a = defineInterface(
            { id: "test.iface" },
            {
                foo: notificationType(z.object({ x: z.number() })),
                bar: requestType(z.object({}), z.string()),
            },
        );
        const b = defineInterface(
            { id: "test.iface" },
            {
                bar: requestType(z.object({}), z.string()),
                foo: notificationType(z.object({ x: z.number() })),
            },
        );
        expect(a.schemaHash).toBe(b.schemaHash);
    });

    it("computeInterfaceHash matches schemaHash getter", () => {
        const i = defineInterface(
            { id: "test.iface" },
            { ping: requestType(z.object({}), z.string()) },
        );
        expect(computeInterfaceHash(i.toSchema())).toBe(i.schemaHash);
    });

    it("toSchema fills in the hash field", () => {
        const i = defineInterface(
            { id: "test.iface" },
            { ping: requestType(z.object({}), z.string()) },
        );
        expect(i.toSchema().hash).toBe(i.schemaHash);
    });
});

describe("defineInterface pinned hash", () => {
    it("does not affect the computed hash", () => {
        const withoutHash = defineInterface(
            { id: "test.iface" },
            { ping: requestType(z.object({}), z.string()) },
        );
        const withHash = defineInterface(
            { id: "test.iface", hash: withoutHash.schemaHash },
            { ping: requestType(z.object({}), z.string()) },
        );
        expect(withHash.schemaHash).toBe(withoutHash.schemaHash);
    });

    it("throws on a mismatching pinned hash", () => {
        expect(() =>
            defineInterface(
                { id: "test.iface", hash: "0000000000000000" },
                { ping: requestType(z.object({}), z.string()) },
            )
        ).toThrow(/hash mismatch/i);
    });
});

describe("specification extensions (x-*): rich single document, simple identity", () => {
    // A plain wire-contract document (no extensions) is the identity baseline.
    const base: LinkRpcInterfaceSchema = {
        id: "test.iface",
        hash: "",
        description: "Normative description.",
        methods: {
            order: {
                params: { type: "object", properties: {}, additionalProperties: false },
                result: { type: "string" },
                description: "Places an order.",
            },
        },
    };

    // The SAME wire contract, enriched with non-normative x-* extensions at
    // every level (interface, method, and inside a JSON Schema node). This is
    // the "one document" carrying richer codegen / safety expressions.
    const enriched = {
        ...base,
        "x-codegen": { tsClientName: "OrderClient", package: "@acme/orders" },
        methods: {
            order: {
                ...base.methods.order,
                "x-safety": { requiresConfirmation: true, rateLimitPerMin: 5 },
                params: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                    "x-validation": "z.object({}).strict()",
                },
                result: { type: "string", "x-format": "order-id" },
            },
        },
    } as unknown as LinkRpcInterfaceSchema;

    it("rich x-* material does not change the hash (identity is the simple projection)", () => {
        expect(computeInterfaceHash(enriched)).toBe(computeInterfaceHash(base));
    });

    describe("JSON-Schema normalization before interface hashing", () => {
        const rich = {
            id: "test.norm",
            hash: "",
            description: "Normative.",
            "x-codegen": { client: "NormClient" },
            methods: {
                op: {
                    "x-safety": { readOnly: true },
                    params: {
                        type: "object",
                        properties: {
                            b: { type: "string", minLength: 2 },
                            a: { type: "integer", default: 0 },
                        },
                        required: ["b", "a"],
                        "x-validation": "z.object({})",
                    },
                    result: {
                        $ref: "#/components/schemas/Blob",
                        "x-format": "id",
                    },
                    clientStream: {},
                    serverStream: { "x-only": "extension" },
                },
            },
            components: {
                schemas: {
                    Blob: {
                        type: "object",
                        title: "Blob",
                        properties: {
                            y: { type: "number" },
                            x: { type: "number" },
                        },
                        required: ["y", "x"],
                        examples: [1],
                    },
                },
            },
        } as unknown as LinkRpcInterfaceSchema;

        const normalized: LinkRpcInterfaceSchema = {
            id: "test.norm",
            hash: "",
            description: "Normative.",
            methods: {
                op: {
                    params: {
                        type: "object",
                        properties: {
                            b: { type: "string" },
                            a: { type: "integer" },
                        },
                        required: ["a", "b"],
                        additionalProperties: false,
                    },
                    result: { $ref: "#/components/schemas/Blob" },
                    clientStream: true,
                    serverStream: true,
                },
            },
            components: {
                schemas: {
                    Blob: {
                        type: "object",
                        title: "Blob",
                        properties: {
                            y: { type: "number" },
                            x: { type: "number" },
                        },
                        required: ["x", "y"],
                        additionalProperties: false,
                    },
                },
            },
        };

        it("hashes a rich unnormalized document like its normalized projection", () => {
            expect(computeInterfaceHash(rich)).toBe(computeInterfaceHash(normalized));
        });

        it("normalizes an extension-only schema to true", () => {
            const extensionOnly = structuredClone(normalized);
            extensionOnly.methods.op.params = {
                "x-codegen": { hint: "any" },
            } as never;
            const plainTrue = structuredClone(normalized);
            plainTrue.methods.op.params = true;
            expect(computeInterfaceHash(extensionOnly)).toBe(computeInterfaceHash(plainTrue));
        });
    });

    it("editing only an x-* value never changes the hash", () => {
        const editedExtension = {
            ...enriched,
            "x-codegen": { tsClientName: "TotallyDifferent", package: "@acme/other" },
        } as unknown as LinkRpcInterfaceSchema;
        expect(computeInterfaceHash(editedExtension)).toBe(computeInterfaceHash(enriched));
    });

    it("changing a wire field on the enriched document DOES change the hash", () => {
        const wireChanged = {
            ...enriched,
            methods: {
                order: {
                    ...(enriched.methods as Record<string, unknown>).order as object,
                    result: { type: "number", "x-format": "order-id" },
                },
            },
        } as unknown as LinkRpcInterfaceSchema;
        expect(computeInterfaceHash(wireChanged)).not.toBe(computeInterfaceHash(enriched));
    });

    it("EXTENSION_PREFIX is `x-`", () => {
        expect(EXTENSION_PREFIX).toBe("x-");
    });
});
