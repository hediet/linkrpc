import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    JsonRpcChannel,
    LinkRpcConnection,
    traceMessageTransport,
    type JsonRpcMessage,
} from '@hediet/linkrpc';
import { adaptJsonRpcTransport } from '../../src/json-rpc/messageTransport';
import { createNdjsonJsonRpcTransport } from '../../src/json-rpc/stdio';

export async function startRustPeer(binary: string, args: string[]) {
    const child: ChildProcessWithoutNullStreams = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65_536); });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    const input = new PassThrough();
    const transport = adaptJsonRpcTransport(createNdjsonJsonRpcTransport({
        input, output: child.stdin,
    }));
    const frames: { direction: string; message: JsonRpcMessage }[] = [];
    const lifecycle = JsonRpcChannel.createWithClose(traceMessageTransport(
        transport,
        (direction, message) => frames.push({ direction, message }),
    ));
    transport.onClose(() => lifecycle.close());
    const connection = new LinkRpcConnection(lifecycle.channel);
    return {
        connection,
        frames,
        exited,
        stderr: () => stderr,
        start(): void {
            child.stdout.pipe(input);
        },
        disconnect(): void {
            connection.close();
            transport.dispose();
            child.stdin.end();
        },
        async stop(): Promise<void> {
            connection.close();
            transport.dispose();
            child.stdout.unpipe(input);
            input.destroy();
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.stdin.end();
            const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
            try {
                await exited;
            } finally {
                clearTimeout(kill);
            }
        },
    };
}

export async function within<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 10_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
