import { defineInterface, requestType } from "@vscode/hubrpc";
import { z } from "zod";

/**
 * Transparent MCP tunnel.
 *
 * A single long-lived {@link mcpForwardInterface.connect} request opens one MCP
 * session "leg". The MCP JSON-RPC byte stream rides the hubrpc `$stream` duplex
 * correlated to that request — **no MCP method is modeled here**. Payloads are
 * opaque JSON-RPC messages, exactly as MCP emits them, so the forwarder that
 * serves this interface stays dumb: it shuttles frames between a child process'
 * stdio and the stream without ever parsing them.
 *
 * Why one duplex stream instead of request/response per MCP message: MCP is
 * bidirectional and asynchronous (server-initiated `notifications/.../
 * list_changed`, sampling requests). `$stream` already provides an ordered,
 * request-correlated, cancellable duplex that the runtime keeps alive with
 * periodic pings, so one stream == one MCP session leg.
 *
 * Lifecycle:
 *  - The consumer (the aggregator) calls `connect()`, obtaining
 *    `{ result, send, cancel, onMessage }`.
 *  - `send({ frame })` carries a frame **to** the child (stdin);
 *    `onMessage(({ frame }) => …)` receives frames **from** the child (stdout).
 *  - Child exit → the forwarder resolves the request (`connect` returns) → the
 *    consumer drops the client.
 *  - Consumer dispose / service removed → `cancel()` → the forwarder kills the
 *    child.
 *
 * Lives in the CLI package because the producer (`hub mcp-forward`) is a CLI
 * command; the in-extension aggregator imports this contract from here too.
 */
export const mcpForwardInterface = defineInterface(
    {
        id: "vscode.mcp-forward",
        description:
            "Transparent MCP tunnel: one streaming request carries a full MCP "
            + "JSON-RPC session as opaque duplex stream frames.",
    },
    {
        connect: requestType(
            z.object({
                /**
                 * Advertised so a consumer can label/version the leg without
                 * opening the inner MCP session. Purely informational.
                 */
                clientInfo: z
                    .object({ name: z.string(), version: z.string() })
                    .optional(),
            }),
            z.object({
                /** Informational server identity, if the forwarder knows it. */
                serverInfo: z
                    .object({ name: z.string(), version: z.string() })
                    .optional(),
            }),
            {
                description:
                    "Open one MCP session leg. Resolves (void-ish) only when the "
                    + "session ends (child exits or the caller cancels). The MCP "
                    + "traffic is the stream, not the result.",
            },
        ).withStream({
            // caller → forwarder: MCP frames going *to* the child.
            client: z.object({ frame: z.unknown() }),
            // forwarder → caller: MCP frames coming *from* the child.
            server: z.object({ frame: z.unknown() }),
        }),
    },
);
