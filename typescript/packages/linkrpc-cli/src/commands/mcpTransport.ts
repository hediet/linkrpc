import type { CliChannel } from '@hediet/linkrpc-client-internal';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpForwardInterface } from '../mcpForward.interface';

/** MCP transport over the CLI's signed, capability-aware request channel. */
export class McpHubTransport implements Transport {
    public onmessage?: (message: JSONRPCMessage) => void;
    public onclose?: () => void;
    public onerror?: (error: Error) => void;
    private _call: ReturnType<CliChannel['sendRequestWithStream']> | undefined;
    private _closed = false;

    constructor(
        private readonly _channel: CliChannel,
        private readonly _serviceId: string,
    ) {}

    public async start(): Promise<void> {
        if (this._call || this._closed) throw new Error('MCP transport already started or closed');
        const call = this._channel.sendRequestWithStream(
            `${this._serviceId}::${mcpForwardInterface.info.id}::connect`,
            { clientInfo: { name: 'linkrpc-hub-mcp', version: '1.0.0' } },
            {
                onStreamMessage: payload => {
                    const result = z.object({ frame: JSONRPCMessageSchema }).safeParse(payload);
                    if (result.success) {
                        this.onmessage?.(result.data.frame);
                    } else {
                        this.onerror?.(new Error(`Invalid forwarded MCP frame: ${result.error.message}`));
                        void this.close().catch(error => this.onerror?.(asError(error)));
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

    private _end(error?: Error): void {
        if (this._closed) return;
        this._closed = true;
        this._call = undefined;
        if (error) this.onerror?.(error);
        this.onclose?.();
    }

    public async send(message: JSONRPCMessage): Promise<void> {
        if (!this._call || this._closed) throw new Error('MCP transport is not connected');
        await this._call.send({ frame: z.json().parse(message) });
    }

    public async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        const call = this._call;
        this._call = undefined;
        try {
            await call?.cancel('MCP client disconnected');
        } finally {
            call?.dispose?.('MCP client disconnected');
            this.onclose?.();
        }
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
