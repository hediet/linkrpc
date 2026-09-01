import { describe, expect, it } from "vitest";
import type { McpExploreCall } from "../server";
import {
  createTestDisposableStore,
  llmResult,
  makeGatedHarness,
  makeGatedHub,
} from "./harness";

describe("LinkRpcMcpServer e2e (con.explore against a gated hub)", () => {
  it("browses visible interfaces and reports gated directories", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const exploreCalls: McpExploreCall[] = [];
    const client = await makeGatedHarness(
      await makeGatedHub(d),
      d,
      { onExploreCall: (call) => exploreCalls.push(call) },
    );

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: { code: `async ({ con }) => con.explore({ kind: "browse" })` },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://$root/hubAccess@81b90efa3d0ed791.ts",
                    "interfaceHash": "81b90efa3d0ed791",
                    "interfaceId": "hubAccess",
                    "serviceId": "",
                  },
                  {
                    "documentId": "linkrpc://$root/hubGrantedServiceId@0729860c2fd54fc9.ts",
                    "interfaceHash": "0729860c2fd54fc9",
                    "interfaceId": "hubGrantedServiceId",
                    "serviceId": "",
                  },
                ],
                "inaccessible": [
                  {
                    "hint": "Repeat this explore call with \`requestPermission: true\` to search all gated directories.",
                    "reason": "capability required but none provided",
                    "serviceId": "hub",
                  },
                ],
                "kind": "browse",
                "total": 2,
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
    expect(exploreCalls).toMatchObject([
      {
    arguments: { kind: "browse" },
    result: { kind: "browse", total: 2 },
      },
    ]);
  });

  it("unlocks gated directories and pages a stable sorted listing", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const firstResponse = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({ kind: "browse", requestPermission: true, limit: 2 })`,
      },
    });
    expect(llmResult(firstResponse)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://$root/hubAccess@81b90efa3d0ed791.ts",
                    "interfaceHash": "81b90efa3d0ed791",
                    "interfaceId": "hubAccess",
                    "serviceId": "",
                  },
                  {
                    "documentId": "linkrpc://$root/hubGrantedServiceId@0729860c2fd54fc9.ts",
                    "interfaceHash": "0729860c2fd54fc9",
                    "interfaceId": "hubGrantedServiceId",
                    "serviceId": "",
                  },
                ],
                "kind": "browse",
                "nextCursor": "2",
                "total": 4,
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);

    const secondResponse = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({ kind: "browse", requestPermission: true, limit: 2, cursor: "2" })`,
      },
    });
    expect(llmResult(secondResponse)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts",
                    "interfaceHash": "6a089c5e05cb0b9c",
                    "interfaceId": "greeter",
                    "serviceId": "hello",
                  },
                  {
                    "documentId": "linkrpc://hub/hubServiceIdRegistry@3089bc85428190dd.ts",
                    "interfaceHash": "3089bc85428190dd",
                    "interfaceId": "hubServiceIdRegistry",
                    "serviceId": "hub",
                  },
                ],
                "kind": "browse",
                "total": 4,
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
  });

  it("supports exact service/interface filters and explicit internal interfaces", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({
                    kind: "browse",
                    requestPermission: true,
                    serviceId: "hello",
                    includeInternal: true,
                })`,
      },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts",
                    "interfaceHash": "6a089c5e05cb0b9c",
                    "interfaceId": "greeter",
                    "serviceId": "hello",
                  },
                  {
                    "documentId": "linkrpc://hello/linkrpc.defaults@6338c42820453561.ts",
                    "interfaceHash": "6338c42820453561",
                    "interfaceId": "linkrpc.defaults",
                    "serviceId": "hello",
                  },
                  {
                    "documentId": "linkrpc://hello/linkrpc.directory@9878186e61a6d6b6.ts",
                    "interfaceHash": "9878186e61a6d6b6",
                    "interfaceId": "linkrpc.directory",
                    "serviceId": "hello",
                  },
                  {
                    "documentId": "linkrpc://hello/linkrpc.schemas@f1e32214d017b570.ts",
                    "interfaceHash": "f1e32214d017b570",
                    "interfaceId": "linkrpc.schemas",
                    "serviceId": "hello",
                  },
                ],
                "kind": "browse",
                "total": 4,
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
  });

  it("greps literal text in generated defineInterface source", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({
                    kind: "grep",
                    requestPermission: true,
                    pattern: "greeting",
                    syntax: "literal",
                })`,
      },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts",
                    "interfaceHash": "6a089c5e05cb0b9c",
                    "interfaceId": "greeter",
                    "matches": [
                      {
                        "lineRange": [
                          22,
                          24,
                        ],
                        "member": "hello",
                        "searchResult": "            z.object({
                      greeting: z.string(),
                  }),",
                      },
                    ],
                    "serviceId": "hello",
                  },
                ],
                "kind": "grep",
                "pattern": "greeting",
                "syntax": "literal",
                "total": 1,
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
  });

  it("greps regex alternatives across document metadata and schema source", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({
                    kind: "grep",
                    requestPermission: true,
                    serviceId: "hello",
                    pattern: "Greets|greeting",
                    contextLines: 0,
                })`,
      },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts",
                    "interfaceHash": "6a089c5e05cb0b9c",
                    "interfaceId": "greeter",
                    "matches": [
                      {
                        "lineRange": [
                          10,
                          10,
                        ],
                        "searchResult": " * Greets by name.",
                      },
                      {
                        "lineRange": [
                          15,
                          15,
                        ],
                        "searchResult": "        description: "Greets by name.",",
                      },
                      {
                        "lineRange": [
                          23,
                          23,
                        ],
                        "member": "hello",
                        "searchResult": "                greeting: z.string(),",
                      },
                    ],
                    "serviceId": "hello",
                  },
                ],
                "kind": "grep",
                "pattern": "Greets|greeting",
                "syntax": "regex",
                "total": 1,
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
  });

  it("inspects the complete generated virtual document", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({
                    kind: "inspect",
                    requestPermission: true,
                    serviceId: "hello",
                    interfaceId: "greeter",
                })`,
      },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "documentId": "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts",
                "format": "source",
                "interfaceHash": "6a089c5e05cb0b9c",
                "interfaceId": "greeter",
                "kind": "inspect",
                "serviceId": "hello",
                "source": "// virtualDocument: "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts"
      // serviceId: "hello"
      // interfaceId: "greeter"
      // interfaceHash: "6a089c5e05cb0b9c"
      // discoveredFrom: "hello"
      import { defineInterface, notificationType, requestType } from "@hediet/linkrpc";
      import { z } from "zod";

      /**
       * Greets by name.
       */
      export const greeterInterface = defineInterface(
          {
              id: "greeter",
              description: "Greets by name.",
          },
          {
              hello: requestType(
                  z.object({
                      name: z.string(),
                  }),
                  z.object({
                      greeting: z.string(),
                  }),
              ),
          },
      );
      ",
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
  });

  it("inspects the exact raw wire schema", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({
                    kind: "inspect",
                    requestPermission: true,
                    serviceId: "hello",
                    interfaceId: "greeter",
                    format: "schema",
                })`,
      },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
              "logs": [],
              "result": {
                "documentId": "linkrpc://hello/greeter@6a089c5e05cb0b9c.ts",
                "format": "schema",
                "interfaceHash": "6a089c5e05cb0b9c",
                "interfaceId": "greeter",
                "kind": "inspect",
                "schema": {
                  "description": "Greets by name.",
                  "hash": "6a089c5e05cb0b9c",
                  "id": "greeter",
                  "methods": {
                    "hello": {
                      "params": {
                        "additionalProperties": false,
                        "properties": {
                          "name": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "name",
                        ],
                        "type": "object",
                      },
                      "result": {
                        "additionalProperties": false,
                        "properties": {
                          "greeting": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "greeting",
                        ],
                        "type": "object",
                      },
                    },
                  },
                },
                "serviceId": "hello",
              },
              "status": "completed",
            },
            "type": "text",
          },
        ],
      }
    `);
  });

  it("rejects missing kinds and invalid regular expressions", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const exploreCalls: McpExploreCall[] = [];
    const client = await makeGatedHarness(
      await makeGatedHub(d),
      d,
      { onExploreCall: (call) => exploreCalls.push(call) },
    );

    const missingKind = await client.callTool({
      name: "runLinkRpcScript",
      arguments: { code: `async ({ con }) => con.explore({})` },
    });
    expect(llmResult(missingKind)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "runLinkRpcScript failed: explore requires \`kind: "browse" | "grep" | "inspect"\`.
          at <anonymous> (eval.js:2)
          at <eval> (eval.js:13)
      ",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `);

    const invalidRegex = await client.callTool({
      name: "runLinkRpcScript",
      arguments: {
        code: `async ({ con }) => con.explore({ kind: "grep", pattern: "[" })`,
      },
    });
    expect(llmResult(invalidRegex)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "runLinkRpcScript failed: Invalid grep regular expression: Invalid regular expression: /[/iu: Unterminated character class
          at <anonymous> (eval.js:2)
          at <eval> (eval.js:13)
      ",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `);
    expect(exploreCalls).toEqual([
      {
        arguments: {},
        error: "explore requires `kind: \"browse\" | \"grep\" | \"inspect\"`.",
      },
      {
        arguments: { kind: "grep", pattern: "[" },
        error: expect.stringContaining("Invalid grep regular expression"),
      },
    ]);
  });
});
