import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { connectNdjson, ErrorCode, RpcError, LinkRpcConnection } from '@hediet/linkrpc/node';
import { streamingInterop } from './fixtures/streamingInterop.generated';

const executable = fileURLToPath(new URL(
    `../../../../../rust/target/debug/examples/streaming_interop${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
));

async function peer(mode: '--server' | '--client' = '--server') {
    const child = spawn(executable, [mode], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    const { transport } = await connectNdjson({
        input: child.stdout,
        output: child.stdin,
        trace: (direction, message) => {
            if (process.env.LINKRPC_STREAMING_TRACE === '1') console.error(direction, JSON.stringify(message));
        },
    });
    const connection = LinkRpcConnection.fromTransport(transport);
    return {
        connection,
        transport,
        exited,
        child,
        close() {
            connection.close();
            if (child.exitCode === null) child.kill();
        },
    };
}

// Opt-in because the ordinary TypeScript suite does not require a Rust toolchain.
// `interop/generate-streaming.mjs --check` builds the executable and checks this generated contract.
describe.runIf(process.env.LINKRPC_STREAMING_INTEROP === '1')('Rust/TypeScript streaming', () => {
    it('typechecks the generated stream payloads and rejects wrong payload types', () => {
        const program = ts.createProgram([fileURLToPath(import.meta.url)], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            strict: true,
            skipLibCheck: true,
            noEmit: true,
        });
        expect(ts.getPreEmitDiagnostics(program).map(diagnostic =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    }, 15_000);

    it('uses the Rust-exported contract and hash without a parallel TypeScript schema', () => {
        const schema = JSON.parse(execFileSync(executable, ['--schema'], { encoding: 'utf8' }));
        expect(streamingInterop.toSchema()).toEqual(schema);
    });

    it.each([false, true])('TS client -> Rust server: duplex, null, ping, ordered final/error (%s)', async fail => {
        const remote = await peer();
        try {
            const messages: (number | null)[] = [];
            const call = remote.connection.get(streamingInterop).exchange({ fail }, {
                onMessage: value => messages.push(value),
            });
            if (false) {
                // @ts-expect-error Rust's i64 stream field is a number, not a string.
                void call.send({ kind: 'add', value: 'wrong' });
            }
            const settled = call.then(value => ({ value }), error => ({ error }));
            await call.ping();
            await call.send({ kind: 'add', value: 7 });
            await call.send({ kind: 'add', value: 5 });
            await call.send({ kind: 'finish' });
            if (fail) {
                expect(await settled).toMatchObject({
                    error: { code: 1234, message: 'expected failure', data: { total: 12 } },
                });
            } else {
                expect(await settled).toEqual({ value: 12 });
            }
            expect(messages).toEqual([null, 7, 12, 12]);
        } finally {
            remote.close();
        }
    });

    it('TS client -> Rust server: advisory cancellation retains the final error', async () => {
        const remote = await peer();
        try {
            let ready!: () => void;
            const received = new Promise<void>(resolve => { ready = resolve; });
            const call = remote.connection.get(streamingInterop).cancellable({}, {
                onMessage: message => { expect(message).toBe('ready'); ready(); },
            });
            if (false) {
                // @ts-expect-error A server-only stream has no client payload type.
                void call.send('wrong direction');
            }
            const settled = call.catch(error => error);
            await received;
            await call.cancel('interop cancellation');
            expect(await settled).toMatchObject({
                code: ErrorCode.cancelled,
                message: 'interop cancellation',
            });
        } finally {
            remote.close();
        }
    });

    it('buffers immediate input and drops malformed application payloads', async () => {
        const remote = await peer();
        try {
            const messages: (number | null)[] = [];
            const call = remote.connection.get(streamingInterop).exchange({ fail: false }, {
                onMessage: value => messages.push(value),
            });
            await remote.transport.send({
                jsonrpc: '2.0',
                method: '$stream::send',
                params: {
                    requestId: await call.requestId,
                    dir: 'toCallee',
                    payload: { kind: 'add', value: 'not an integer' },
                },
            });
            await call.send({ kind: 'add', value: 42 });
            await call.send({ kind: 'finish' });
            expect(await call).toBe(42);
            expect(messages).toEqual([null, 42, 42]);
        } finally {
            remote.close();
        }
    });

    it('TS client -> Rust server: disconnect rejects an in-flight stream', async () => {
        const remote = await peer();
        try {
            let ready!: () => void;
            const received = new Promise<void>(resolve => { ready = resolve; });
            const call = remote.connection.get(streamingInterop).cancellable({}, { onMessage: () => ready() });
            const settled = call.catch(error => error);
            await received;
            remote.connection.close();
            expect(await settled).toMatchObject({ code: ErrorCode.peerDisconnected });
        } finally {
            remote.close();
        }
    });

    it('Rust client -> TS server: generated client, duplex, errors and cancellation', async () => {
        const remote = await peer('--client');
        const modes: boolean[] = [];
        try {
            remote.connection.register(streamingInterop, {
                exchange: ({ fail }, _ctx, stream) => new Promise<number>((resolve, reject) => {
                    modes.push(fail);
                    let total = 0;
                    let pending = stream.send(null).then(() => stream.ping());
                    stream.onMessage(command => {
                        pending = pending.then(async () => {
                            if (command.kind === 'add') {
                                total += command.value;
                                await stream.send(total);
                            } else {
                                await stream.send(total);
                                if (fail) {
                                    reject(new RpcError('expected failure', 1234, { total }));
                                } else {
                                    resolve(total);
                                }
                            }
                        });
                        pending.catch(reject);
                    });
                    pending.catch(reject);
                }),
                cancellable: async (_params, _ctx, stream) => {
                    const cancelled = new Promise<void>(resolve => {
                        stream.signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    await stream.send('ready');
                    await cancelled;
                    throw stream.signal.reason;
                },
            });
            expect(await remote.exited).toEqual([0, null]);
            expect(modes).toEqual([false, true]);
        } finally {
            remote.close();
        }
    });
});
