import { HubRpcConnection } from '@vscode/hubrpc';
import {
    scriptRunnerInterface,
    type RunClientStream,
    type RunParams,
    type RunServerStream,
} from '@vscode/hubrpc-node-runner/interface';
import type { CliChannel } from '@vscode/hubrpc-client';
import * as path from 'node:path';

/** Service id the supervisor serves the script runner under. */
const RUN_SERVICE_ID = 'scriptRunner';

export interface NodeCommandOptions {
    /** Path to the entry script (resolved to absolute before sending). */
    readonly script: string;
    /** Arguments forwarded to the script. */
    readonly argv: readonly string[];
    /**
     * PTY preference. `undefined` = auto (prefer a PTY when stdout is a TTY),
     * `true` = explicitly prefer a PTY, `false` = force pipe mode. This is only
     * a *request*: the supervisor decides the actual transport and reports it
     * back in the first `started` message, which is what the terminal is then
     * configured from.
     */
    readonly pty?: boolean;
    /** Working directory for the spawned child. */
    readonly cwd?: string;
}

/**
 * `svc node <script> [args...]` — ask the supervisor to run a node script
 * under a hash-pinned managed identity, bridging the child's console over the
 * `svc::scriptRunner::run` stream.
 *
 * Returns the child's exit code. The caller never receives the script's
 * identity; it only drives the script's stdio. The call is issued through the
 * script runner's typed interface, so the wire method, params and stream
 * payloads are all schema-checked at the call site.
 *
 * The PTY mode is **negotiated**: we send a preference, and configure our own
 * terminal (raw mode + byte-forwarding vs. cooked mode + SIGINT-forwarding)
 * only once the supervisor tells us, in the `started` message, which transport
 * it actually allocated. A pipe has no line discipline, so in that case Ctrl-C
 * must be translated to an explicit `signal` message rather than forwarded as
 * a raw `0x03` byte.
 */
export async function nodeCommand(channel: CliChannel, opts: NodeCommandOptions): Promise<number> {
    const absPath = path.resolve(opts.script);
    const stdout = process.stdout;
    const stdin = process.stdin;
    // Requesting a PTY is only meaningful when our own stdout is a terminal.
    // `undefined` (auto) prefers a PTY in that case; `--no-pty` forces it off.
    const preferPty = opts.pty !== false && stdout.isTTY === true;

    const params: RunParams = {
        absPath,
        argv: [...opts.argv],
        pty: preferPty,
    };
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (preferPty && typeof stdout.columns === 'number') {
        params.cols = stdout.columns;
        params.rows = typeof stdout.rows === 'number' ? stdout.rows : 24;
    }

    const runner = new HubRpcConnection(channel)
        .service(RUN_SERVICE_ID)
        .get(scriptRunnerInterface);

    const call = runner.run(params, { onMessage: (m) => _onServerMessage(m) });

    const send = (msg: RunClientStream): void => {
        // Fire-and-forget; if the peer is gone the child teardown will follow.
        void call.send(msg).catch(() => { /* peer gone */ });
    };

    // ---- local → server handlers (attached once the mode is known) ----
    const onData = (chunk: Buffer | string): void => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        send({ t: 'stdin', data: buf.toString('base64') });
    };
    const onResize = (): void => {
        if (typeof stdout.columns === 'number') {
            send({
                t: 'resize',
                cols: stdout.columns,
                rows: typeof stdout.rows === 'number' ? stdout.rows : 24,
            });
        }
    };
    const onSigint = (): void => send({ t: 'signal', signal: 'SIGINT' });

    // Teardown actions registered by `_configureTerminal`, run in `finally`.
    let teardown: (() => void) | undefined;

    /**
     * Configure the local terminal from the *actual* mode the supervisor
     * chose. Real PTY: raw mode + raw byte forwarding (the server PTY's line
     * discipline turns Ctrl-C into a signal) + resize forwarding. Pipe: no
     * line discipline, so stay in cooked mode and forward stdin while letting
     * the terminal raise SIGINT to us, which we relay as a `signal` message.
     */
    function _configureTerminal(actualPty: boolean): void {
        if (actualPty && stdin.isTTY && typeof stdin.setRawMode === 'function') {
            stdin.setRawMode(true);
            stdin.resume();
            stdin.on('data', onData);
            stdout.on('resize', onResize);
            teardown = () => {
                stdin.off('data', onData);
                if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
                stdin.pause();
                stdout.off('resize', onResize);
            };
        } else {
            // Pipe mode (or non-TTY stdin): cooked. Forward stdin bytes, and
            // translate the SIGINT the terminal raises on Ctrl-C into an
            // explicit kill request — the pipe can't do it for us.
            stdin.resume();
            stdin.on('data', onData);
            process.on('SIGINT', onSigint);
            teardown = () => {
                stdin.off('data', onData);
                stdin.pause();
                process.off('SIGINT', onSigint);
            };
        }
    }

    // ---- server → local ----
    function _onServerMessage(m: RunServerStream): void {
        switch (m.t) {
            case 'started':
                _configureTerminal(m.pty);
                break;
            case 'stdout':
                stdout.write(Buffer.from(m.data, 'base64'));
                break;
            case 'stderr':
                process.stderr.write(Buffer.from(m.data, 'base64'));
                break;
            case 'exit':
                break;
        }
    }

    try {
        const res = await call;
        return res.exitCode ?? 0;
    } finally {
        teardown?.();
    }
}
