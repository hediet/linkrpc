import { describe, expect, it } from 'vitest';
import { isLoopbackReachable, parseLsof, parseProcNetTcp, parseSs, parseTasklistCsv, parseWindowsNetstat, readListeningPorts } from './listeningPorts';

describe('listening ports', () => {
    it('parses netstat, ss, lsof, and /proc/net/tcp listeners', () => {
        expect({
            netstat: parseWindowsNetstat([
                '  Proto  Local Address          Foreign Address        State           PID',
                '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1144',
                '  TCP    127.0.0.1:8123         0.0.0.0:0              ABHÖREN         4242',
                '  TCP    127.0.0.1:50000        127.0.0.1:8123         ESTABLISHED     7',
                '  TCP    [::1]:3000             [::]:0                 LISTENING       99',
                '  UDP    0.0.0.0:5353           *:*                                    1',
            ].join('\r\n')),
            tasklist: [...parseTasklistCsv('"node.exe","4242","Console","1","50,000 K"\r\n')],
            ss: parseSs('LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=31,fd=20))\nLISTEN 0 4096 [::]:22 [::]:*'),
            lsof: parseLsof('p77\ncnode\nn127.0.0.1:3000\nn*:8080\n'),
            proc: parseProcNetTcp([
                '  sl  local_address rem_address   st',
                '   0: 0100007F:0BB8 00000000:0000 0A',
                '   1: 0100007F:0BB9 0100007F:1F90 01',
            ].join('\n')),
        }).toEqual({
            netstat: [
                { address: '0.0.0.0', port: 135, pid: 1144 },
                { address: '127.0.0.1', port: 8123, pid: 4242 },
                { address: '::1', port: 3000, pid: 99 },
            ],
            tasklist: [[4242, 'node.exe']],
            ss: [
                { address: '127.0.0.1', port: 5173, pid: 31, processName: 'node' },
                { address: '::', port: 22, pid: undefined, processName: undefined },
            ],
            lsof: [
                { address: '127.0.0.1', port: 3000, pid: 77, processName: 'node' },
                { address: '0.0.0.0', port: 8080, pid: 77, processName: 'node' },
            ],
            proc: [{ address: '127.0.0.1', port: 3000 }],
        });
    });

    it('treats loopback and wildcard addresses as reachable', () => {
        expect(['127.0.0.1', '127.5.0.1', '::1', '0.0.0.0', '::', '::ffff:127.0.0.1', '192.168.1.5', 'fe80::1'].map(isLoopbackReachable))
            .toEqual([true, true, true, true, true, true, false, false]);
    });

    it('lists ports on this machine', async () => {
        const ports = await readListeningPorts();
        expect(ports.every(port => port.port > 0 && port.addresses.length > 0)).toBe(true);
    });
});
