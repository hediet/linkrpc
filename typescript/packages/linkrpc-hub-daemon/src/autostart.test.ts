import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutostartManager } from './autostart/autostart';
import type { DaemonLaunch, Exec } from './autostart/launch';
import { launchdPlist } from './autostart/launchd';
import { systemdUnit, xdgDesktopEntry } from './autostart/linux';
import { quoteWindowsArg, WindowsRunKeyAutostart } from './autostart/windows';
import { HubHome } from './paths';

const posixLaunch: DaemonLaunch = {
    foreground: { executable: '/opt/My App/node', args: ['/opt/hub/cli.js', 'run', '--quiet'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    keepAlive: { executable: '/opt/My App/node', args: ['/opt/hub/cli.js', 'run', '--quiet', '--keep-alive'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    windowless: false,
};

const windowsLaunch: DaemonLaunch = {
    foreground: { executable: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\hub\\cli.js', 'run'], env: {} },
    keepAlive: { executable: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\hub\\cli.js', 'run', '--keep-alive'], env: {} },
    windowless: false,
};

function recordingExec(results: Record<string, { code: number; stdout?: string; }> = {}): { exec: Exec; calls: string[]; } {
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
        const call = [path.basename(file), ...args].join(' ');
        calls.push(call);
        const match = Object.entries(results).find(([prefix]) => call.startsWith(prefix))?.[1];
        return { code: match?.code ?? 0, stdout: match?.stdout ?? '', stderr: '' };
    };
    return { exec, calls };
}

describe('autostart', () => {
    const tempDirs: string[] = [];
    afterEach(() => {
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('quotes Windows arguments for CommandLineToArgvW', () => {
        expect([
            quoteWindowsArg('plain'),
            quoteWindowsArg('with space'),
            quoteWindowsArg('C:\\dir with space\\'),
            quoteWindowsArg('say "hi"'),
            quoteWindowsArg(''),
        ]).toMatchInlineSnapshot(`
          [
            "plain",
            ""with space"",
            ""C:\\dir with space\\\\"",
            ""say \\"hi\\""",
            """",
          ]
        `);
    });

    it('registers a windowless keep-alive command in the Run key', async () => {
        const { exec, calls } = recordingExec();
        const manager = new WindowsRunKeyAutostart('linkrpc-hub', exec, 'C:\\Windows');
        expect(manager.commandLine(windowsLaunch)).toMatchInlineSnapshot(
            `"C:\\Windows\\System32\\conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" C:\\hub\\cli.js run --keep-alive"`,
        );
        expect(manager.commandLine({ ...windowsLaunch, windowless: true })).not.toContain('conhost');
        await manager.enable(windowsLaunch);
        expect(calls.map(call => call.split(' /d ')[0])).toMatchInlineSnapshot(`
          [
            "reg.exe add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v linkrpc-hub /t REG_SZ",
            "reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run /v linkrpc-hub /f",
          ]
        `);
        expect(() => manager.commandLine(posixLaunch)).toThrow(/environment/);
    });

    it('treats entries disabled in Task Manager as disabled', async () => {
        const approved = 'reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
        const state = async (flags: string | undefined) => new WindowsRunKeyAutostart('linkrpc-hub', recordingExec({
            [approved]: flags === undefined ? { code: 1 } : { code: 0, stdout: `    linkrpc-hub    REG_BINARY    ${flags}0000000000000000000000` },
        }).exec).isEnabled();
        expect({ noApproval: await state(undefined), enabled: await state('02'), disabled: await state('03') })
            .toMatchInlineSnapshot(`
              {
                "disabled": false,
                "enabled": true,
                "noApproval": true,
              }
            `);
    });

    it('writes a launchd agent that is not restarted after an intentional stop', () => {
        expect(launchdPlist('dev.hediet.linkrpc-hub', posixLaunch)).toMatchInlineSnapshot(`
          "<?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
          <plist version="1.0">
          <dict>
              <key>Label</key>
              <string>dev.hediet.linkrpc-hub</string>
              <key>ProgramArguments</key>
              <array>
                  <string>/opt/My App/node</string>
                  <string>/opt/hub/cli.js</string>
                  <string>run</string>
                  <string>--quiet</string>
              </array>
              <key>EnvironmentVariables</key>
              <dict>
                  <key>ELECTRON_RUN_AS_NODE</key>
                  <string>1</string>
              </dict>
              <key>RunAtLoad</key>
              <true/>
              <key>KeepAlive</key>
              <dict>
                  <key>SuccessfulExit</key>
                  <false/>
              </dict>
              <key>ProcessType</key>
              <string>Background</string>
          </dict>
          </plist>
          "
        `);
    });

    it('writes a systemd user unit and an XDG autostart entry', () => {
        expect(systemdUnit(posixLaunch)).toMatchInlineSnapshot(`
          "[Unit]
          Description=LinkRPC user hub

          [Service]
          Type=simple
          ExecStart="/opt/My App/node" "/opt/hub/cli.js" "run" "--quiet"
          Environment="ELECTRON_RUN_AS_NODE=1"
          Restart=on-failure
          RestartSec=2

          [Install]
          WantedBy=default.target
          "
        `);
        expect(xdgDesktopEntry('LinkRPC Hub', posixLaunch.keepAlive)).toMatchInlineSnapshot(`
          "[Desktop Entry]
          Type=Application
          Name=LinkRPC Hub
          Exec=env ELECTRON_RUN_AS_NODE=1 "/opt/My App/node" /opt/hub/cli.js run --quiet --keep-alive
          Terminal=false
          NoDisplay=true
          X-GNOME-Autostart-enabled=true
          "
        `);
    });

    it('picks systemd when a user instance exists and XDG autostart otherwise', async () => {
        const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-autostart-'));
        tempDirs.push(homedir);
        const home = HubHome.resolve({}, 'linux', homedir);
        const options = { home, platform: 'linux' as const, homedir, env: {} };
        const systemd = await createAutostartManager({ ...options, exec: recordingExec().exec });
        const xdg = await createAutostartManager({ ...options, exec: recordingExec({ 'systemctl --user show-environment': { code: 1 } }).exec });
        expect([systemd.description, xdg.description]).toEqual(['systemd user service', 'XDG autostart']);

        await xdg.enable(posixLaunch);
        expect(fs.readdirSync(path.join(homedir, '.config', 'autostart'))).toEqual(['linkrpc-hub.desktop']);
        expect(await xdg.isEnabled()).toBe(true);
        await xdg.disable();
        expect(await xdg.isEnabled()).toBe(false);
    });

    it('names registrations of custom homes separately', () => {
        expect(HubHome.resolve({}, 'win32', 'C:\\Users\\me').instanceName).toBe('linkrpc-hub');
        expect(HubHome.at('/tmp/other', 'linux').instanceName).toMatch(/^linkrpc-hub-[0-9a-f]{8}$/);
    });

    it('uses fixed per-user application endpoints', () => {
        expect(HubHome.resolve({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', '/home/me').defaultAppEndpoint)
            .toBe('/run/user/1000/linkrpc-hub/hub.sock');
        expect(HubHome.resolve({}, 'win32', 'C:\\Users\\me').defaultAppEndpoint)
            .toMatch(/^\\\\\.\\pipe\\linkrpc-hub-[A-Za-z0-9._-]+$/);
    });
});
