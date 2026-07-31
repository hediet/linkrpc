import { describe, expect, it } from "vitest";
import {
  createTestDisposableStore,
  llmResult,
  makeGatedHarness,
  makeGatedHub,
} from "./harness";

describe("LinkRpcMcpServer e2e (con.explore against a gated hub)", () => {
  it("browses visible interfaces and reports gated directories", async ({ onTestFinished }) => {
    const d = createTestDisposableStore(onTestFinished);
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const response = await client.callTool({
      name: "runLinkRpcScript",
      arguments: { code: `async ({ con }) => con.explore({ kind: "browse" })` },
    });

    expect(llmResult(response)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "json": {
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://$root/hubAccess@5560868beca678de.ts",
                    "interfaceHash": "5560868beca678de",
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
              "logs": [],
              "result": {
                "entries": [
                  {
                    "documentId": "linkrpc://$root/hubAccess@5560868beca678de.ts",
                    "interfaceHash": "5560868beca678de",
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
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
                    "documentId": "linkrpc://hello/linkrpc.defaults@f0bcf98c6733cef9.ts",
                    "interfaceHash": "f0bcf98c6733cef9",
                    "interfaceId": "linkrpc.defaults",
                    "serviceId": "hello",
                  },
                  {
                    "documentId": "linkrpc://hello/linkrpc.directory@29c73b0ebe5d0361.ts",
                    "interfaceHash": "29c73b0ebe5d0361",
                    "interfaceId": "linkrpc.directory",
                    "serviceId": "hello",
                  },
                  {
                    "documentId": "linkrpc://hello/linkrpc.schemas@e12e0c013a3dbd24.ts",
                    "interfaceHash": "e12e0c013a3dbd24",
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
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
                          19,
                          21,
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
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
                          12,
                          12,
                        ],
                        "searchResult": "        description: "Greets by name.",",
                      },
                      {
                        "lineRange": [
                          20,
                          20,
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
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
              "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
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
    const client = await makeGatedHarness(await makeGatedHub(d), d);

    const missingKind = await client.callTool({
      name: "runLinkRpcScript",
      arguments: { code: `async ({ con }) => con.explore({})` },
    });
    expect(llmResult(missingKind)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "text": "runLinkRpcScript failed: explore requires \`kind: "browse" | "grep" | "inspect"\`.
              at <anonymous> (eval.js:6)
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
              at <anonymous> (eval.js:6)
          ",
                "type": "text",
              },
            ],
            "isError": true,
          }
        `);
  });
});
