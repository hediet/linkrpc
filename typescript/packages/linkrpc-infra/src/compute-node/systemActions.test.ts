import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { describe, expect, it } from 'vitest';
import { computeNodePowerInterface, computeNodeSessionInterface } from './index';
import { ComputeNode, registerComputeNode, type SystemAction, type SystemActionCommand, systemActionCommand } from './node';

const serviceId = 'test.compute';

/** Never runs a real lock or power command: every action maps to a Node.js script. */
function fakeCommand(script: string): (action: SystemAction) => SystemActionCommand {
    return action => ({ mechanism: `fake ${action}`, command: process.execPath, args: ['-e', script] });
}

describe('system actions', () => {
    it('locks the session and performs power actions through the platform command', async () => {
        const performed: SystemAction[] = [];
        const { power, session, close } = createClient(action => {
            performed.push(action);
            return fakeCommand('process.exit(0)')(action);
        });
        try {
            expect(await session.lock({})).toMatchInlineSnapshot(`
              {
                "mechanism": "fake lock",
              }
            `);
            expect(await power.sleep({})).toEqual({ mechanism: 'fake sleep' });
            expect(await power.restart({})).toEqual({ mechanism: 'fake restart' });
            expect(await power.shutdown({})).toEqual({ mechanism: 'fake shutdown' });
            expect(performed).toEqual(['lock', 'sleep', 'restart', 'shutdown']);
        } finally {
            close();
        }
    });

    it('reports a command that fails', async () => {
        const { session, close } = createClient(fakeCommand("console.error('No session to lock'); process.exit(1)"));
        try {
            await expect(session.lock({})).rejects.toThrow('fake lock failed (exit code 1): No session to lock');
        } finally {
            close();
        }
    });

    it('reports a missing command', async () => {
        const { power, close } = createClient(() => ({ mechanism: 'systemctl suspend', command: 'linkrpc-test-missing-command', args: [] }));
        try {
            await expect(power.sleep({})).rejects.toThrow('systemctl suspend needs linkrpc-test-missing-command, which was not found.');
        } finally {
            close();
        }
    });

    it('succeeds when the command is still running after it settles', async () => {
        const { power, close } = createClient(fakeCommand('setTimeout(() => {}, 4000)'));
        try {
            expect(await power.sleep({})).toEqual({ mechanism: 'fake sleep' });
        } finally {
            close();
        }
    }, 10_000);

    it('uses each platform\'s lock, sleep, restart, and shutdown command', () => {
        const actions: SystemAction[] = ['lock', 'sleep', 'restart', 'shutdown'];
        const summarize = (platform: NodeJS.Platform) => Object.fromEntries(actions.map(action => {
            const { mechanism, command, args } = systemActionCommand(action, platform);
            return [action, `${mechanism}: ${command} ${args.join(' ')}`];
        }));
        expect(summarize('win32')).toMatchInlineSnapshot(`
          {
            "lock": "LockWorkStation: rundll32.exe user32.dll,LockWorkStation",
            "restart": "shutdown /r: shutdown.exe /r /t 0",
            "shutdown": "shutdown /s: shutdown.exe /s /t 0",
            "sleep": "SetSuspendState: powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)) { throw 'SetSuspendState failed' }",
          }
        `);
        expect(summarize('darwin')).toMatchInlineSnapshot(`
          {
            "lock": "SACLockScreenImmediate: /usr/bin/osascript -l JavaScript -e ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
          $.dlopen('/System/Library/PrivateFrameworks/login.framework/Versions/Current/login', 10);
          ObjC.bindFunction('SACLockScreenImmediate', ['int', []]);
          $.SACLockScreenImmediate();",
            "restart": "loginwindow restart: /usr/bin/osascript -e tell application "loginwindow" to «event aevtrrst»",
            "shutdown": "loginwindow shutdown: /usr/bin/osascript -e tell application "loginwindow" to «event aevtrsdn»",
            "sleep": "pmset sleepnow: /usr/bin/pmset sleepnow",
          }
        `);
        expect(summarize('linux')).toMatchInlineSnapshot(`
          {
            "lock": "loginctl lock-session: loginctl lock-session",
            "restart": "systemctl reboot: systemctl reboot",
            "shutdown": "systemctl poweroff: systemctl poweroff",
            "sleep": "systemctl suspend: systemctl suspend",
          }
        `);
        expect(() => systemActionCommand('lock', 'freebsd')).toThrow('Action lock is not supported on freebsd.');
    });
});

function createClient(systemAction: (action: SystemAction) => SystemActionCommand) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    registerComputeNode(server.service(serviceId), new ComputeNode({ systemAction }));
    return {
        power: client.service(serviceId).get(computeNodePowerInterface),
        session: client.service(serviceId).get(computeNodeSessionInterface),
        close: () => { client.close(); server.close(); },
    };
}
