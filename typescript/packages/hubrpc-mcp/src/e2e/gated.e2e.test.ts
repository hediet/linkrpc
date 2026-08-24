import { describe, expect, it } from "vitest";
import {
    createTestDisposableStore,
    llmResult,
    makeGatedHarness,
    makeGatedHub,
    makeManagedDefaultHarness,
    parseResult,
} from "./harness";

describe("HubRpcMcpServer e2e (gated hub, capability checking enabled)", () => {
    it("denies the tool's forwarded call when the signer holds no capability", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ con }) => con.call("hello", "greeter", "hello", { name: "world" })` } });

        // The forwarded `hello::greeter::hello` call is signed but uncapped (the
        // principal holds no caps yet), so the gate rejects it; the tool
        // surfaces that as an error result (plain text, `isError: true`).
        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "text": "runHubRpcScript failed: Permission required for hello::greeter::hello — no capability is held for this call.
          Inspect current access with con.grants(), then request it with con.requestAccess({ permissions: [{ target: { serviceId: { exact: "hello" }, interfaceId: { exact: "greeter" }, members: [{ exact: "hello" }] }, canInvoke: true }], duration: "longLived" }).
          Original error: capability required but none provided
              at <anonymous> (eval.js:6)
          ",
                "type": "text",
              },
            ],
            "isError": true,
          }
        `);
    });

    it("con.grants() is empty before any access is negotiated", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // A fresh gated principal holds no durable capabilities yet — reflection
        // works out of the box but nothing shows up in the cap bag.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `async ({ con }) => con.grants()` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
                  "logs": [],
                  "result": {
                    "count": 0,
                    "grants": [],
                  },
                  "status": "completed",
                },
                "type": "text",
              },
            ],
          }
        `);
    });

    it("admits the call after the tool negotiates a greeter cap via hubAccess", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // The script first asks the hub for permission through the root-served
        // `hubAccess` front door, then makes the call;
        // the durable greeter cap minted by consent joins the principal's cap
        // bag so the forwarded call is admitted.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `async ({ con }) => {
                await con.requestAccess({
                    consumer: { name: "e2e", purpose: "say hello" },
                    permissions: [{
                        target: {
                            serviceId: { exact: "hello" },
                            interfaceId: { exact: "greeter" },
                            members: [{ exact: "hello" }],
                        },
                        canInvoke: true,
                    }],
                    duration: "persistent",
                });
                return con.call("hello", "greeter", "hello", { name: "world" });
            }` } });

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

    it("con.grants() reflects the minted greeter cap once access is negotiated", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // Negotiate the greeter cap, then read the cap bag back: the durable
        // capability minted by consent is now summarised by `con.grants()`. The
        // cap's `expiresAtMs` is wall-clock, so it's stripped before snapshotting.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `async ({ con }) => {
                await con.requestAccess({
                    consumer: { name: "e2e", purpose: "say hello" },
                    permissions: [{
                        target: {
                            serviceId: { exact: "hello" },
                            interfaceId: { exact: "greeter" },
                            members: [{ exact: "hello" }],
                        },
                        canInvoke: true,
                    }],
                    duration: "persistent",
                });
                return con.grants();
            }` } });

        const out = parseResult(res);
        for (const g of out.result.grants) delete g.expiresAtMs;
        expect(out).toMatchInlineSnapshot(`
          {
            "endpoint": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
            "logs": [],
            "result": {
              "count": 1,
              "grants": [
                {
                  "audience": "id:key:9GZx2z1ySiGfh4Hw3ggwEtH1cyzqEKSpd01t-HbedsM",
                  "issuer": "id:key:hJp8Lb280M8aofDhmAdVLc2ey84o9DJOO23Rx61hek4",
                  "oneShot": false,
                  "permissions": [
                    {
                      "canDelegate": false,
                      "canInvoke": true,
                      "interfaceId": "greeter",
                      "members": [
                        "hello",
                      ],
                      "serviceId": "hello",
                    },
                  ],
                },
              ],
            },
            "status": "completed",
          }
        `);
    });

    it("auto-negotiates the greeter cap when the call opts into requestPermission", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeGatedHarness(gated, d);

        // `{ requestPermission: true }` lets a single `con.call` do the whole
        // dance: the first attempt is rejected (uncapped), the host negotiates a
        // durable greeter cap through `hubAccess`, then retries — all without the
        // script touching `con.requestAccess`.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ con }) => con.call("hello", "greeter", "hello", { name: "world" }, { requestPermission: true })` } });

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

    it("includes a JSON-RPC wire trace when the managed default call opts into trace", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeManagedDefaultHarness(gated, d);

        // `trace: true` fans the transport I/O + permission round-trips into a
        // `trace` array on the result. Over the managed default (ConnectionPool)
        // leg the wire log records the forwarded RPC, the rejection, the
        // hubAccess negotiation, and the successful retry. Trace lines carry
        // random nonces/signatures, so we assert on shape rather than snapshot.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ con }) => con.call("hello", "greeter", "hello", { name: "world" }, { requestPermission: true })`, trace: true } });

        const out = parseResult(res);
        expect(out.status).toBe("completed");
        expect(out.result).toEqual({ greeting: "Hello, world!" });
        expect(Array.isArray(out.trace)).toBe(true);
        const traceText = out.trace.join("\n");
        expect(traceText).toContain("hello::greeter::hello");
        expect(traceText).toContain("hubAccess::requestAccess");
    });

    it("serves the default connection over an in-process transport (managed signing, no socket)", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const gated = await makeGatedHub(d);
        const client = await makeManagedDefaultHarness(gated, d);

        // No `connection` argument → the server resolves its in-process default
        // connection: a managed principal signing through the hub-served
        // `identity::*`. `{ requestPermission: true }` negotiates the greeter cap
        // and retries, exactly as over a socket.
        const res = await client.callTool({ name: "runHubRpcScript", arguments: { code: `({ con }) => con.call("hello", "greeter", "hello", { name: "world" }, { requestPermission: true })` } });

        expect(llmResult(res)).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "json": {
                  "endpoint": "inproc",
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
});
