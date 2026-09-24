import { describe, expect, it } from "vitest";
import { z } from "zod";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { computeInterfaceHash } from "../hash";
import { defineInterface, InterfaceDefinition } from "../../connection/interfaceDefinition";
import { applicationError, notificationType, requestType, rpcError, type ApplicationErrorDescriptor, type Schema } from "../memberTypes";
import type { LinkRpcInterfaceSchema } from "../linkRpcInterfaceSchema";
import type { LinkRpcJsonSchema } from "../linkRpcJsonSchema";
import {
    defaultsInterface,
    directoryInterface,
    schemasInterface,
} from "../../hub/common/reflection.interfaces";
import { streamInterface } from "../../connection/streaming";
import { generateTsInterface } from "./generateTsInterface";
import { defineInterfaceTemplate } from "../defineInterfaceTemplate";

// Compiler integration tests load the transitive package graph while CI builds run in parallel.
const TYPECHECK_TIMEOUT_MS = 30_000;

/**
 * Evaluate a generated source file in-process and return the
 * `InterfaceDefinition` it exports. The generated file is rewritten so
 * the `@hediet/linkrpc` import resolves to the source modules of this
 * package — `import()` doesn't have a hook for the test environment.
 */
async function _evalGenerated(source: string): Promise<{
    toSchema(): LinkRpcInterfaceSchema;
    schemaHash: string;
    members: Record<string, {
        paramsSchema: z.ZodType;
        errors: readonly ApplicationErrorDescriptor<number, string, unknown, string>[];
    }>;
}> {
    // Erase TypeScript syntax, then rebuild as an inline function call that
    // closes over the symbols we expose by name.
    const js = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const body = js
        .replace(/^import [^\n]*\n/gm, "")
        .replace(/^export const /m, "return ");

    const fn = new Function(
        "z", "defineInterface", "InterfaceDefinition", "requestType", "notificationType",
        "applicationError", "rpcError",
        `${body}`,
    );
    return fn(z, defineInterface, InterfaceDefinition, requestType, notificationType, applicationError, rpcError);
}

async function _roundTrip(def: { toSchema(): LinkRpcInterfaceSchema; schemaHash: string }): Promise<void> {
    const source = generateTsInterface(def.toSchema());
    const regenerated = await _evalGenerated(source);
    expect(regenerated.schemaHash).toBe(def.schemaHash);
    // Pin the canonical form too — same JSON minus the (regenerated) hash.
    const canonical = (s: LinkRpcInterfaceSchema) => ({ ...s, hash: "" });
    expect(canonical(regenerated.toSchema())).toEqual(canonical(def.toSchema()));
}

describe("generateInterface", () => {
    it("round-trips callable template checked errors and compiles specialized error clients", async () => {
        const Store = defineInterfaceTemplate({ id: "generic.checked", parameters: ["Value"] },
            <V>({ Value }: { Value: Schema<V> }) => ({
                set: requestType(Value, Value).withErrors([
                    applicationError("conflict", { data: z.object({ current: Value }) }),
                    rpcError(410, { message: z.literal("retry"), data: z.object({ value: Value }) }),
                ]),
            }));
        const definition = defineInterface({ id: "test.checked.codegen" }, {
            numbers: Store({ Value: z.number() }),
            text: Store({ Value: z.string() }).mapMembers({ set: "writeText" }),
        });
        await _roundTrip(definition);
        const source = generateTsInterface(definition.toSchema(), { exportName: "generated", linkRpcImport: "../../index" });
        _expectTypeChecks(`${source}
import { isRpcFailure, type InterfaceClient, type InterfaceHandlers } from "../../index";
const conflict = generated.members["numbers$set"].errors[0];
conflict.create({ current: 1 });
// @ts-expect-error concrete parameterized error data is numeric
conflict.create({ current: "wrong" });
const retry = generated.members["numbers$set"].errors[1];
retry.create({ message: "retry", data: { value: 1 } });
// @ts-expect-error concrete raw body is numeric
retry.create({ message: "retry", data: { value: "wrong" } });
const handlers: InterfaceHandlers<typeof generated> = {
    "numbers$set": value => value,
    writeText: value => generated.members.writeText.errors[0].create({ current: value }),
};
declare const client: InterfaceClient<typeof generated>;
async function check() {
    const result = await client["numbers$set"](1);
    if (!isRpcFailure(result)) { const number: number = result; return; }
    if (result.error.type === "conflict") {
        const current: number = result.error.data.current;
    } else {
        const value: number = result.error.data.value;
        const message: "retry" = result.error.message;
    }
}
`);
    }, TYPECHECK_TIMEOUT_MS);

    it("round-trips grouped authoring as flat generated clients and implementations", async () => {
        const Echo = defineInterfaceTemplate({ id: "generic.echo", parameters: ["value"] }, <V>({ value }: { value: Schema<V> }) => ({
            echo: requestType(value, value),
        }));
        const definition = defineInterface({ id: "test.groups.codegen" }, {
            numbers: Echo({ value: z.number() }),
            text: Echo({ value: z.string() }).mapMembers({ echo: "readText" }),
        });
        await _roundTrip(definition);
        const source = generateTsInterface(definition.toSchema(), { exportName: "generated", linkRpcImport: "../../index" });
        _expectTypeChecks(`${source}
import { type InterfaceHandlers, type InterfaceClient } from "../../index";
const handlers: InterfaceHandlers<typeof generated> = {
    "numbers$echo": value => value + 1,
    readText: value => value.toUpperCase(),
};
declare const client: InterfaceClient<typeof generated>;
const number: Promise<number> = client["numbers$echo"](1);
const text: Promise<string> = client.readText("hello");
// @ts-expect-error reflected metadata does not reconstruct local handler groups
const grouped: InterfaceHandlers<typeof generated> = { numbers: { echo: (value: number) => value }, text: { echo: (value: string) => value } };
`);
    }, TYPECHECK_TIMEOUT_MS);

    it("round-trips raw body schemas and preserves exact code-discriminated types", async () => {
        const definition = defineInterface({ id: "test.raw-codegen" }, {
            read: requestType(z.object({}), z.string()).withErrors([
                rpcError(-32001, { message: z.string(), data: z.object({ retryAfter: z.number() }) }),
                rpcError(-32002, { message: z.string(), data: z.unknown().optional() }),
                rpcError(-32003, { data: z.union([z.string(), z.number()]) }),
                rpcError(-32004, z.union([
                    z.object({ message: z.literal("retry"), data: z.number() }),
                    z.object({ message: z.literal("stop"), data: z.null().optional() }),
                ])),
                applicationError("NotFound"),
            ]),
        });
        await _roundTrip(definition);
        const source = generateTsInterface(definition.toSchema(), { exportName: "generated", linkRpcImport: "../../index" });
        expect(source).toContain("rpcError(-32001, z.object(");
        _expectTypeChecks(`${source}
import { isRpcFailure, type InterfaceClient } from "../../index";
declare const client: InterfaceClient<typeof generated>;
const raw = generated.members.read.errors[0].create({ message: "retry", data: { retryAfter: 3 } });
const code: -32001 = raw.code;
const delay: number = raw.data.retryAfter;
// @ts-expect-error raw body is not any
raw.data.missing;
// @ts-expect-error required payload remains required
generated.members.read.errors[0].create({ message: "retry" });
generated.members.read.errors[1].create({ message: "absent" });
generated.members.read.errors[1].create({ message: "null", data: null });
// @ts-expect-error union data does not accept null
generated.members.read.errors[2].create({ message: "x", data: null });
const stopped = generated.members.read.errors[3].create({ message: "stop" });
// @ts-expect-error body schema literal discriminators remain checked
generated.members.read.errors[3].create({ message: "retry" });
client.read({}).then((value) => {
    if (!isRpcFailure(value)) return;
    if (value.error.code === -32001) {
        const delay: number = value.error.data.retryAfter;
        // @ts-expect-error narrowing does not erase payload types
        const wrong: string = value.error.data.retryAfter;
    } else if (value.error.code === -32003) {
        const data: string | number = value.error.data;
    } else if (value.error.code === 1) {
        const name: "NotFound" = value.error.type;
    }
});
`);
        const preserved = await _evalGenerated(generateTsInterface(definition.toSchema(), { preserveWireSchema: true }));
        expect(preserved.toSchema()).toEqual(definition.toSchema());
    }, TYPECHECK_TIMEOUT_MS);

    it("preserves imported raw body unions and component references without legacy siblings", async () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.serde-raw-error", hash: "",
            methods: { read: { params: true, result: true, errors: [{
                code: -32001, schema: { oneOf: [
                    { type: "object", properties: { message: { const: "retry" }, data: { $ref: "#/components/schemas/retry~1~0delay" } },
                        required: ["message", "data"], additionalProperties: false },
                    { type: "object", properties: { message: { const: "stop" } },
                        required: ["message"], additionalProperties: false },
                ] },
            }] } },
            components: { schemas: {
                "retry/~delay": { type: "object", properties: { retryAfter: { type: "number" } },
                    required: ["retryAfter"], additionalProperties: false },
            } },
        };
        schema.hash = computeInterfaceHash(schema);
        const source = generateTsInterface(schema, { preserveWireSchema: true, linkRpcImport: "../../index" });
        _expectTypeChecks(source);
        expect((await _evalGenerated(source)).toSchema()).toEqual(schema);
    }, TYPECHECK_TIMEOUT_MS);

    it("round-trips named errors with shared default codes and inner payload schemas", async () => {
        const definition = defineInterface({ id: "test.generated-named-errors" }, {
            read: requestType(z.object({}), z.string()).withErrors([
                applicationError("NotFound", { message: "Not found" }),
                applicationError("Conflict", {
                    message: "Conflict at revision {revision}", data: z.object({ revision: z.number() }),
                }),
                applicationError("Override", { code: 42, data: z.string().nullable() }),
            ]),
        });
        const source = generateTsInterface(definition.toSchema());
        expect(source).toContain('applicationError("NotFound", { code: 1, message: "Not found" })');
        expect(source).toContain('applicationError("Conflict", { code: 1');
        _expectTypeChecks(source);
        await _roundTrip(definition);
        const preserved = await _evalGenerated(generateTsInterface(definition.toSchema(), { preserveWireSchema: true }));
        expect(preserved.toSchema()).toEqual(definition.toSchema());
        expect(preserved.members.read.errors[1].is({
            ...preserved.members.read.errors[1].create({ revision: 17 }),
            message: "Conflict at revision 17",
        })).toBe(true);
        const schema = definition.toSchema();
        expect(() => generateTsInterface({
            ...schema,
            methods: { read: { ...schema.methods.read, errors: [
                { type: "Duplicate", code: 1, message: "a" },
                { type: "Duplicate", code: 2, message: "b" },
            ] } },
        })).toThrow(/Duplicate/);
        expect(() => generateTsInterface({
            ...schema,
            methods: { read: { ...schema.methods.read,
                errors: [{ type: "", code: 1, message: "Invalid" }],
            } },
        })).toThrow(/nonempty/);
    }, TYPECHECK_TIMEOUT_MS);

    it("emits typed error descriptors and preserves recursive referenced data", async () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.generated-errors",
            hash: "",
            methods: {
                read: {
                    params: { type: "object", properties: {}, additionalProperties: false },
                    result: { type: "string" },
                    errors: [
                        { code: 404, message: "Not found" },
                        {
                            code: 409,
                            message: "Conflict",
                            data: { $ref: "#/components/schemas/Conflict" },
                        },
                    ],
                },
            },
            components: {
                schemas: {
                    Conflict: {
                        type: "object",
                        properties: {
                            reason: { type: "string" },
                            parent: { $ref: "#/components/schemas/Conflict" },
                        },
                        required: ["reason"],
                        additionalProperties: false,
                    },
                },
            },
        };
        schema.hash = computeInterfaceHash(schema);

        const source = generateTsInterface(schema, { preserveWireSchema: true });
        expect(source).toContain('applicationError(404, "Not found")');
        expect(source).toContain('applicationError(409, "Conflict", ConflictSchema)');
        expect(source).toContain("] as const)");
        const regenerated = await _evalGenerated(source);
        expect(regenerated.schemaHash).toBe(schema.hash);
        expect(regenerated.toSchema()).toEqual(schema);
        _expectTypeChecks(source);
    }, TYPECHECK_TIMEOUT_MS);

    it("rejects errors on notifications and invalid codes", () => {
        const base: LinkRpcInterfaceSchema = {
            id: "test.invalid-errors",
            hash: "",
            methods: { notify: { params: true } },
        };
        expect(() => generateTsInterface({
            ...base,
            methods: {
                notify: {
                    params: true,
                    errors: [{ code: 1, message: "impossible" }],
                },
            },
        })).toThrow(/Notification/);
        expect(() => generateTsInterface({
            ...base,
            methods: {
                request: {
                    params: true,
                    result: true,
                    errors: [{ code: -32600, message: "reserved" }],
                },
            },
        })).toThrow(/reserved/);
        expect(() => generateTsInterface({
            ...base,
            methods: {
                request: {
                    params: true,
                    result: true,
                    errors: [{ code: -32800, message: "cancelled" }],
                },
            },
        })).toThrow(/reserved/);
    });

    it("renders JSON wire int64 and uint64 values as TypeScript numbers", async () => {
        const schema = {
            id: "test.json-integers",
            hash: "",
            methods: {
                attach: {
                    params: {
                        type: "object",
                        properties: {
                            generation: { type: "integer", format: "uint64" },
                            epoch: { type: "integer", format: "int64" },
                        },
                        required: ["generation", "epoch"],
                        additionalProperties: false,
                    },
                    result: { type: "null" },
                },
            },
        } as LinkRpcInterfaceSchema;
        schema.hash = computeInterfaceHash(schema);

        const source = generateTsInterface(schema, { preserveWireSchema: true });
        expect(source).not.toContain("bigint");
        expect(source).not.toContain("z.uint64()");
        expect(source).not.toContain("z.int64()");
        expect(source.match(/z\.int\(\)/g)).toHaveLength(2);

        const generated = await _evalGenerated(source);
        expect(generated.members.attach.paramsSchema.safeParse({
            generation: 0,
            epoch: -3,
        }).success).toBe(true);
        expect(generated.members.attach.paramsSchema.safeParse({
            generation: 4,
            epoch: 3,
        }).success).toBe(true);
        expect(generated.members.attach.paramsSchema.safeParse({
            generation: -1,
            epoch: 3,
        }).success).toBe(false);
        expect(generated.members.attach.paramsSchema.safeParse({
            generation: 4n,
            epoch: 3n,
        }).success).toBe(false);
        _expectTypeChecks(source);
    }, TYPECHECK_TIMEOUT_MS);

    it("renders nullable primitive type arrays recursively and annotation-only schemas", async () => {
        const schema = {
            id: "test.schemars",
            hash: "",
            methods: {
                inspect: {
                    params: { $ref: "#/components/schemas/Node" },
                    result: { title: "Arbitrary JSON", description: "Any JSON value." },
                },
            },
            components: {
                schemas: {
                    Node: {
                        type: "object",
                        properties: {
                            value: { type: ["string", "null"] },
                            next: { $ref: "#/components/schemas/Node" },
                        },
                        required: ["value"],
                        additionalProperties: false,
                    },
                },
            },
        } as unknown as LinkRpcInterfaceSchema;
        schema.hash = computeInterfaceHash(schema);

        const source = generateTsInterface(schema, { preserveWireSchema: true });
        expect(source).toContain("value: string | null;");
        expect(source).toContain("z.union([");
        expect(source).toContain("z.string()");
        expect(source).toContain("z.null()");
        expect(source).toContain('z.unknown().meta({ title: "Arbitrary JSON", description: "Any JSON value." })');
        expect(source).toContain("const wireSchema: LinkRpcInterfaceSchema = JSON.parse(");

        const generated = await _evalGenerated(source);
        expect(generated.schemaHash).toBe(schema.hash);
        expect(generated.members.inspect.paramsSchema.safeParse({
            value: null,
            next: { value: "leaf" },
        }).success).toBe(true);
        _expectTypeChecks(source);
    }, TYPECHECK_TIMEOUT_MS);

    it("round-trips defaultsInterface", async () => {
        await _roundTrip(defaultsInterface);
    });

    it("round-trips directoryInterface", async () => {
        await _roundTrip(directoryInterface);
    });

    it("round-trips schemasInterface", async () => {
        await _roundTrip(schemasInterface);
    });

    it("round-trips streamInterface (notification + member docs)", async () => {
        await _roundTrip(streamInterface);
    });

    it("round-trips an interface that uses every supported shape", async () => {
        const big = defineInterface(
            {
                id: "test.codegen",
                description: "Exercises every emitter path.",
                comment: "non-normative implementation note",
            },
            {
                ping: requestType(z.object({}), z.string(), {
                    description: "Returns 'pong'.",
                    comment: "fast path",
                }),
                count: notificationType(z.object({ n: z.int() })),
                identity: requestType(
                    z.object({
                        id: z.uuid(),
                        email: z.email().optional(),
                        url: z.url(),
                        when: z.iso.datetime(),
                    }),
                    z.object({ ok: z.boolean() }),
                ),
                pickColor: requestType(
                    z.object({ color: z.enum(["red", "green", "blue"]) }),
                    z.literal("ok"),
                ),
                tagged: requestType(
                    z.object({
                        evt: z.discriminatedUnion("kind", [
                            z.object({ kind: z.literal("a"), x: z.number() }),
                            z.object({ kind: z.literal("b"), y: z.string() }),
                        ]),
                    }),
                    z.union([z.string(), z.number()]),
                ),
                tuples: requestType(
                    z.object({ pair: z.tuple([z.string(), z.int()]) }),
                    z.array(z.boolean()),
                ),
                streamy: requestType(z.object({}), z.string()).withStream({
                    client: z.object({ cancel: z.boolean() }),
                    server: z.object({ progress: z.number() }),
                }),
            },
        );
        await _roundTrip(big);
        expect(computeInterfaceHash(big.toSchema())).toBe(big.schemaHash);
        const source = generateTsInterface(big.toSchema());
        expect(source).toContain("/**\n * Exercises every emitter path.\n */\nexport const testCodegenInterface");
        expect(source).toMatch(/\/\*\*\n\s+\* Returns 'pong'\.\n\s+\*\/\n\s+ping:/);
    });

    it("produces stable, snapshot-able output for directoryInterface", () => {
        // Pinning the formatting keeps the generator from silently
        // drifting (e.g. trailing-comma style, indent, key ordering).
        expect(generateTsInterface(directoryInterface.toSchema())).toMatchInlineSnapshot(`
          "import { defineInterface, notificationType, requestType } from "@hediet/linkrpc";
          import { z } from "zod";

          /**
           * Reflection: list services exposed by this endpoint. Can also list other directory services that can be explored.
           */
          export const hubrpcDirectoryInterface = defineInterface(
              {
                  id: "hubrpc.directory",
                  description: "Reflection: list services exposed by this endpoint. Can also list other directory services that can be explored.",
              },
              {
                  list: requestType(
                      z.object({
                          interfaceId: z.string().optional(),
                          interfaceIdPrefix: z.string().optional(),
                          serviceId: z.string().optional(),
                          serviceIdScopes: z.array(z.union([
                              z.object({
                                  exact: z.string(),
                              }),
                              z.object({
                                  prefix: z.string(),
                              }),
                          ])).optional(),
                          cursor: z.string().optional(),
                          limit: z.int().optional(),
                          timeoutMs: z.int().optional(),
                      }),
                      z.object({
                          items: z.array(z.object({
                              serviceId: z.string(),
                              interfaceId: z.string(),
                              interfaceHash: z.string(),
                              serviceDescription: z.string().optional(),
                              rootPrincipalSets: z.array(z.array(z.object({
                                  principal: z.string(),
                                  transitive: z.boolean().optional(),
                              }))).optional(),
                              reachableServiceIds: z.array(z.union([
                                  z.object({
                                      exact: z.string(),
                                  }),
                                  z.object({
                                      prefix: z.string(),
                                  }),
                              ])).optional(),
                          })),
                          nextCursor: z.string().optional(),
                          truncated: z.boolean().optional(),
                      }),
                  ),
                  watch: requestType(
                      z.object({
                          interfaceId: z.string().optional(),
                          interfaceIdPrefix: z.string().optional(),
                          serviceId: z.string().optional(),
                          serviceIdScopes: z.array(z.union([
                              z.object({
                                  exact: z.string(),
                              }),
                              z.object({
                                  prefix: z.string(),
                              }),
                          ])).optional(),
                      }),
                      z.object({}),
                  ).withStream({
                      server: z.object({}),
                  }),
              },
          );
          "
        `);
    });

    it("can emit a typed bare target alongside the interface definition", () => {
        const runtime = defineInterface(
            { id: "cdp.runtime" },
            {
                evaluate: requestType(
                    z.object({ expression: z.string() }),
                    z.object({ result: z.object({ value: z.number() }) }),
                ),
            },
        );
        const source = generateTsInterface(runtime.toSchema(), {
            exportName: "cdpRuntimeInterface",
            linkRpcImport: "../../index",
            preserveWireSchema: true,
            bareTarget: {
                exportName: "cdpRuntime",
                prefix: "Runtime.",
            },
        });
        expect(source).toContain(
            'import { bareInterfaceTarget, InterfaceDefinition, notificationType, requestType, type LinkRpcInterfaceSchema } from "../../index";',
        );
        expect(source).toContain(
            'export const cdpRuntime = bareInterfaceTarget(cdpRuntimeInterface, { prefix: "Runtime." });',
        );

        _expectTypeChecks(`${source}
import { LinkRpcConnection } from "../../index";
declare const connection: LinkRpcConnection;
const result = await connection.get(cdpRuntime).evaluate({ expression: "6 * 7" });
result.result.value satisfies number;
// @ts-expect-error expression is required
connection.get(cdpRuntime).evaluate({});
// @ts-expect-error bare targets do not accept native get options
connection.get(cdpRuntime, { serviceId: "runtime" });
// @ts-expect-error bare targets cannot be routed through a service
connection.service("runtime").get(cdpRuntime);
connection.register(cdpRuntime, {
    evaluate: ({ expression }) => ({ result: { value: expression.length } }),
});
connection.service("runtime").register(cdpRuntime, {
    evaluate: async ({ expression }) => ({ result: { value: expression.length } }),
});
connection.register(cdpRuntime, {
    // @ts-expect-error generated bare targets preserve handler result types
    evaluate: () => ({ result: { value: "invalid" } }),
});
`);

        expect(() => generateTsInterface(runtime.toSchema(), {
            bareTarget: { exportName: "invalid", prefix: "bad::prefix" },
        })).toThrow(/Bare interface prefix/);
    }, TYPECHECK_TIMEOUT_MS);

    it("preserves untagged oneOf and self-recursive components when requested", async () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.preserved",
            hash: "",
            description: "Reads recursive nodes.",
            methods: {
                read: {
                    params: { $ref: "#/components/schemas/Node" },
                    result: {
                        oneOf: [
                            { type: "string" },
                            { type: "number" },
                        ],
                    },
                },
            },
            components: {
                schemas: {
                    Node: {
                        description: "A recursive node.",
                        type: "object",
                        properties: {
                            value: {
                                type: "string",
                                description: "Node value; never write */ literally.",
                            },
                            child: { $ref: "#/components/schemas/Node" },
                        },
                        required: ["value"],
                        additionalProperties: false,
                    },
                },
            },
        };
        schema.hash = computeInterfaceHash(schema);

        const source = generateTsInterface(schema, { preserveWireSchema: true });
        expect(source).toContain("/**\n * A recursive node.\n */\nconst NodeSchema");
        expect(source).toContain("Node value; never write *\\/ literally.");
        expect(source).toContain("/**\n         * A recursive node.\n         */\n        read:");
        expect(source).toContain("/**\n * Reads recursive nodes.\n */\nexport const testPreservedInterface");
        expect(source).toContain("get child()");
        expect(source).toContain("z.union([");
        expect(source).toContain("{ frozenSchema: wireSchema }");

        const regenerated = await _evalGenerated(source);
        expect(regenerated.schemaHash).toBe(schema.hash);
        expect(regenerated.toSchema()).toEqual(schema);
    });

    it("emits untagged oneOf as the normative Zod union", () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.one-of",
            hash: "",
            methods: {
                parse: {
                    params: { oneOf: [{ type: "string" }, { type: "number" }] },
                    result: { type: "boolean" },
                },
            },
        };
        schema.hash = computeInterfaceHash(schema);
        expect(generateTsInterface(schema)).toContain("z.union([");
    });

    it("generates guarded mutually recursive component schemas", async () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.mutual-recursion",
            hash: "",
            methods: {
                inspect: {
                    params: { $ref: "#/components/schemas/A" },
                    result: { type: "boolean" },
                },
            },
            components: {
                schemas: {
                    A: {
                        type: "object",
                        properties: { b: { $ref: "#/components/schemas/B" } },
                        required: ["b"],
                        additionalProperties: false,
                    },
                    B: {
                        type: "object",
                        properties: { a: { $ref: "#/components/schemas/A" } },
                        additionalProperties: false,
                    },
                },
            },
        };
        schema.hash = computeInterfaceHash(schema);
        const source = generateTsInterface(schema, { preserveWireSchema: true });
        expect(source).toContain("type A = { b: B; };");
        expect(source).toContain("type B = { a?: A; };");
        expect(source).toContain("const ASchema: z.ZodType<A> = z.lazy");
        expect(source).toContain("const BSchema: z.ZodType<B> = z.lazy");
        const generated = await _evalGenerated(source);
        expect(generated.schemaHash).toBe(schema.hash);
        expect(generated.members.inspect.paramsSchema.safeParse({ b: {} }).success).toBe(true);
    });

    it("keeps precise recursive payload types across supported containers", () => {
        const schema: LinkRpcInterfaceSchema = {
            id: "test.recursive-types",
            hash: "",
            methods: {
                inspect: {
                    params: { $ref: "#/components/schemas/Node" },
                    result: { type: "boolean" },
                },
            },
            components: {
                schemas: {
                    Leaf: {
                        type: "object",
                        properties: { label: { type: "string" } },
                        required: ["label"],
                        additionalProperties: false,
                    },
                    Node: {
                        type: "object",
                        properties: {
                            value: { type: "string" },
                            leaf: { $ref: "#/components/schemas/Leaf" },
                            child: { $ref: "#/components/schemas/Node" },
                            children: {
                                type: "array",
                                items: { $ref: "#/components/schemas/Node" },
                            },
                            pair: {
                                type: "array",
                                prefixItems: [
                                    { type: "number" },
                                    { $ref: "#/components/schemas/Node" },
                                ],
                                items: false,
                            },
                            restPair: {
                                type: "array",
                                prefixItems: [{ type: "number" }],
                                items: {
                                    anyOf: [
                                        { type: "string" },
                                        { $ref: "#/components/schemas/Node" },
                                    ],
                                },
                            },
                            choice: {
                                anyOf: [
                                    { type: "string" },
                                    { $ref: "#/components/schemas/Node" },
                                ],
                            },
                        },
                        required: ["value", "leaf", "children"],
                        additionalProperties: true,
                    },
                },
            },
        };
        schema.hash = computeInterfaceHash(schema);
        const source = generateTsInterface(schema, {
            linkRpcImport: "../../index",
            preserveWireSchema: true,
        });

        expect(source).not.toMatch(/\btype Leaf =/);
        expect(source).toContain("leaf: z.infer<typeof LeafSchema>");
        expect(source).toContain("children: Array<Node>");
        expect(source).toContain("pair?: [number, Node]");
        expect(source).toContain("restPair?: [number, ...Array<string | Node>]");
        expect(source).toContain("choice?: string | Node");
        _expectTypeChecks(`${source}
const valid: Node = {
    value: "root",
    leaf: { label: "leaf" },
    children: [{ value: "child", leaf: { label: "nested" }, children: [] }],
    extra: 123,
};
const optionalFieldsMayBeAbsent: Node = { value: "root", leaf: { label: "leaf" }, children: [] };
const validRest: Node = { ...optionalFieldsMayBeAbsent, restPair: [1, "text", optionalFieldsMayBeAbsent] };
const inferred: z.infer<typeof NodeSchema> = valid;
const inferredValue: string = inferred.children[0]!.value;
// @ts-expect-error recursive children retain their value type
const invalidNestedValue: Node = { value: "root", leaf: { label: "leaf" }, children: [{ value: 1, leaf: { label: "nested" }, children: [] }] };
// @ts-expect-error required fields remain required recursively
const invalidNestedRequired: Node = { value: "root", leaf: { label: "leaf" }, children: [{ value: "child", leaf: { label: "nested" } }] };
// @ts-expect-error schema inference retains recursive field types
const invalidInferredValue: number = inferred.children[0]!.value;
// @ts-expect-error tuple rest values must satisfy one of the union branches
const invalidRest: Node = { ...optionalFieldsMayBeAbsent, restPair: [1, false] };
`);
    }, TYPECHECK_TIMEOUT_MS);

    it("allocates distinct safe names for colliding recursive components", () => {
        const recursiveObject = (ref: string): LinkRpcJsonSchema => ({
            type: "object",
            properties: { next: { $ref: `#/components/schemas/${ref}` } },
            additionalProperties: false,
        });
        const schema: LinkRpcInterfaceSchema = {
            id: "test.recursive-name-collisions",
            hash: "",
            methods: {
                inspect: {
                    params: { $ref: "#/components/schemas/A-B" },
                    result: { $ref: "#/components/schemas/z" },
                },
            },
            components: {
                schemas: {
                    "A-B": recursiveObject("A-B"),
                    A_B: recursiveObject("A_B"),
                    z: recursiveObject("z"),
                    type: recursiveObject("type"),
                    Array: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Array" },
                    },
                },
            },
        };
        schema.hash = computeInterfaceHash(schema);
        const source = generateTsInterface(schema, {
            linkRpcImport: "../../index",
            preserveWireSchema: true,
        });
        expect(source).toContain("type A_B =");
        expect(source).toContain("type A_B_2 =");
        expect(source).toContain("type z_2 =");
        expect(source).toContain("type type_2 =");
        expect(source).toContain("type Array_2 = Array<Array_2>");
        expect(source).toContain("const A_BSchema:");
        expect(source).toContain("const A_BSchema_2:");
        _expectTypeChecks(source);
    }, TYPECHECK_TIMEOUT_MS);
});

function _expectTypeChecks(source: string): void {
    const fileName = fileURLToPath(new URL("./generated-type-test.ts", import.meta.url)).replace(/\\/g, "/");
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.fileExists = (candidate) => candidate === fileName || fileExists(candidate);
    host.readFile = (candidate) => candidate === fileName ? source : readFile(candidate);
    host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
        candidate === fileName
            ? ts.createSourceFile(candidate, source, languageVersion, true, ts.ScriptKind.TS)
            : getSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([fileName], options, host));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
    ))).toEqual([]);
}
