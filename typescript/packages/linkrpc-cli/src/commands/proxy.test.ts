import { describe, expect, it } from 'vitest';
import {
    type ChannelResult,
    JsonRpcChannel,
    type JsonValue,
    KeypairSigningIdentity,
    Principal,
    TransportPair,
} from '@hediet/linkrpc';
import { connectViaTransport } from '@hediet/linkrpc-client-internal';
import { createForwardingHandler, type OutboundForwarding } from './tunnel';

/** participant → (proxy forwarder) → hub, recording the params the hub receives. */
function makeProxy(outbound: Exclude<OutboundForwarding, 'none'>) {
    const hubPair = new TransportPair();
    const hub = connectViaTransport(hubPair.a);
    const received: JsonValue[] = [];
    JsonRpcChannel.create(hubPair.b).setRequestHandler({
        handleRequest: async (call): Promise<ChannelResult> => {
            received.push(call.params as JsonValue);
            return { result: 'ok' };
        },
        handleNotification: () => { /* unused */ },
    });

    const participantPair = new TransportPair();
    JsonRpcChannel.create(participantPair.a).setRequestHandler(createForwardingHandler(hub, outbound));
    const participant = JsonRpcChannel.create(participantPair.b).sender;
    return { hub, participant, received };
}

describe('proxy forwarding — outbound signing', () => {
    it('signs participant calls with the proxy principal', async () => {
        const { hub, participant, received } = makeProxy('signed');
        const principal = await Principal.create(await KeypairSigningIdentity.generateNew());
        hub.signing.principal = principal;

        expect(await participant.sendRequest('svc::iface::run', { a: 1 })).toBe('ok');

        const params = received[0] as {
            a: number;
            $hubrpc: { principal: string; };
            $hubrpcSignature: { call?: unknown; };
        };
        expect({
            a: params.a,
            signedByProxy: params.$hubrpc.principal === principal.id,
            hasCallSignature: params.$hubrpcSignature.call !== undefined,
        }).toMatchInlineSnapshot(`
          {
            "a": 1,
            "hasCallSignature": true,
            "signedByProxy": true,
          }
        `);
    });

    it('forwards participant calls verbatim', async () => {
        const { hub, participant, received } = makeProxy('verbatim');
        hub.signing.principal = await Principal.create(await KeypairSigningIdentity.generateNew());

        expect(await participant.sendRequest('svc::iface::run', { a: 1 })).toBe('ok');

        expect(received).toMatchInlineSnapshot(`
          [
            {
              "a": 1,
            },
          ]
        `);
    });
});
