import { ErrorCode, type InterfaceRegistration, type LinkRpcConnection, RpcError } from "@hediet/linkrpc";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { legacyMcpForwardInterface, mcpForwardInterface } from "../contracts";
import type { ForwardLegStream } from "./producer";

export interface ServeMcpForwardInstanceOptions {
    readonly connection: LinkRpcConnection;
    readonly serviceId: string;
    /** Unstarted transport to one running MCP server, e.g. this process's own stdio. */
    readonly transport: Transport;
    /** Register reflection for `serviceId`. Defaults to `true`. */
    readonly enableReflection?: boolean;
    /** Also serve the deprecated `vscode.mcp-forward` id. Defaults to `true`. */
    readonly legacyAlias?: boolean;
    readonly log?: (line: string) => void;
}

export interface McpForwardInstance extends InterfaceRegistration {
    /** Resolves when the MCP server's transport closes. */
    readonly closed: Promise<void>;
}

/**
 * Serve `mcp.forward` for one already running MCP server instance. An instance
 * has one MCP session, so it serves one connection at a time; further
 * `connect` calls fail while it is in use. A later connection reuses the same
 * instance and sends its own `initialize`, which the server may reject.
 * Messages from the server while no connection is open are dropped.
 */
export function serveMcpForwardInstance(options: ServeMcpForwardInstanceOptions): McpForwardInstance {
    const log = options.log ?? ((line: string) => console.error(line));
    const { transport } = options;
    let current: { readonly stream: ForwardLegStream; finish(): void } | undefined;
    let ended = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

    transport.onmessage = (message) => {
        if (current === undefined) {
            log("mcp-forward: dropped a message from the MCP server while no connection is open");
            return;
        }
        void current.stream.send({ frame: message }).catch(() => { /* the leg is ending */ });
    };
    transport.onerror = (error) => log(`mcp-forward: MCP server: ${error.message}`);
    transport.onclose = () => {
        ended = true;
        current?.finish();
        resolveClosed();
    };
    const started = transport.start();
    started.catch((error: unknown) => {
        log(`mcp-forward: cannot start the MCP server transport: ${error instanceof Error ? error.message : String(error)}`);
        void transport.close();
    });

    const connect = (_params: unknown, _ctx: unknown, stream: ForwardLegStream) => {
        if (ended) throw new RpcError("The MCP server instance has ended", ErrorCode.internalError);
        if (current !== undefined) {
            throw new RpcError("The MCP server instance is in use by another connection", ErrorCode.internalError);
        }
        return new Promise<Record<string, never>>((resolve) => {
            const leg = {
                stream,
                finish: () => {
                    if (current !== leg) return;
                    current = undefined;
                    stream.signal.removeEventListener("abort", leg.finish);
                    resolve({});
                },
            };
            current = leg;
            stream.onMessage(({ frame }) => {
                const parsed = JSONRPCMessageSchema.safeParse(frame);
                if (!parsed.success) {
                    log(`mcp-forward: dropped an invalid MCP message from the caller: ${parsed.error.message}`);
                    return;
                }
                void started.then(() => {
                    if (current === leg) return transport.send(parsed.data);
                }).catch((error: unknown) => {
                    log(`mcp-forward: cannot send to the MCP server: ${error instanceof Error ? error.message : String(error)}`);
                });
            });
            if (stream.signal.aborted) leg.finish();
            else stream.signal.addEventListener("abort", leg.finish, { once: true });
        });
    };

    const registrations: InterfaceRegistration[] = [];
    registrations.push(options.connection.register(mcpForwardInterface, { connect }, { serviceId: options.serviceId }));
    if (options.legacyAlias !== false) {
        registrations.push(options.connection.register(legacyMcpForwardInterface, { connect }, { serviceId: options.serviceId }));
    }
    if (options.enableReflection !== false) {
        registrations.push(options.connection.enableReflection({ serviceId: options.serviceId }));
    }
    return {
        closed,
        dispose: () => {
            for (const registration of registrations.reverse()) registration.dispose();
            current?.finish();
            void transport.close().catch(() => { /* already closed */ });
        },
    };
}

/**
 * Newline-delimited MCP over a stream pair connected to a running MCP server,
 * e.g. this process's stdin/stdout. Closes when `input` ends.
 */
export function streamInstanceTransport(input: Readable, output: Writable): Transport {
    const transport = new StdioServerTransport(input, output);
    const close = () => void transport.close().catch(() => { /* already closed */ });
    input.once("end", close);
    input.once("close", close);
    return transport;
}
