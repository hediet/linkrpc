import { describe, expect, it } from "vitest";
import { z } from "zod";
import { computeInterfaceHash } from "../hash";
import { defineInterface, InterfaceDefinition } from "../../connection/interfaceDefinition";
import { notificationType, requestType } from "../memberTypes";
import type { LinkRpcInterfaceSchema } from "../linkRpcInterfaceSchema";
import {
    defaultsInterface,
    directoryInterface,
    schemasInterface,
} from "../../hub/common/reflection.interfaces";
import { streamInterface } from "../../connection/streaming";
import { generateTsInterface } from "./generateTsInterface";

/**
 * Evaluate a generated source file in-process and return the
 * `InterfaceDefinition` it exports. The generated file is rewritten so
 * the `@hediet/linkrpc` import resolves to the source modules of this
 * package — `import()` doesn't have a hook for the test environment.
 */
async function _evalGenerated(source: string): Promise<{
    toSchema(): LinkRpcInterfaceSchema;
    schemaHash: string;
}> {
    // Strip imports, rebuild as an inline function call that closes over
    // the symbols we expose by name.
    const body = source
        .replace(/^import [^\n]*\n/gm, "")
        .replace(": LinkRpcInterfaceSchema =", "=")
        .replace(/^export const /m, "return ");

    const fn = new Function(
        "z", "defineInterface", "InterfaceDefinition", "requestType", "notificationType",
        `${body}`,
    );
    return fn(z, defineInterface, InterfaceDefinition, requestType, notificationType);
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
});
