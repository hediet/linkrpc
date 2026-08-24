import { describe, expect, it } from 'vitest';
import { defineInterface, requestType, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { z } from 'zod';
import { OverlaySplitter } from './overlaySplitter';

const pingInterface = defineInterface(
    { id: 'ping', description: 'Liveness.' },
    { ping: requestType(z.object({ n: z.number() }), z.object({ n: z.number() })) },
);

const echoInterface = defineInterface(
    { id: 'echo', description: 'Echo.' },
    { echo: requestType(z.object({ s: z.string() }), z.object({ s: z.string() })) },
);

const streamingInterface = defineInterface(
    { id: 'streamy', description: 'Server-streaming progress.' },
    {
        run: requestType(z.object({ n: z.number() }), z.object({ done: z.literal(true) }))
            .withStream({ server: z.object({ tick: z.number() }) }),
    },
);

const duplexInterface = defineInterface(
    { id: 'duplex', description: 'Duplex frame tunnel.' },
    {
        connect: requestType(z.object({}), z.object({ ok: z.literal(true) }))
            .withStream({
                client: z.object({ frame: z.number() }),
                server: z.object({ frame: z.number() }),
            }),
    },
);

/**
 * Build a splitter wired to three LinkRpcConnections — one per port — so we
 * can drive real JSON-RPC traffic across it.
 *
 * The participant connection (P) sits on the downstream side; the root (C)
 * and uplink (H) connections sit on the upstream sides.
 */
function makeRig() {
    const pPair = new TransportPair(); // P: a=splitter side, b=participant conn
    const cPair = new TransportPair(); // C: a=splitter side, b=root conn
    const hPair = new TransportPair(); // H: a=splitter side, b=uplink conn

    const splitter = new OverlaySplitter(pPair.a, cPair.a, hPair.a);

    return {
        splitter,
        participant: LinkRpcConnection.fromTransport(pPair.b),
        root: LinkRpcConnection.fromTransport(cPair.b),
        uplink: LinkRpcConnection.fromTransport(hPair.b),
    };
}

describe('OverlaySplitter', () => {
    it('routes a root-addressed participant call to the root connection (P·root → C)', async () => {
        const rig = makeRig();
        rig.root.register(pingInterface, { ping: ({ n }) => ({ n: n + 1 }) });

        const res = await rig.participant.get(pingInterface).ping({ n: 1 });
        expect(res).toEqual({ n: 2 });
    });

    it('routes a prefixed participant call out the uplink (P·* → H)', async () => {
        const rig = makeRig();
        // The uplink connection serves the prefixed service.
        rig.uplink.register(echoInterface, { echo: ({ s }) => ({ s: s + '!' }) }, { serviceId: 'svc' });

        const res = await rig.participant.service('svc').get(echoInterface).echo({ s: 'hi' });
        expect(res).toEqual({ s: 'hi!' });
    });

    it('delivers a prefixed uplink call to the participant (H·* → P)', async () => {
        const rig = makeRig();
        rig.participant.register(echoInterface, { echo: ({ s }) => ({ s: s.toUpperCase() }) }, {
            serviceId: 'svc',
        });

        const res = await rig.uplink.service('svc').get(echoInterface).echo({ s: 'ab' });
        expect(res).toEqual({ s: 'AB' });
    });

    it('disambiguates concurrent inbound calls from H and C with colliding ids', async () => {
        const rig = makeRig();
        // The participant answers the same prefixed interface for both callers;
        // the splitter's id-tagging keeps the two responses from crossing wires.
        rig.participant.register(echoInterface, {
            echo: ({ s }) => ({ s: `P:${s}` }),
        }, { serviceId: 'svc' });

        const [fromH, fromC] = await Promise.all([
            rig.uplink.service('svc').get(echoInterface).echo({ s: 'h' }),
            rig.root.service('svc').get(echoInterface).echo({ s: 'c' }),
        ]);

        expect(fromH).toEqual({ s: 'P:h' });
        expect(fromC).toEqual({ s: 'P:c' });
    });

    it('delivers a root-addressed uplink call to the participant (H·root → P)', async () => {
        const rig = makeRig();
        // The participant serves a root-form interface — its own root services,
        // which the parent hub reaches via H·root → P.
        rig.participant.register(pingInterface, { ping: ({ n }) => ({ n: n + 100 }) });

        const res = await rig.uplink.get(pingInterface).ping({ n: 1 });
        expect(res).toEqual({ n: 101 });
    });

    // `$stream::send` is interface-form, so the method-form table would misroute
    // it. These cover that it is instead routed like a response, by `requestId`.

    it('routes a participant server-stream to the uplink for an H→P request ($stream::send → H)', async () => {
        const rig = makeRig();
        rig.participant.register(streamingInterface, {
            run: ({ n }, _ctx, stream) => {
                stream.send({ tick: n });
                stream.send({ tick: n + 1 });
                return { done: true };
            },
        }, { serviceId: 'svc' });

        const ticks: number[] = [];
        const res = await rig.uplink.service('svc').get(streamingInterface).run(
            { n: 10 },
            { onMessage: ({ tick }) => ticks.push(tick) },
        );

        expect(res).toEqual({ done: true });
        expect(ticks).toEqual([10, 11]);
    });

    it('routes a participant server-stream to the root for a C→P request ($stream::send → C)', async () => {
        const rig = makeRig();
        rig.participant.register(streamingInterface, {
            run: ({ n }, _ctx, stream) => {
                stream.send({ tick: n });
                return { done: true };
            },
        }, { serviceId: 'svc' });

        const ticks: number[] = [];
        const res = await rig.root.service('svc').get(streamingInterface).run(
            { n: 7 },
            { onMessage: ({ tick }) => ticks.push(tick) },
        );

        expect(res).toEqual({ done: true });
        expect(ticks).toEqual([7]);
    });

    it('delivers an uplink server-stream to the participant for a P→H request (H·$stream::send → P)', async () => {
        const rig = makeRig();
        rig.uplink.register(streamingInterface, {
            run: ({ n }, _ctx, stream) => {
                stream.send({ tick: n * 2 });
                return { done: true };
            },
        }, { serviceId: 'svc' });

        const ticks: number[] = [];
        const res = await rig.participant.service('svc').get(streamingInterface).run(
            { n: 3 },
            { onMessage: ({ tick }) => ticks.push(tick) },
        );

        expect(res).toEqual({ done: true });
        expect(ticks).toEqual([6]);
    });

    // The participant is the *callee* of a forwarded request, so it observes the
    // request under an origin-encoded id. An inbound client→server (`toCallee`)
    // frame must be re-tagged with that encoded id to reach the participant's
    // stream listener — otherwise it is dropped (the MCP-forward bug).
    it('delivers an uplink client-stream to a participant-callee (H·$stream::send toCallee → P)', async () => {
        const rig = makeRig();
        const seen: number[] = [];
        rig.participant.register(duplexInterface, {
            connect: (_p, _ctx, stream) => {
                stream.onMessage(({ frame }) => {
                    seen.push(frame);
                    stream.send({ frame: frame * 10 });
                });
                return new Promise(() => { /* stays open */ });
            },
        }, { serviceId: 'svc' });

        const fromServer: number[] = [];
        const call = rig.uplink.service('svc').get(duplexInterface).connect(
            {},
            { onMessage: ({ frame }) => fromServer.push(frame) },
        );
        call.send({ frame: 4 });

        await _until(() => fromServer.length > 0, 1000);
        expect(seen).toEqual([4]);
        expect(fromServer).toEqual([40]);
        call.cancel('done');
    });

    it('delivers a root client-stream to a participant-callee (C·$stream::send toCallee → P)', async () => {
        const rig = makeRig();
        const seen: number[] = [];
        rig.participant.register(duplexInterface, {
            connect: (_p, _ctx, stream) => {
                stream.onMessage(({ frame }) => {
                    seen.push(frame);
                    stream.send({ frame: frame + 1 });
                });
                return new Promise(() => { /* stays open */ });
            },
        }, { serviceId: 'svc' });

        const fromServer: number[] = [];
        const call = rig.root.service('svc').get(duplexInterface).connect(
            {},
            { onMessage: ({ frame }) => fromServer.push(frame) },
        );
        call.send({ frame: 7 });

        await _until(() => fromServer.length > 0, 1000);
        expect(seen).toEqual([7]);
        expect(fromServer).toEqual([8]);
        call.cancel('done');
    });

    // Previously the splitter could not tell a participant-initiated `P→C`
    // client-stream from a `P→H` one (P's id is untagged) and defaulted to H.
    // The `_pInitiated` map records the resolved target so the frame reaches C.
    it('routes a participant-initiated client-stream to the root (P→C toCallee, stateful)', async () => {
        const rig = makeRig();
        const seen: number[] = [];
        // The ROOT serves the duplex interface at root form; the participant
        // initiates the call (P→C) and streams a client frame into it.
        rig.root.register(duplexInterface, {
            connect: (_p, _ctx, stream) => {
                stream.onMessage(({ frame }) => {
                    seen.push(frame);
                    stream.send({ frame: frame + 1 });
                });
                return new Promise(() => { /* stays open */ });
            },
        });

        const fromServer: number[] = [];
        const call = rig.participant.get(duplexInterface).connect(
            {},
            { onMessage: ({ frame }) => fromServer.push(frame) },
        );
        call.send({ frame: 5 });

        await _until(() => fromServer.length > 0, 1000);
        expect(seen).toEqual([5]);
        expect(fromServer).toEqual([6]);
        call.cancel('done');
    });
});

async function _until(cond: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}
