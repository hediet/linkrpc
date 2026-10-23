import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { describe, expect, it } from 'vitest';
import { type ComputeNodeKeepAwakeEvent, computeNodePowerInterface } from './index';
import { ComputeNode, registerComputeNode, type SleepInhibitorCommand, sleepInhibitorCommand } from './node';

const serviceId = 'test.compute';

/** Stands in for `caffeinate` & co.: holds nothing, but follows the same `ready`/stdin protocol. */
const fakeInhibitor: SleepInhibitorCommand = {
    mechanism: 'fake',
    command: process.execPath,
    args: ['-e', "console.log('ready'); process.stdin.resume().on('end', () => process.exit())"],
};

describe('keep awake', () => {
    it('holds a lease until the caller cancels the call', async () => {
        const { power, close } = createClient(() => fakeInhibitor);
        try {
            const events: ComputeNodeKeepAwakeEvent[] = [];
            const call = power.keepAwake({ displayOn: true, reason: 'remote agent session' }, { onMessage: event => events.push(event) });
            await waitUntil(() => events.length === 1);
            expect(events).toMatchObject([{ type: 'active', mechanism: 'fake' }]);
            const { helperPid } = events[0]!;
            expect(isRunning(helperPid)).toBe(true);

            await call.cancel('done');
            expect(await call).toMatchInlineSnapshot(`
              {
                "reason": "cancelled",
              }
            `);
            expect(isRunning(helperPid)).toBe(false);
        } finally {
            close();
        }
    });

    it('releases the lease after maxDurationMs', async () => {
        const { power, close } = createClient(() => fakeInhibitor);
        try {
            const events: ComputeNodeKeepAwakeEvent[] = [];
            const result = await power.keepAwake({ maxDurationMs: 50 }, { onMessage: event => events.push(event) });
            expect(result).toMatchInlineSnapshot(`
              {
                "reason": "expired",
              }
            `);
            expect(isRunning(events[0]!.helperPid)).toBe(false);
        } finally {
            close();
        }
    });

    it('gives every caller its own lease', async () => {
        const { power, close } = createClient(() => fakeInhibitor);
        try {
            const first: ComputeNodeKeepAwakeEvent[] = [];
            const second: ComputeNodeKeepAwakeEvent[] = [];
            const firstCall = power.keepAwake({}, { onMessage: event => first.push(event) });
            const secondCall = power.keepAwake({}, { onMessage: event => second.push(event) });
            await waitUntil(() => first.length === 1 && second.length === 1);
            expect(first[0]!.helperPid).not.toBe(second[0]!.helperPid);

            await firstCall.cancel();
            await firstCall;
            expect({ first: isRunning(first[0]!.helperPid), second: isRunning(second[0]!.helperPid) })
                .toEqual({ first: false, second: true });

            await secondCall.cancel();
            await secondCall;
            expect(isRunning(second[0]!.helperPid)).toBe(false);
        } finally {
            close();
        }
    });

    it('fails the call when the platform refuses to hold the request', async () => {
        const { power, close } = createClient(() => ({
            mechanism: 'fake',
            command: process.execPath,
            args: ['-e', "console.error('Failed to inhibit: Access denied'); process.exit(1)"],
        }));
        try {
            await expect(power.keepAwake({})).rejects.toThrow(
                'fake helper exited before holding the sleep-prevention request (exit code 1): Failed to inhibit: Access denied',
            );
        } finally {
            close();
        }
    });

    it('fails the call when the platform helper is not installed', async () => {
        const { power, close } = createClient(() => ({ mechanism: 'systemd-inhibit', command: 'linkrpc-test-missing-inhibitor', args: [] }));
        try {
            await expect(power.keepAwake({})).rejects.toThrow(
                'Keeping the machine awake needs linkrpc-test-missing-inhibitor, which was not found.',
            );
        } finally {
            close();
        }
    });

    it('uses caffeinate on macOS, SetThreadExecutionState on Windows, and systemd-inhibit on Linux', () => {
        const options = { displayOn: true, reason: 'remote agent session' };
        expect(sleepInhibitorCommand(options, 'darwin')).toMatchInlineSnapshot(`
          {
            "args": [
              "-di",
              "/bin/sh",
              "-c",
              "echo ready; exec cat >/dev/null",
            ],
            "command": "caffeinate",
            "mechanism": "caffeinate",
          }
        `);
        expect(sleepInhibitorCommand({ ...options, displayOn: false }, 'darwin').args[0]).toBe('-i');

        expect(sleepInhibitorCommand(options, 'linux')).toMatchInlineSnapshot(`
          {
            "args": [
              "--what=idle:sleep",
              "--who=LinkRPC compute node",
              "--why=remote agent session",
              "--mode=block",
              "/bin/sh",
              "-c",
              "echo ready; exec cat >/dev/null",
            ],
            "command": "systemd-inhibit",
            "mechanism": "systemd-inhibit",
          }
        `);

        const windows = sleepInhibitorCommand(options, 'win32');
        expect({ ...windows, args: windows.args.slice(0, -1) }).toMatchInlineSnapshot(`
          {
            "args": [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-EncodedCommand",
            ],
            "command": "powershell.exe",
            "mechanism": "SetThreadExecutionState",
          }
        `);
        expect(Buffer.from(windows.args.at(-1)!, 'base64').toString('utf16le')).toMatchInlineSnapshot(`
          "$ErrorActionPreference = 'Stop'
          Add-Type -Namespace LinkRpc -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
          if ([LinkRpc.Power]::SetThreadExecutionState([uint32]2147483651) -eq 0) { throw 'SetThreadExecutionState failed' }
          [Console]::Out.WriteLine('ready')
          [void][Console]::In.ReadToEnd()"
        `);

        expect(() => sleepInhibitorCommand(options, 'freebsd')).toThrow('Keeping the machine awake is not supported on freebsd.');
    });
});

function createClient(sleepInhibitor: () => SleepInhibitorCommand) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    registerComputeNode(server.service(serviceId), new ComputeNode({ sleepInhibitor }));
    return {
        power: client.service(serviceId).get(computeNodePowerInterface),
        close: () => { client.close(); server.close(); },
    };
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
