import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
    defineInterface,
    requestType,
    LinkRpcConnection,
    TransportPair,
    ErrorCode,
    RpcError,
} from "@hediet/linkrpc";
import { connectViaTransport } from "@hediet/linkrpc-client-internal";
import { callCommand } from "./call";

const streamer = defineInterface(
    { id: "test.streamer" },
    {
        run: requestType(
            z.object({ count: z.number() }),
            z.object({ done: z.boolean() }),
        ).withStream({ server: z.object({ line: z.string() }) }),
        plain: requestType(
            z.object({}),
            z.object({ ok: z.boolean() }),
        ),
        denied: requestType(z.object({}), z.object({ ok: z.boolean() })),
    },
);

function makeChannel() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    server.register(streamer, {
        run: async ({ count }, _ctx, stream) => {
            for (let i = 0; i < count; i++) await stream.send({ line: `chunk ${i}` });
            return { done: true };
        },
        plain: async () => ({ ok: true }),
        denied: () => { throw new RpcError('Capability missing', ErrorCode.permissionRequired); },
    });
    server.enableReflection();
    const conn = connectViaTransport(pair.a);
    return {
        channel: conn.channel,
        dispose: () => {
            conn.close();
            server.close();
        },
    };
}

describe("callCommand streaming", () => {
    it('explains how to request access when the call is denied', async () => {
        const { channel, dispose } = makeChannel();
        try {
            await expect(callCommand(channel, { methodRef: 'test.streamer::denied', paramsArg: '{}' }))
                .rejects.toThrow('--request-cap');
        } finally { dispose(); }
    });

    it('explains how to request access when schema lookup is denied', async () => {
        const { channel, dispose } = makeChannel();
        try {
            const send = vi.spyOn(channel, 'sendRequestWithStream').mockImplementation(() => {
                throw new RpcError('Schema access missing', ErrorCode.permissionRequired);
            });
            await expect(callCommand(channel, { methodRef: 'test.streamer::plain', paramsArg: '{}' }))
                .rejects.toThrow('--request-cap');
            expect(send.mock.calls[0][0]).toBe('hubrpc.schemas::get');
        } finally { dispose(); }
    });

    it("forwards server stream chunks to onStreamChunk and returns the final result", async () => {
        const { channel, dispose } = makeChannel();
        try {
            const chunks: unknown[] = [];
            const out = await callCommand(channel, {
                methodRef: "test.streamer::run",
                paramsArg: JSON.stringify({ count: 3 }),
                onStreamChunk: (p) => chunks.push(p),
            });
            expect(chunks).toEqual([
                { line: "chunk 0" },
                { line: "chunk 1" },
                { line: "chunk 2" },
            ]);
            expect(JSON.parse(out)).toEqual({ done: true });
        } finally {
            dispose();
        }
    });

    it("works for non-streaming methods (no chunks emitted)", async () => {
        const { channel, dispose } = makeChannel();
        try {
            const chunks: unknown[] = [];
            const out = await callCommand(channel, {
                methodRef: "test.streamer::plain",
                paramsArg: JSON.stringify({}),
                onStreamChunk: (p) => chunks.push(p),
            });
            expect(chunks).toEqual([]);
            expect(JSON.parse(out)).toEqual({ ok: true });
        } finally {
            dispose();
        }
    });
});
