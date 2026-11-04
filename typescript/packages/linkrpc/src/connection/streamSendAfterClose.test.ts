import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TransportPair } from '../transport/messageTransport';
import { defineInterface } from './interfaceDefinition';
import { requestType } from '../schema/memberTypes';
import { JsonRpcChannel } from './jsonRpcChannel';
import { LinkRpcConnection } from './linkRpcConnection';
import type { IncomingStream, RawStreamingCall } from './channel';

// Stream messages are often sent fire-and-forget (e.g. forwarding log entries to a watcher).
// Once the connection closes, such a send fails; unobserved, that failure must not become an
// unhandled rejection, which terminates a Node process by default.

let unhandled: unknown[];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
});
afterEach(() => { process.off('unhandledRejection', onUnhandled); });

/** Lets rejections that nobody observes be reported. */
async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('stream sends after the connection closed', () => {
    it('channel: unobserved sends and cancels do not reject unhandled; awaited ones still fail', async () => {
        const pair = new TransportPair();
        const server = JsonRpcChannel.createWithClose(pair.a);
        const client = JsonRpcChannel.createWithClose(pair.b);
        let incoming: IncomingStream | undefined;
        server.channel.setRequestHandler({
            handleRequest: (call) => {
                incoming = call.stream;
                return new Promise(() => { });
            },
            handleNotification: () => { },
        });
        const call: RawStreamingCall = client.channel.sender.sendRequestWithStream('watch', {});
        call.result.catch(() => { });
        await settle();
        expect(incoming).toBeDefined();

        server.close();
        client.close();
        void incoming!.send('late');
        void call.send('late');
        void call.cancel('late');
        await settle();

        expect(unhandled).toEqual([]);
        await expect(incoming!.send('late')).rejects.toThrow('Connection closed');
        await expect(Promise.resolve(call.send('late'))).rejects.toThrow('Connection closed');
    });

    it('typed: unobserved server and client stream sends do not reject unhandled', async () => {
        const watcher = defineInterface({ id: 'test.watcher' }, {
            watch: requestType(z.object({}), z.string()).withStream({ server: z.string(), client: z.string() }),
        });
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        let send: ((value: string) => Promise<void>) | undefined;
        server.register(watcher, {
            watch: (_params, _ctx, stream) => {
                send = (value) => stream.send(value);
                return new Promise(() => { });
            },
        });
        const call = client.get(watcher).watch({}, { onMessage: () => { } });
        call.catch(() => { });
        await settle();
        expect(send).toBeDefined();

        server.close();
        client.close();
        void send!('late');
        void call.send('late');
        void call.cancel('late');
        await settle();

        expect(unhandled).toEqual([]);
        await expect(send!('late')).rejects.toThrow('Connection closed');
        await expect(call.send('late')).rejects.toThrow('Connection closed');
    });
});
