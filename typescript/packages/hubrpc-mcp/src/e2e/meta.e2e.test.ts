import { describe, expect, it } from "vitest";
import { CONNECTION_DTS } from "../connectionDts";
import {
    createTestDisposableStore,
    makeUngatedHarness,
    parseResult,
} from "./harness";

/**
 * Meta coverage: the MCP surface the LLM sees before it ever touches a hub —
 * the full tool catalog (names, descriptions, input schemas) and the sandbox
 * `con.getDocs()` payload.
 */
describe("HubRpcMcpServer e2e (MCP tool catalog + documentation)", () => {
    it("advertises the full set of tools with their schemas", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const client = await makeUngatedHarness(d);

        const tools = await client.listTools();

        expect(tools).toMatchInlineSnapshot(`
          {
            "tools": [
              {
                "_meta": undefined,
                "annotations": {
                  "readOnlyHint": true,
                },
                "description": "Evaluate a JS function inside a QuickJS sandbox with \`con\` (the live hub connection), \`lastResultVal\` (previous call's original result), and \`mcp\` (optional result-presentation helpers) in scope.

          Before composing non-trivial calls, fetch the full sandbox API docs by running:
            \`async ({ con }) => con.getDocs()\`
          That returns the TypeScript declarations for the full script context, including \`con\`, \`mcp\`, sandbox limits, and available console.

          \`code\` MUST be a function expression, e.g.
            \`({ con }) => con.call("vscode", "vscode.window", "showInformationMessage", { message: "hi" })\`

          Set \`connection\` to a hub endpoint URI (e.g. \`unix:/path?token=…\` or \`wss://host?token=…\`) to target a specific hub, or leave it out to use the HUBRPC_ENDPOINT / HUBRPC_TOKEN env vars.

          ACCESS IS NOT AUTOMATIC: a gated \`con.call(...)\` is NOT silently granted. Reflection (\`con.explore\`) works out of the box, but calling a service member you have no capability for fails with a permission error. Inspect what you already hold with \`con.grants()\`, then ask the user for access — ideally for MANY members at once — with \`con.requestAccess({ permissions, duration })\`. Pick \`duration\`: \`once\` for a one-off, \`session\` for the rest of this connection, \`persistent\` to remember across runs. Batch related permissions into a single request so the user sees one prompt instead of many.

          BACKGROUND TASKS: if the code is still awaiting I/O (an RPC reply, a user dialog, a stream) when \`foregroundMs\` elapses, the call does NOT fail — it is parked as a background task and the result is \`{ status: "running", taskId, debugName, inFlight }\`. Use \`awaitHubRpcTask\` to wait for it or \`cancelHubRpcTask\` to abandon it. Set \`label\` to give the task a clear debug name. Starting a new \`runHubRpcScript\` cancels any task still parked (reported as \`supersededTask\`).

          RESULT PRESENTATION: returned image/audio/resource data is automatically emitted as native MCP content when it is a data URL, recognizable base64, an MCP content block, or an object shaped like \`{ data|base64|blob, mimeType }\`. This happens only after the script finishes: values passed between hub calls and saved in \`lastResultVal\` remain original and unmodified. Use \`presentation: "raw"\` or \`mcp.raw(value)\` when the model needs the literal base64. Use \`mcp.image\`, \`mcp.audio\`, \`mcp.resource\`, \`mcp.resourceLink\`, or \`mcp.result\` for explicit control. Native content always includes JSON text and structured fallbacks.

          The result contains \`{ status, result | taskId, logs, endpoint }\`. Pass \`trace: true\` to also receive a per-call JSON-RPC wire log under \`trace\` — useful when a call fails or returns unexpected data.",
                "execution": {
                  "taskSupport": "forbidden",
                },
                "inputSchema": {
                  "$schema": "http://json-schema.org/draft-07/schema#",
                  "properties": {
                    "code": {
                      "description": "JS function expression. Receives \`{ con, lastResultVal, mcp }\`. Sync or async. Return value is JSON-stringified.",
                      "type": "string",
                    },
                    "connection": {
                      "description": "Endpoint URI of the hub to connect to, e.g. \`unix:/run/hub.sock?token=…\`, \`npipe://./pipe/vscode-hubrpc-…?token=…\`, or \`wss://host:port?token=…\`. The token may be embedded as a \`token\` query param or supplied via the HUBRPC_TOKEN environment variable. When omitted entirely, the server falls back to the HUBRPC_ENDPOINT and HUBRPC_TOKEN environment variables.",
                      "type": "string",
                    },
                    "foregroundMs": {
                      "description": "How long the call runs synchronously before being parked as a background task. Defaults to 5000.",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991,
                      "type": "integer",
                    },
                    "label": {
                      "description": "Human-readable debug name for the task if it gets parked, e.g. "ask user to confirm deploy". When omitted, the name is inferred from the in-flight RPC(s) at park time.",
                      "type": "string",
                    },
                    "maxLifetimeMs": {
                      "description": "Absolute lifetime cap for a parked task before it is cancelled. Defaults to 120000.",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991,
                      "type": "integer",
                    },
                    "presentation": {
                      "description": "How to present the returned value. \`auto\` (default) recognizes MCP content blocks, data URLs, common base64 media signatures, and \`{ data|base64|blob, mimeType }\` objects, emitting native image/audio/resource content while keeping the original value available to subsequent scripts through \`lastResultVal\`. \`raw\` disables transformation and exposes the original JSON/base64.",
                      "enum": [
                        "auto",
                        "raw",
                      ],
                      "type": "string",
                    },
                    "trace": {
                      "description": "When true, include a \`trace\` array in the result with every outbound JSON-RPC request / notification, its outcome, and every permission round-trip. Off by default to keep results small.",
                      "type": "boolean",
                    },
                  },
                  "required": [
                    "code",
                  ],
                  "type": "object",
                },
                "name": "runHubRpcScript",
                "title": "Run JS against a hubrpc hub",
              },
              {
                "_meta": undefined,
                "annotations": {
                  "readOnlyHint": true,
                },
                "description": "Wait up to \`timeoutMs\` for a background task started by \`runHubRpcScript\` to settle. Returns \`{ status: "completed" | "error" | "cancelled" | "running", … }\`. A \`running\` result means it is still going (with a progress snapshot) — call again to keep waiting. Does NOT cancel the task.",
                "execution": {
                  "taskSupport": "forbidden",
                },
                "inputSchema": {
                  "$schema": "http://json-schema.org/draft-07/schema#",
                  "properties": {
                    "presentation": {
                      "description": "How to present the returned value. \`auto\` (default) recognizes MCP content blocks, data URLs, common base64 media signatures, and \`{ data|base64|blob, mimeType }\` objects, emitting native image/audio/resource content while keeping the original value available to subsequent scripts through \`lastResultVal\`. \`raw\` disables transformation and exposes the original JSON/base64.",
                      "enum": [
                        "auto",
                        "raw",
                      ],
                      "type": "string",
                    },
                    "taskId": {
                      "description": "Task id returned by \`runHubRpcScript\`.",
                      "type": "string",
                    },
                    "timeoutMs": {
                      "description": "How long to wait before returning a \`running\` snapshot. Defaults to 30000.",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991,
                      "type": "integer",
                    },
                  },
                  "required": [
                    "taskId",
                  ],
                  "type": "object",
                },
                "name": "awaitHubRpcTask",
                "title": "Wait for a parked hubrpc task",
              },
              {
                "_meta": undefined,
                "annotations": {
                  "readOnlyHint": true,
                },
                "description": "Soft-abort a background task started by \`runHubRpcScript\` and return its terminal outcome. The guest gets a short grace window to run cleanup.",
                "execution": {
                  "taskSupport": "forbidden",
                },
                "inputSchema": {
                  "$schema": "http://json-schema.org/draft-07/schema#",
                  "properties": {
                    "presentation": {
                      "description": "How to present the returned value. \`auto\` (default) recognizes MCP content blocks, data URLs, common base64 media signatures, and \`{ data|base64|blob, mimeType }\` objects, emitting native image/audio/resource content while keeping the original value available to subsequent scripts through \`lastResultVal\`. \`raw\` disables transformation and exposes the original JSON/base64.",
                      "enum": [
                        "auto",
                        "raw",
                      ],
                      "type": "string",
                    },
                    "taskId": {
                      "description": "Task id returned by \`runHubRpcScript\`.",
                      "type": "string",
                    },
                  },
                  "required": [
                    "taskId",
                  ],
                  "type": "object",
                },
                "name": "cancelHubRpcTask",
                "title": "Cancel a parked hubrpc task",
              },
            ],
          }
        `);
    });

    it("con.getDocs() returns the embedded connection type declarations verbatim", async ({ onTestFinished }) => {
        const d = createTestDisposableStore(onTestFinished);
        const client = await makeUngatedHarness(d);

        const res = await client.callTool({
            name: "runHubRpcScript",
            arguments: { code: `async ({ con }) => con.getDocs()` },
        });
        const out = parseResult(res);

        // Served entirely inside the sandbox (no hub round-trip); it must be the
        // bundled `connection.d.ts` verbatim.
        expect(out.status).toBe("completed");
        expect(out.result).toBe(CONNECTION_DTS);
    });
});
