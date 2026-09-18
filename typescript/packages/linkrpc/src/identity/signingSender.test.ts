import { describe, expect, it } from 'vitest';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import { ErrorCode } from '../protocol/jsonRpc';
import { TransportPair } from '../transport/messageTransport';
import { SigningSender } from './signingSender';

describe('SigningSender', () => {
    it('rejects a stream when the channel closes before asynchronous preparation finishes', async () => {
        const pair = new TransportPair();
        const sender = new SigningSender(JsonRpcChannel.create(pair.a).sender, {});
        const call = sender.sendRequestWithStream('test::read', {});
        sender.close();
        await expect(call.result).rejects.toMatchObject({
            code: ErrorCode.peerDisconnected,
            message: 'Connection closed',
        });
    });
});
