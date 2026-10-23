import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LinkRpcConnection, type JsonValue } from '@hediet/linkrpc';
import { startEndpoint } from '@hediet/linkrpc/node';
import { JsonRpcTransportPair, registerJsonRpcConnectionService } from '@hediet/linkrpc-infra/json-rpc';
import { expect, it } from 'vitest';

it('exports two routes through the built CLI and shuts down gracefully', { timeout: 20_000 }, async () => {
    const peers: JsonRpcTransportPair[] = [];
    const host = await startEndpoint({
        endpoint: 'listen:ws://127.0.0.1:0',
        token: 'upstream-token',
        onConnection: connection => {
            const rpc = new LinkRpcConnection(connection.channel);
            for (const serviceId of ['foo', 'bar']) {
                const registration = registerJsonRpcConnectionService({
                    connection: rpc,
                    serviceId,
                    openTransport: async () => {
                        const pair = new JsonRpcTransportPair();
                        peers.push(pair);
                        pair.b.onMessage(frame => { void pair.b.send(frame); });
                        return pair.a;
                    },
                });
                void connection.closed.then(() => registration.dispose());
            }
        },
    });
    const cli = fileURLToPath(new URL('../dist/linkrpc.js', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [
        '-e',
        // IPC triggers the CLI's real signal handler, also on Windows where kill(SIGTERM) is forceful.
        `process.on('message', () => { process.disconnect(); process.emit('SIGTERM'); }); process.argv.splice(1, 0, ${JSON.stringify(cli)}); import(${JSON.stringify(new URL('../dist/linkrpc.js', import.meta.url).href)});`,
        'hub', '--context', ':empty', '--no-use-env', '--no-sign',
        '--endpoint', `${host.endpoint}?token=upstream-token`,
        'json-rpc-export', '--target-endpoint', 'listen:ws://127.0.0.1:0',
        '--target-token', 'export-token',
        '--target-token-query-param', 'connectionToken', '--target-token-query-param', 'api_key',
        '--serviceId', 'foo', '--path', 'foo',
        '--serviceId', 'bar', '--path', '/bar',
    ], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    let stdout = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.stdout!.on('data', chunk => { stdout += chunk; });
    const exited = once(child, 'exit');
    const sockets: WebSocket[] = [];
    try {
        await expect.poll(() => {
            if (child.exitCode !== null) throw new Error(stderr);
            return /listening at (ws:\/\/\S+)/.exec(stderr)?.[1];
        }, { timeout: 10_000 }).toBeTruthy();
        const endpoint = /listening at (ws:\/\/\S+)/.exec(stderr)![1];
        const frames: JsonValue[] = [
            { jsonrpc: '2.0', id: 1, method: 'initialize' },
            { jsonrpc: '2.0', method: 'notification' },
        ];
        const responses = await Promise.all(['foo', 'bar'].map(async (path, index) => {
            const socket = new WebSocket(`${endpoint}${path}?${index === 0 ? 'connectionToken' : 'api_key'}=export-token`);
            sockets.push(socket);
            await new Promise<void>((resolve, reject) => {
                socket.addEventListener('open', () => resolve(), { once: true });
                socket.addEventListener('error', reject, { once: true });
            });
            const response = new Promise<JsonValue>(resolve => {
                socket.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true });
            });
            socket.send(JSON.stringify(frames[index]));
            return response;
        }));
        expect(responses).toEqual(frames);
        child.send('shutdown');
        expect(await exited).toEqual([0, null]);
        await expect.poll(() => peers.every(peer => peer.b.closed)).toBe(true);
        expect({ stdout, leakedToken: /upstream-token|export-token/.test(stderr) }).toEqual({
            stdout: '', leakedToken: false,
        });
    } finally {
        for (const socket of sockets) socket.close();
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await exited;
        }
        host.dispose();
        await host.closed;
    }
});
