import {
    connectNdjson,
    type EndpointCommand,
    openWebSocket,
    runInitializeHandshake,
    WebSocketTransport,
} from '@hediet/linkrpc/node';
import { SocketServer, type NodeSocketTransport } from '@hediet/linkrpc-hub/hub/server/node';
import { spawnCommand } from '@hediet/linkrpc-hub/spawn';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { ResolvedEndpoint } from '@hediet/linkrpc-client';
import type { TransportHandle } from './connectAs';

/** A ws / socket endpoint the CLI can dial (the only dial-able hub-facing kinds). */
export type DialEndpoint = Extract<ResolvedEndpoint, { kind: 'ws' | 'socket'; }>;

/**
 * Dial a ws / socket endpoint as a client, presenting `token` in the
 * `hubrpc::initialize` handshake. Used for the hub-facing side (with the minted
 * bound token) and for ws / socket / uri targets (with the target's own token).
 */
export async function openDialTransport(spec: DialEndpoint, token: string): Promise<TransportHandle> {
    if (spec.kind === 'ws') {
        const ws = await openWebSocket(spec.url);
        const closeWs = (): void => { try { ws.close(); } catch { /* ignore */ } };
        const transport = new WebSocketTransport(ws, closeWs);
        try {
            await runInitializeHandshake(transport, { kind: 'client', token });
        } catch (err) {
            transport.dispose();
            closeWs();
            throw err;
        }
        return {
            transport,
            onClose: (cb) => ws.addEventListener('close', () => cb()),
            dispose: () => { transport.dispose(); closeWs(); },
        };
    }
    const socket = net.createConnection(spec.path);
    const { transport } = await connectNdjson({
        input: socket,
        output: socket,
        onClose: () => socket.destroy(),
        initialize: { kind: 'client', token },
    });
    return {
        transport,
        onClose: (cb) => socket.on('close', cb),
        dispose: () => socket.destroy(),
    };
}

/** Forward a child stream's lines to `log`, prefixed with `label`. */
function _pipeLines(
    stream: NodeJS.ReadableStream | null,
    label: string,
    log: (line: string) => void,
): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
            if (line.length > 0) log(`[${label}] ${line}`);
        }
    });
}

/** Spawn a `cmd-stdio` target and talk linkrpc over its stdin/stdout. */
export async function openStdioTransport(
    command: EndpointCommand,
    env: Readonly<Record<string, string>> | undefined,
    cwd: string | undefined,
    log?: (line: string) => void,
): Promise<TransportHandle> {
    const child = spawnCommand(command, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
    });
    if (!child.stdin || !child.stdout) {
        throw new Error('connect-as: cmd-stdio child exposes no stdio');
    }
    // stdout carries the linkrpc protocol; only stderr can be logged.
    if (log) _pipeLines(child.stderr, 'target', log);
    const { transport } = await connectNdjson({
        input: child.stdout,
        output: child.stdin,
        onClose: () => { if (!child.killed) child.kill(); },
    });
    return {
        transport,
        onClose: (cb) => child.once('exit', cb),
        dispose: () => { transport.dispose(); if (!child.killed) child.kill(); },
    };
}

/**
 * Spawn a `cmd-env` target against a private socket the CLI listens on, and
 * take the single connection it dials back. This is the sole role-inverted
 * case: the target dials the CLI, so we accept rather than dial. No hub /
 * acceptor is needed — just the raw post-handshake transport to splice.
 */
export async function openAcceptOneTransport(
    command: EndpointCommand,
    env: Readonly<Record<string, string>> | undefined,
    cwd: string | undefined,
    log?: (line: string) => void,
): Promise<TransportHandle> {
    const socketPath = SocketServer.allocSocketPath();
    const token = randomBytes(16).toString('hex');
    const server = await SocketServer.start({ endpoint: socketPath });

    const accepted = new Promise<NodeSocketTransport>((resolve) => {
        server.setConnectionHandler((t) => resolve(t));
    });
    const child = spawnCommand(command, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env, LINKRPC_ENDPOINT: socketPath, LINKRPC_TOKEN: token },
        ...(cwd !== undefined ? { cwd } : {}),
    });
    // The child talks to the CLI over the socket, so both its stdout and stderr
    // are free to surface (crucial for diagnosing a child that exits before
    // dialing back).
    if (log) {
        _pipeLines(child.stdout, 'target', log);
        _pipeLines(child.stderr, 'target', log);
    }

    let exited = false;
    child.once('exit', () => { exited = true; });

    const transport = await Promise.race([
        accepted,
        new Promise<never>((_resolve, reject) => {
            child.once('exit', (code) =>
                reject(new Error(`connect-as: cmd-env child exited (code ${code ?? '?'}) before connecting`)),
            );
        }),
    ]).catch((err: unknown) => {
        server.dispose();
        _unlink(socketPath);
        if (!child.killed) child.kill();
        throw err;
    });

    const dispose = (): void => {
        transport.dispose();
        server.dispose();
        _unlink(socketPath);
        if (!exited && !child.killed) child.kill();
    };
    return {
        transport,
        onClose: (cb) => { transport.onDidClose(cb); child.once('exit', cb); },
        dispose,
    };
}

/** Open the target-facing transport for any resolved endpoint kind. */
export function openTargetTransport(
    endpoint: ResolvedEndpoint,
    log?: (line: string) => void,
): Promise<TransportHandle> {
    switch (endpoint.kind) {
        case 'cmd-env':
            return openAcceptOneTransport(endpoint.command, endpoint.env, endpoint.cwd, log);
        case 'cmd-stdio':
            return openStdioTransport(endpoint.command, endpoint.env, endpoint.cwd, log);
        case 'ws':
        case 'socket':
            return openDialTransport(endpoint, endpoint.token ?? '');
    }
}

function _unlink(socketPath: string): void {
    if (process.platform === 'win32') return;
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
}
