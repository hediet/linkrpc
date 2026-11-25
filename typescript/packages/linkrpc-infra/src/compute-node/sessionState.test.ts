import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { describe, expect, it } from 'vitest';
import { type ComputeNodeSessionState, computeNodeSessionInterface } from './index';
import { ComputeNode, registerComputeNode, type SessionStateMonitorCommand } from './node';

const serviceId = 'test.compute';

/** Stands in for the platform helper: prints `lines` 10 ms apart, then keeps running until it is stopped. */
function fakeMonitor(lines: readonly string[]): SessionStateMonitorCommand {
    return {
        mechanism: 'fake',
        command: process.execPath,
        args: ['-e', `
            const lines = ${JSON.stringify(lines)};
            lines.forEach((line, index) => setTimeout(() => process.stdout.write(line + '\\n'), index * 10));
            setInterval(() => {}, 1000);
        `],
    };
}

describe('session state', () => {
    it('reports the first state and every change until the caller cancels', async () => {
        const { session, close } = createClient(fakeMonitor(['unlocked', 'unlocked', 'locked', 'locked', 'unlocked']));
        try {
            const states: ComputeNodeSessionState[] = [];
            const call = session.watchState({}, { onMessage: state => states.push(state) });
            await waitUntil(() => states.length === 3);
            await call.cancel();
            expect({ result: await call, states: states.map(state => state.locked) }).toMatchInlineSnapshot(`
              {
                "result": {
                  "reason": "cancelled",
                },
                "states": [
                  false,
                  true,
                  false,
                ],
              }
            `);
        } finally {
            close();
        }
    });

    it('returns the current state once', async () => {
        const { session, close } = createClient(fakeMonitor(['locked', 'unlocked']));
        try {
            expect(await session.getState({})).toMatchInlineSnapshot(`
              {
                "locked": true,
                "mechanism": "fake",
              }
            `);
        } finally {
            close();
        }
    });

    it('fails the call when the helper fails or prints something unexpected', async () => {
        const failing = createClient({
            mechanism: 'fake',
            command: process.execPath,
            args: ['-e', "console.error('WTSQuerySessionInformation failed: Access is denied.'); process.exit(1)"],
        });
        const garbled = createClient(fakeMonitor(['unlocked', 'maybe']));
        try {
            await expect(failing.session.getState({})).rejects.toThrow(
                'fake helper exited (exit code 1): WTSQuerySessionInformation failed: Access is denied.',
            );
            await expect(garbled.session.watchState({})).rejects.toThrow('fake helper printed an unexpected line: maybe');
        } finally {
            failing.close();
            garbled.close();
        }
    });

    it.runIf(process.platform === 'win32' || process.platform === 'darwin')('reads the real lock state of this session', async () => {
        const { session, close } = createClient(undefined);
        try {
            const state = await session.getState({});
            expect(typeof state.locked).toBe('boolean');
        } finally {
            close();
        }
    }, 20_000);
});

function createClient(sessionStateMonitor: SessionStateMonitorCommand | undefined) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    registerComputeNode(server.service(serviceId), new ComputeNode(sessionStateMonitor ? { sessionStateMonitor: () => sessionStateMonitor } : {}));
    return {
        session: client.service(serviceId).get(computeNodeSessionInterface),
        close: () => { client.close(); server.close(); },
    };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
