import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { formatEndpointUri } from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import {
    connectNdjson, LinkRpcConnection, startEndpoint, type EndpointConnection, type StartedEndpoint,
} from '@hediet/linkrpc/node';

const executable = fileURLToPath(new URL(
    `../../../../../rust/target/debug/examples/endpoint_interop${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
));
const childScript = fileURLToPath(new URL('./fixtures/endpointChild.mjs', import.meta.url));
const add = 'dev.linkrpc.calculator::add';
const kinds = ['websocket', 'socket'] as const;

const children: ChildProcess[] = [];
const endpoints: StartedEndpoint[] = [];

afterEach(async () => {
    for (const endpoint of endpoints.splice(0)) {
        endpoint.dispose();
        await endpoint.closed;
    }
    for (const child of children.splice(0)) {
        if (child.exitCode === null) child.kill();
    }
});

function listenUri(kind: typeof kinds[number]): string {
    if (kind === 'websocket') return 'listen:ws://127.0.0.1:0';
    return process.platform === 'win32'
        ? `listen:npipe://./pipe/linkrpc-interop-${randomUUID()}`
        : `listen:unix:${path.join(os.tmpdir(), `linkrpc-interop-${randomUUID()}.sock`)}`;
}

/** Run the Rust fixture with a clean LinkRPC environment plus `env`. */
function rust(args: string[], env: Record<string, string>): ChildProcess {
    const child = spawn(executable, args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, LINKRPC_ENDPOINT: '', LINKRPC_TOKEN: '', ...env },
    });
    children.push(child);
    return child;
}

async function firstLine(child: ChildProcess): Promise<string> {
    const lines = readline.createInterface({ input: child.stdout! });
    const [line] = await once(lines, 'line') as [string];
    lines.close();
    return line;
}

/** Serve the hub's granted namespace `interop` to the participant on `peer`. */
function grant(peer: EndpointConnection, claims: unknown[]): void {
    new LinkRpcConnection(peer.channel).register(hubGrantedServiceIdInterface, {
        get: () => ({ grantedServiceIdNamespace: 'interop' }),
        getHubServiceId: () => ({ hubServiceId: 'hub' }),
        register: params => {
            claims.push(params);
            return {};
        },
    });
}

// Opt-in because the ordinary TypeScript suite does not require a Rust toolchain;
// `cargo test --workspace` builds the fixture.
describe.runIf(process.env.LINKRPC_ENDPOINT_INTEROP === '1')('Rust/TypeScript endpoints', () => {
    it.each(kinds)('TS dials a Rust %s listener that claims the granted namespace', async kind => {
        const child = rust(['all'], { LINKRPC_ENDPOINT: listenUri(kind), LINKRPC_TOKEN: 'secret' });
        const endpoint = await firstLine(child);
        expect(endpoint).not.toContain('secret');
        await expect(startEndpoint({ endpoint, token: 'wrong', onConnection: () => {} }))
            .rejects.toThrow(/unauthenticated/);

        const claims: unknown[] = [];
        let peer!: EndpointConnection;
        endpoints.push(await startEndpoint({
            endpoint, token: 'secret',
            onConnection: connection => {
                peer = connection;
                grant(connection, claims);
            },
        }));
        expect({
            root: await peer.channel.sender.sendRequest(add, { a: 2, b: 40 }),
            named: await peer.channel.sender.sendRequest(`interop::${add}`, { a: 1, b: 1 }),
            claims,
        }).toEqual({ root: 42, named: 2, claims: [{ serviceId: 'interop' }] });
    });

    it.each(kinds)('a Rust participant dials a TS %s listener and serves only its granted namespace', async kind => {
        const claims: unknown[] = [];
        let resolvePeer!: (peer: EndpointConnection) => void;
        const connected = new Promise<EndpointConnection>(resolve => { resolvePeer = resolve; });
        const server = await startEndpoint({
            endpoint: listenUri(kind), token: 'secret', onError: () => {},
            onConnection: peer => {
                grant(peer, claims);
                resolvePeer(peer);
            },
        });
        endpoints.push(server);
        const child = rust(['granted'], { LINKRPC_ENDPOINT: server.endpoint, LINKRPC_TOKEN: 'secret' });
        const peer = await connected;

        expect(await peer.channel.sender.sendRequest(`interop::${add}`, { a: 20, b: 22 })).toBe(42);
        await expect(peer.channel.sender.sendRequest(add, { a: 1, b: 1 })).rejects.toMatchObject({ code: -32601 });
        expect(claims).toEqual([{ serviceId: 'interop' }]);

        const exited = once(child, 'exit');
        server.dispose();
        expect((await exited)[0]).toBe(0);
    });

    it('serves a Rust participant over stdio without a handshake', async () => {
        const child = rust(['root'], { LINKRPC_ENDPOINT: 'stdio' });
        const { transport } = await connectNdjson({ input: child.stdout!, output: child.stdin! });
        const connection = LinkRpcConnection.fromTransport(transport);
        expect(await connection.channel.sendRequest(add, { a: 2, b: 3 })).toBe(5);

        const exited = once(child, 'exit');
        child.stdin!.end();
        expect((await exited)[0]).toBe(0);
    });

    it('a Rust cmd: parent spawns a TS startEndpoint child and calls it', async () => {
        const endpoint = formatEndpointUri({ kind: 'cmd-env', command: { argv: [process.execPath, childScript] } });
        const child = spawn(executable, ['call', endpoint], { stdio: ['ignore', 'pipe', 'inherit'] });
        children.push(child);
        let output = '';
        child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        const [code] = await once(child, 'exit') as [number | null];
        expect({ code, output: output.trim() }).toEqual({ code: 0, output: '"rust via ts"' });
    });
});
