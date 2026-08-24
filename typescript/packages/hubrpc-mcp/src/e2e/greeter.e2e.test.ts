import { describe, expect, it } from "vitest";
import {
    createTestDisposableStore,
    llmResult,
    makeUngatedHarness,
} from "./harness";

describe("HubRpcMcpServer e2e (real hub + signing sender)", () => {
    it("routes a runHubRpcScript tool call through the hub to the greeter service", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const client = await makeUngatedHarness(d);

        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ con }) => con.call("hello", "greeter", "hello", { name: "world" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
                  "logs": [],
                  "result": {
                    "greeting": "Hello, world!",
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("captures sandbox console output in the result logs", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const client = await makeUngatedHarness(d);

        // Anything the script logs is captured and returned under `logs`, so the
        // calling model can see console output alongside the result.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `() => { console.log("hello from sandbox", 42); return 1; }` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
                  "logs": [
                    {
                      "level": "log",
                      "text": "hello from sandbox 42",
                    },
                  ],
                  "result": 1,
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("threads lastResultVal from one runHubRpcScript call into the next", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const client = await makeUngatedHarness(d);

        // The pooled connection remembers the previous script's return value and
        // exposes it as `lastResultVal` on the next run — same connection key,
        // so state carries over.
        const first = await client.callTool({ name: "runHubRpcScript", arguments: { code: `() => ({ n: 41 })` } });
        expect(llmResult(first)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
                  "logs": [],
                  "result": {
                    "n": 41,
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);

        const second = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ lastResultVal }) => lastResultVal.n + 1` } });
        expect(llmResult(second)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
                  "logs": [],
                  "result": 42,
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("surfaces a service error as an error result when calling an unknown member", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const client = await makeUngatedHarness(d);

        // The greeter interface has no `goodbye` member, so the hub rejects the
        // forwarded call; the tool reports it as an error result rather than a
        // completed one.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ con }) => con.call("hello", "greeter", "goodbye", { name: "world" })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "text": "runHubRpcScript failed: Method not found: hello::greeter::goodbye
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
