import { describe, expect, it } from 'vitest';
import { type IMessageTransport, type JsonRpcMessage, TransportPair } from '@hediet/linkrpc';
import { connectAs, type TransportHandle } from './connectAs';

/** Wrap one end of a TransportPair as a TransportHandle with manual close control. */
function handleFor(transport: IMessageTransport): TransportHandle & { fireClose(): void } {
    const closeCbs: Array<() => void> = [];
    let disposed = false;
    return {
        transport,
        onClose: (cb) => closeCbs.push(cb),
        dispose: () => { disposed = true; transport.dispose(); },
        fireClose: () => { for (const cb of closeCbs) cb(); },
        get disposed() { return disposed; },
    } as TransportHandle & { fireClose(): void };
}

/** Collect messages that arrive on a transport. */
function sink(transport: IMessageTransport): JsonRpcMessage[] {
    const got: JsonRpcMessage[] = [];
    transport.setListener((m) => got.push(m));
    return got;
}

describe('connectAs (splice core)', () => {
    it('mints once, then splices target ⟷ hub message-for-message', async () => {
        // target side: `targetPeer` is what the "target" would send/receive.
        const targetPair = new TransportPair();
        const hubPair = new TransportPair();
        const targetHandle = handleFor(targetPair.a);
        const hubHandle = handleFor(hubPair.a);

        const targetPeer = targetPair.b; // stands in for the target process
        const hubPeer = hubPair.b;       // stands in for the hub

        let mints = 0;
        const stopControl: { fire?: () => void } = {};
        const stop = new Promise<void>((r) => { stopControl.fire = r; });

        const run = connectAs({
            mintToken: async () => { mints++; return 'tok-123'; },
            openHubTransport: async (token) => {
                expect(token).toBe('tok-123');
                return hubHandle;
            },
            openTargetTransport: async () => targetHandle,
            stop,
        });

        // Let the splice wire up.
        await new Promise((r) => setTimeout(r, 0));
        expect(mints).toBe(1);

        // target → hub
        const atHub = sink(hubPeer);
        targetPeer.send({ jsonrpc: '2.0', id: 1, method: 'foo', params: {} } as JsonRpcMessage);
        // hub → target
        const atTarget = sink(targetPeer);
        hubPeer.send({ jsonrpc: '2.0', id: 1, result: { ok: true } } as JsonRpcMessage);

        await new Promise((r) => setTimeout(r, 0));
        expect(atHub).toEqual([{ jsonrpc: '2.0', id: 1, method: 'foo', params: {} }]);
        expect(atTarget).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);

        // Stop and ensure the run resolves.
        stopControl.fire?.();
        await run;
    });

    it('tears down when the target closes', async () => {
        const targetPair = new TransportPair();
        const hubPair = new TransportPair();
        const targetHandle = handleFor(targetPair.a);
        const hubHandle = handleFor(hubPair.a);

        const run = connectAs({
            mintToken: async () => 'tok',
            openHubTransport: async () => hubHandle,
            openTargetTransport: async () => targetHandle,
        });
        await new Promise((r) => setTimeout(r, 0));

        targetHandle.fireClose();
        await run; // resolves on target close
    });

    it('disposes the target if opening the hub transport fails', async () => {
        const targetPair = new TransportPair();
        const targetHandle = handleFor(targetPair.a);

        await expect(
            connectAs({
                mintToken: async () => 'tok',
                openHubTransport: async () => { throw new Error('dial failed'); },
                openTargetTransport: async () => targetHandle,
            }),
        ).rejects.toThrow(/dial failed/);
        expect((targetHandle as unknown as { disposed: boolean }).disposed).toBe(true);
    });
});
