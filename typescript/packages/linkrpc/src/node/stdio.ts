import { type ChildProcess, spawn } from 'node:child_process';
import { connectNdjson } from './initialize';
import type { Channel } from '../connection/channel';
import type { IDisposable } from '../disposable';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';

/**
 * Spawn a child process and connect to its stdio as a linkrpc connection.
 *
 * Pass a single command line (split on whitespace) or an array `[cmd, ...args]`.
 * The child's stderr is piped to the parent's stderr so logs surface naturally.
 *
 * @example
 *   const c = await connectToCmdStdio("node ./ghConnector.js");
 *   const gh = c.get(ghInterface);
 *   await gh.createIssue({ title: "..." });
 */
export async function connectToCmdStdio(cmd: string | readonly string[]): Promise<LinkRpcConnection> {
    const parts = typeof cmd === 'string' ? cmd.split(/\s+/).filter(Boolean) : [...cmd];
    if (parts.length === 0) throw new Error('connectToCmdStdio: empty command');
    const [bin, ...args] = parts;
    const child: ChildProcess = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (!child.stdin || !child.stdout) {
        throw new Error('connectToCmdStdio: child has no stdio');
    }
    const { transport } = await connectNdjson({
        input: child.stdout,
        output: child.stdin,
        onClose: () => {
            if (!child.killed) child.kill();
        },
    });
    return LinkRpcConnection.fromTransport(transport);
}

/**
 * For the child side: a linkrpc connection over this process's stdin/stdout.
 * The child MUST NOT write user output to stdout — only RPC messages — or
 * the parent's parser will choke.
 */
export async function serveOnStdio(): Promise<LinkRpcConnection> {
    const { transport } = await connectNdjson({ input: process.stdin, output: process.stdout });
    return LinkRpcConnection.fromTransport(transport);
}

/**
 * A raw, unsigned channel over this process's stdin/stdout — the stdio
 * counterpart to `openHubChannel`. It *is* a {@link Channel} (so it plugs
 * straight into {@link SigningSender.wrapChannel} / `new LinkRpcConnection`),
 * augmented with a close signal for stdin end. Use {@link serveOnStdio}
 * instead when no signing is needed.
 */
export type StdioChannel = Channel<undefined, unknown> & {
    /** Fires once when stdin ends/closes. Returns a disposable to unsubscribe. */
    onClose(listener: () => void): IDisposable;
};

export async function openStdioChannel(): Promise<StdioChannel> {
    const { transport } = await connectNdjson({ input: process.stdin, output: process.stdout });
    const channel = JsonRpcChannel.create(transport);

    const closeListeners = new Set<() => void>();
    let closed = false;
    const fireClose = () => {
        if (closed) return;
        closed = true;
        for (const l of closeListeners) {
            try {
                l();
            } catch { /* ignore */ }
        }
        closeListeners.clear();
    };
    process.stdin.on('end', fireClose);
    process.stdin.on('close', fireClose);

    return Object.assign(channel, {
        onClose: (listener: () => void) => {
            if (closed) {
                queueMicrotask(listener);
                return { dispose: () => { } };
            }
            closeListeners.add(listener);
            return { dispose: () => closeListeners.delete(listener) };
        },
    });
}
