import { describe, expect, it } from 'vitest';
import { formatArgv, parseLsofCwds, parsePsCommands, parseWindowsProcessDetails, readProcessDetails } from './processDetails';

describe('process details', () => {
    it('parses the Windows helper, ps, and lsof output and quotes argv', () => {
        expect({
            windowsArray: [...parseWindowsProcessDetails('[{"pid":7,"commandLine":"node.exe server.js","cwd":"D:\\\\dev\\\\app\\\\"},{"pid":8,"commandLine":"","cwd":"C:\\\\"}]')],
            windowsSingle: [...parseWindowsProcessDetails('{"pid":9,"commandLine":"x.exe","cwd":null}')],
            windowsEmpty: [...parseWindowsProcessDetails('')],
            ps: [...parsePsCommands('  31 node /srv/app/server.js --port 3000\n 77 /usr/bin/python3 -m http.server\n')],
            lsof: [...parseLsofCwds('p31\nfcwd\nn/srv/app\np77\nfcwd\nn/home/me\n')],
            argv: formatArgv(['node', '/srv/my app/server.js', "--name=it's", '--port=3000']),
        }).toEqual({
            windowsArray: [[7, { commandLine: 'node.exe server.js', cwd: 'D:\\dev\\app' }], [8, { cwd: 'C:\\' }]],
            windowsSingle: [[9, { commandLine: 'x.exe' }]],
            windowsEmpty: [],
            ps: [[31, { commandLine: 'node /srv/app/server.js --port 3000' }], [77, { commandLine: '/usr/bin/python3 -m http.server' }]],
            lsof: [[31, { cwd: '/srv/app' }], [77, { cwd: '/home/me' }]],
            argv: `node '/srv/my app/server.js' '--name=it'\\''s' --port=3000`,
        });
    });

    it('reads this process and skips processes that do not exist', async () => {
        const details = await readProcessDetails([process.pid, 2_147_483_000]);
        const own = details.get(process.pid);
        expect({
            pids: [...details.keys()],
            hasCommandLine: (own?.commandLine?.length ?? 0) > 0,
            cwd: own?.cwd?.toLowerCase().replace(/[\\/]+$/, ''),
        }).toEqual({
            pids: [process.pid],
            hasCommandLine: true,
            cwd: process.cwd().toLowerCase().replace(/[\\/]+$/, ''),
        });
    }, 30_000);
});
