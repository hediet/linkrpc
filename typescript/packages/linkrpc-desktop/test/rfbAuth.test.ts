import * as net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { desEncryptBlock } from '../src/des';
import { PreauthenticatedRfbStream, vncAuthResponse } from '../src/rfbAuth';

const hex = (value: string) => Buffer.from(value, 'hex');

describe('desEncryptBlock', () => {
    // Expected values come from OpenSSL's des-ecb (node --openssl-legacy-provider).
    it('matches OpenSSL', () => {
        expect([
            desEncryptBlock(hex('133457799bbcdff1'), hex('0123456789abcdef')).toString('hex'),
            desEncryptBlock(hex('0e329232ea6d0d73'), hex('8787878787878787')).toString('hex'),
            desEncryptBlock(hex('a1b2c3d4e5f60718'), hex('fedcba9876543210')).toString('hex'),
        ]).toMatchInlineSnapshot(`
          [
            "85e813540f0ab405",
            "0000000000000000",
            "c24524ab1f375afd",
          ]
        `);
    });

    it('computes the VNC authentication response like OpenSSL', () => {
        const challenge = Buffer.from([...Array(16).keys()]);
        expect(vncAuthResponse('s3cret!x', challenge).toString('hex')).toMatchInlineSnapshot(`"83b69a37a6de8a0904dca894779deebe"`);
    });
});

describe('PreauthenticatedRfbStream', () => {
    const servers: net.Server[] = [];
    afterEach(() => { for (const server of servers.splice(0)) server.close(); });

    /** A VNC server that requires VNC authentication with a fixed challenge, then echoes ClientInit as "init:<byte>". */
    async function startVncServer(password: string): Promise<number> {
        const server = net.createServer(async socket => {
            const reader = byteReader(socket);
            socket.write('RFB 003.889\n');
            await reader(12);
            socket.write(Buffer.from([1, 2]));
            await reader(1);
            const challenge = Buffer.from([...Array(16).keys()]);
            socket.write(challenge);
            const ok = (await reader(16)).equals(vncAuthResponse(password, challenge));
            if (!ok) {
                const reason = Buffer.from('Authentication failure');
                const header = Buffer.alloc(8);
                header.writeUInt32BE(1, 0);
                header.writeUInt32BE(reason.length, 4);
                socket.end(Buffer.concat([header, reason]));
                return;
            }
            socket.write(Buffer.alloc(4));
            socket.write(`init:${(await reader(1))[0]}`);
        });
        servers.push(server);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return (server.address() as net.AddressInfo).port;
    }

    it('authenticates to the source and presents an unauthenticated RFB 3.8 handshake', async () => {
        const port = await startVncServer('s3cret!x');
        const stream = new PreauthenticatedRfbStream(net.connect(port, '127.0.0.1'), 's3cret!x');
        const read = byteReader(stream);
        const version = (await read(12)).toString();
        stream.write('RFB 003.008\n');
        const securityTypes = [...await read(2)];
        stream.write(Buffer.from([1]));
        const securityResult = [...await read(4)];
        stream.write(Buffer.from([1]));
        const serverInit = (await read(6)).toString();
        stream.destroy();
        expect({ version, securityTypes, securityResult, serverInit }).toMatchInlineSnapshot(`
          {
            "securityResult": [
              0,
              0,
              0,
              0,
            ],
            "securityTypes": [
              1,
              1,
            ],
            "serverInit": "init:1",
            "version": "RFB 003.008
          ",
          }
        `);
    });

    it('fails with the server reason when the password is wrong', async () => {
        const port = await startVncServer('s3cret!x');
        const stream = new PreauthenticatedRfbStream(net.connect(port, '127.0.0.1'), 'wrong');
        const [error] = await once(stream, 'error');
        expect((error as Error).message).toMatchInlineSnapshot(`"VNC authentication failed: Authentication failure"`);
    });
});

function byteReader(stream: NodeJS.ReadableStream): (length: number) => Promise<Buffer> {
    let buffered = Buffer.alloc(0);
    let waiter: { length: number; resolve: (bytes: Buffer) => void } | undefined;
    const serve = () => {
        if (!waiter || buffered.length < waiter.length) return;
        const { length, resolve } = waiter;
        waiter = undefined;
        const bytes = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        resolve(bytes);
    };
    stream.on('data', (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); serve(); });
    return length => new Promise(resolve => { waiter = { length, resolve }; serve(); });
}
