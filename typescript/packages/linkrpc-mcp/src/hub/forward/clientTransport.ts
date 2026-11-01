import type { IRequestSender, JsonValue, RawStreamingCall } from "@hediet/linkrpc";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mcpForwardInterface } from "../contracts";
import type { McpClientInfo } from "../clientSession";

export interface McpForwardClientTransportOptions {
    /** Forward interface the service advertises; defaults to `mcp.forward`. */
    readonly interfaceId?: string;
    readonly clientInfo?: McpClientInfo;
    /** MCP identity (account) to connect as; defaults to the server's default identity. */
    readonly mcpIdentity?: string;
}

/**
 * MCP client transport that opens one `mcp.forward::connect` leg to
 * `serviceId` through `sender`. Use it with an MCP SDK `Client`. The sender's
 * signing and capability negotiation apply to the leg.
 */
export class McpForwardClientTransport implements Transport {
    public onmessage?: (message: JSONRPCMessage) => void;
    public onclose?: () => void;
    public onerror?: (error: Error) => void;
    private _call: RawStreamingCall | undefined;
    private _closed = false;

    constructor(
        private readonly _sender: IRequestSender<any>,
        private readonly _serviceId: string,
        private readonly _options: McpForwardClientTransportOptions = {},
    ) {}

    public async start(): Promise<void> {
        if (this._call || this._closed) throw new Error("MCP transport already started or closed");
        const interfaceId = this._options.interfaceId ?? mcpForwardInterface.info.id;
        const call = this._sender.sendRequestWithStream(
            `${this._serviceId}::${interfaceId}::connect`,
            {
                clientInfo: { ...(this._options.clientInfo ?? { name: "linkrpc-mcp", version: "1.0.0" }) },
                ...(this._options.mcpIdentity !== undefined ? { mcpIdentity: this._options.mcpIdentity } : {}),
            },
            {
                onStreamMessage: (payload) => {
                    const result = z.object({ frame: JSONRPCMessageSchema }).safeParse(payload);
                    if (result.success) {
                        this.onmessage?.(result.data.frame);
                    } else {
                        this.onerror?.(new Error(`Invalid forwarded MCP frame: ${result.error.message}`));
                        void this.close().catch((error: unknown) => this.onerror?.(asError(error)));
                    }
                },
            },
        );
        this._call = call;
        void call.result.then(
            () => this._end(),
            (error: unknown) => this._end(asError(error)),
        );
    }

    public async send(message: JSONRPCMessage): Promise<void> {
        if (!this._call || this._closed) throw new Error("MCP transport is not connected");
        // JSON round-trip drops `undefined` members, e.g. `params` of a parameterless request.
        await this._call.send({ frame: JSON.parse(JSON.stringify(message)) as JsonValue });
    }

    public async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        const call = this._call;
        this._call = undefined;
        try {
            await call?.cancel("MCP client disconnected");
        } finally {
            call?.dispose?.("MCP client disconnected");
            this.onclose?.();
        }
    }

    private _end(error?: Error): void {
        if (this._closed) return;
        this._closed = true;
        this._call = undefined;
        if (error) this.onerror?.(error);
        this.onclose?.();
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
