import { describe, expect, it } from 'vitest';
import {
    ErrorCode,
    type IncomingCall,
    JsonRpcChannel,
    type JsonValue,
    type Result,
    TransportPair,
} from '@hediet/linkrpc';
import { connectViaTransport } from '@hediet/linkrpc-client';
import { createForwardingHandler } from './tunnel';

const METHOD = 'svc::progress::run';

/**
 * Wire the tunnel's forwarding handler between two in-memory channels and return
 * the caller-side sender plus the target service's observed state. Mirrors the
 * real topology: caller → local (tunnel handler) → remote → service, streams back.
 */
function makeTunnel(service: {
    onInput?: (payload: JsonValue) => void;
    onCancel?: () => void;
    /** Emit these `toCaller` progress payloads before settling. */
    progress?: JsonValue[];
    /** Resolve the request when this input arrives (else on cancel). */
    settleOnInput?: (payload: JsonValue) => boolean;
}) {
    // remote (target service) side: connectViaTransport is the real CliConnection
    // the tunnel forwards onto; the far end is the streaming service.
    const remotePair = new TransportPair();
    const remote = connectViaTransport(remotePair.a);
    const serviceChannel = JsonRpcChannel.create(remotePair.b);
    serviceChannel.setRequestHandler({
        handleRequest: async (call: IncomingCall): Promise<Result> => {
            for (const p of service.progress ?? []) await call.stream.send(p);
            return await new Promise<Result>((resolve) => {
                call.stream.onMessage((payload) => {
                    service.onInput?.(payload);
                    if (service.settleOnInput?.(payload)) resolve({ result: { ok: true } });
                });
                call.signal.addEventListener('abort', () => {
                    service.onCancel?.();
                    resolve({ error: { code: ErrorCode.cancelled, message: 'cancelled' } });
                }, { once: true });
            });
        },
        handleNotification: () => { /* unused */ },
    });

    // local (source hub) side: install the tunnel forwarder; the far end is the
    // caller (as if the source hub forwarded a caller's request here).
    const localPair = new TransportPair();
    const localNear = JsonRpcChannel.create(localPair.a);
    localNear.setRequestHandler(createForwardingHandler(remote));
    const caller = JsonRpcChannel.create(localPair.b).sender;

    return { caller, remote };
}

describe('tunnel forwarding — streaming', () => {
    it('relays callee→caller progress and caller→callee input through the tunnel', async () => {
        const inputs: JsonValue[] = [];
        const { caller } = makeTunnel({
            progress: [{ progress: 1 }, { progress: 2 }],
            onInput: (p) => inputs.push(p),
            settleOnInput: (p) => (p as { done?: boolean }).done === true,
        });

        const progress: JsonValue[] = [];
        const rc = caller.sendRequestWithStream(METHOD, { n: 2 }, {
            onStreamMessage: (p) => progress.push(p),
        });

        // Progress flows callee → caller through the tunnel.
        await vi_waitFor(() => progress.length === 2);
        expect(progress).toEqual([{ progress: 1 }, { progress: 2 }]);

        // Input flows caller → callee through the tunnel.
        rc.send({ input: 'hello' });
        rc.send({ done: true });

        const result = await rc.result;
        expect(result).toEqual({ ok: true });
        expect(inputs).toContainEqual({ input: 'hello' });
        expect(inputs).toContainEqual({ done: true });
    });

    it('propagates caller cancellation to the callee', async () => {
        let cancelled = false;
        const { caller } = makeTunnel({
            progress: [{ progress: 1 }],
            onCancel: () => { cancelled = true; },
        });

        const progress: JsonValue[] = [];
        const rc = caller.sendRequestWithStream(METHOD, {}, { onStreamMessage: (p) => progress.push(p) });
        // Wait until the request is established at the service (first progress
        // has flowed all the way back), so the cancel has something to cancel.
        await vi_waitFor(() => progress.length >= 1);

        rc.cancel('user aborted');

        await expect(rc.result).rejects.toThrow();
        expect(cancelled).toBe(true);
    });
});

/** Minimal poll helper (avoids pulling in fake timers). */
async function vi_waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (pred()) return;
        if (Date.now() >= deadline) return;
        await new Promise((r) => setTimeout(r, 5));
    }
}
