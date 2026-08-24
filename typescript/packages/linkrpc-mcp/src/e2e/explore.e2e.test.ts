import { describe, expect, it } from "vitest";
import {
    createTestDisposableStore,
    llmResult,
    makeGatedHarness,
    makeGatedHub,
} from "./harness";

/**
 * `con.explore(...)` exercised end-to-end against the gated hub (which serves a
 * real reflection directory). Each case asserts the full tool result the LLM
 * receives via an inline snapshot. The gated harness signs as the deterministic
 * seed-0 principal, so `endpoint` is stable across runs.
 */
describe("LinkRpcMcpServer e2e (con.explore against a gated hub)", () => {
    it("explore() sees the root interfaces and reports the hub directory as gated", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // The root reflection surface (hubGrantedServiceId, hubAccess,
        // linkrpc.directory, linkrpc.schemas) is visible without any capability;
        // the gated `hello::greeter` service is absent, and the `hub` directory
        // is reported under `inaccessible` with a `con.requestAccess(...)` hint.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore()` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "hubGrantedServiceId",
                        "serviceId": "",
                      },
                      {
                        "interfaceId": "hubAccess",
                        "serviceId": "",
                      },
                    ],
                    "inaccessible": [
                      {
                        "hint": "The "hub" directory is gated. To enumerate the whole hub in a SINGLE consent prompt, re-run explore with requestPermission, e.g. con.explore({ requestPermission: true }) — this unlocks every gated directory at once. (To unlock just this one directory instead, request its listing interface: con.requestAccess({ permissions: [{ target: { serviceId: { exact: "hub" }, interfaceId: { exact: "linkrpc.directory" }, members: [{ exact: "list" }] }, canInvoke: true }], duration: "longLived" }).)",
                        "reason": "capability required but none provided",
                        "serviceId": "hub",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 2,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("explore({ requestPermission: true }) unlocks the gated hub directory and reveals the service", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // With requestPermission the walk requests a reflection cap (linkrpc.* on
        // all services) through hubAccess, then enumerates the previously-gated
        // `hub` directory — so `hello::greeter` now appears and nothing is left
        // under `inaccessible`.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, maxResults: 0 })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "hubGrantedServiceId",
                        "serviceId": "",
                      },
                      {
                        "interfaceId": "hubAccess",
                        "serviceId": "",
                      },
                      {
                        "interfaceId": "hubServiceIdRegistry",
                        "serviceId": "hub",
                      },
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 4,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("filters by serviceId, returning only that service's interfaces", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `serviceId` narrows the (post-unlock) listing to just `hello`, so only
        // the greeter interface survives the filter.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, serviceId: "hello" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 1,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("filters by an explicit linkrpc.* interfaceId despite the default hiding", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `linkrpc.*` is hidden by default, but filtering for an exact `linkrpc.*`
        // interfaceId opts back in — so every service exposing `linkrpc.directory`
        // (the connection root, the `hub` directory, and `hello`) is listed.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, interfaceId: "linkrpc.directory" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "linkrpc.directory",
                        "serviceId": "",
                      },
                      {
                        "interfaceId": "linkrpc.directory",
                        "serviceId": "hub",
                      },
                      {
                        "interfaceId": "linkrpc.directory",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 3,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("returns an empty listing when the filter matches nothing", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // A serviceId no participant serves yields zero matches (offset 0, no
        // nextOffset), even though the walk itself succeeded.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, serviceId: "does-not-exist" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [],
                    "offset": 0,
                    "totalMatched": 0,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("pages through results with offset and nextOffset", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `maxResults` is the page size and `offset` is where the page starts.
        // The first page reports `nextOffset` because more matches remain; the
        // second page (starting at that offset) returns the rest and omits
        // `nextOffset`. `totalMatched` is stable across pages.
        const page1 = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, maxResults: 2 })` } });
        expect(llmResult(page1)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "hubGrantedServiceId",
                        "serviceId": "",
                      },
                      {
                        "interfaceId": "hubAccess",
                        "serviceId": "",
                      },
                    ],
                    "nextOffset": 2,
                    "offset": 0,
                    "totalMatched": 4,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);

        const page2 = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, maxResults: 2, offset: 2 })` } });
        expect(llmResult(page2)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "hubServiceIdRegistry",
                        "serviceId": "hub",
                      },
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 2,
                    "totalMatched": 4,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("includes linkrpc.* internal interfaces when showLinkrpcInternalInterfaces is set", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // By default `linkrpc.*` reflection plumbing is hidden. With
        // `showLinkrpcInternalInterfaces: true` the hello service's reflection
        // interfaces (linkrpc.directory / linkrpc.defaults / linkrpc.schemas) appear
        // alongside its `greeter` interface.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, serviceId: "hello", showLinkrpcInternalInterfaces: true })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "linkrpc.directory",
                        "serviceId": "hello",
                      },
                      {
                        "interfaceId": "linkrpc.defaults",
                        "serviceId": "hello",
                      },
                      {
                        "interfaceId": "linkrpc.schemas",
                        "serviceId": "hello",
                      },
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 4,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("includes the greeter interface's JSON schema when includeSchema is set", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `includeSchema` fetches the greeter interface's JSON schema through the
        // reflection surface and attaches it to the entry. Filtered to `greeter`
        // so the snapshot stays focused on the custom interface.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, serviceId: "hello", interfaceId: "greeter", includeSchema: true })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "greeter",
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
                    ],
                    "offset": 0,
                    "totalMatched": 1,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("includes a generated TypeScript module when includeTypeScript is set", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `includeTypeScript` re-generates a self-contained `defineInterface`
        // module for the greeter interface from its fetched schema.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, serviceId: "hello", interfaceId: "greeter", includeTypeScript: true })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                        "typeScript": "import { defineInterface, notificationType, requestType } from "@hediet/linkrpc";
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
                    ],
                    "offset": 0,
                    "totalMatched": 1,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("grep filters listings by a metadata substring", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `grep` is a cheap case-insensitive substring match over serviceId,
        // interfaceId, and service description — here "greet" matches only the
        // `greeter` interface, no schema fetch involved.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, grep: "greet" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 1,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("grep does not match terms that only appear inside the schema", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // "greeting" is the greeter's result field — it lives in the JSON schema,
        // not in any listing's metadata, so the cheap `grep` finds nothing.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, grep: "greeting" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [],
                    "offset": 0,
                    "totalMatched": 0,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("grepAllSchemas matches terms found inside an interface's JSON schema", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `grepAllSchemas` fetches every candidate's schema and searches it too,
        // so the schema-only term "greeting" now surfaces the `greeter` interface.
        const res = await client.callTool({ name: "runLinkRpcScript", arguments: { code: `async ({ con }) => con.explore({ requestPermission: true, grepAllSchemas: "greeting" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:mx3wi1wn_P8F3Cd-s6dnch4dczAwXL47uHfF5tNpla8",
                  "logs": [],
                  "result": {
                    "entries": [
                      {
                        "interfaceId": "greeter",
                        "serviceId": "hello",
                      },
                    ],
                    "offset": 0,
                    "totalMatched": 1,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });
});
