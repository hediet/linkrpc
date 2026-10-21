import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import crossSpawn from 'cross-spawn';
import type { ConsoleSignal, ConsoleSize } from '@hediet/linkrpc-infra/console';
import { killProcessTree, signalProcessGroup, SPAWN_DETACHED } from './processTree';

export interface ExitInfo {
    readonly code: number | null;
    readonly signal: string | null;
    /** Set when the process never started. */
    readonly error?: string;
}

/** A spawned service process and its console I/O, over pipes or a pseudoterminal. */
export interface ServiceProcess {
    readonly pid: number | undefined;
    /** Resolves once the process runs; never resolves when spawning fails. */
    readonly spawned: Promise<void>;
    readonly exited: Promise<ExitInfo>;
    write(data: Uint8Array): void;
    resize(size: ConsoleSize): void;
    signal(signal: ConsoleSignal): void;
    /** Forcefully end the process tree. */
    kill(): Promise<void>;
}

export interface SpawnServiceOptions {
    readonly command: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly onOutput: (stream: 'stdout' | 'stderr' | 'tty', data: Uint8Array) => void;
    readonly onError: (message: string) => void;
}

/** Signals a service process receives with their usual meaning. */
export function processSignals(tty: boolean, platform: NodeJS.Platform = process.platform): ConsoleSignal[] {
    if (platform !== 'win32') return ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL'];
    // Windows has no signals; only a console (ConPTY) can deliver Ctrl+C, everything else terminates.
    return tty ? ['SIGINT', 'SIGKILL'] : ['SIGKILL'];
}

export function spawnPipeProcess(options: SpawnServiceOptions): ServiceProcess {
    const [executable, ...args] = options.command;
    // cross-spawn resolves PATHEXT and escapes arguments for `.cmd` shims, so
    // `command` never goes through a shell's word splitting or metacharacters.
    const child = crossSpawn(executable!, args, {
        env: options.env,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: SPAWN_DETACHED,
    });
    const exited = new Promise<ExitInfo>(resolve => {
        child.once('close', (code, signal) => resolve({ code, signal }));
        child.once('error', error => {
            if (child.pid === undefined) resolve({ code: null, signal: null, error: error.message });
            else options.onError(`process error: ${error.message}`);
        });
    });
    for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.on('data', (chunk: Buffer) => options.onOutput(stream, chunk));
    }
    child.stdin?.on('error', error => options.onError(`stdin failed: ${error.message}`));
    return {
        get pid() { return child.pid; },
        spawned: new Promise(resolve => child.once('spawn', () => resolve())),
        exited,
        write: data => {
            if (!child.stdin?.writable) throw new Error('The process stdin is closed');
            child.stdin.write(data);
        },
        resize: () => {},
        signal: signal => signalProcess(child.pid, signal),
        kill: async () => { if (child.pid !== undefined) await killProcessTree(child.pid); },
    };
}

export async function spawnPtyProcess(options: SpawnServiceOptions & { readonly size: ConsoleSize }): Promise<ServiceProcess> {
    const pty = await loadPty();
    const { file, args } = ptyCommand(options.command);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
    const terminal = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: options.size.cols,
        rows: options.size.rows,
        cwd: options.cwd ?? process.cwd(),
        env,
    });
    terminal.onData(data => options.onOutput('tty', Buffer.from(data, 'utf8')));
    const exited = new Promise<ExitInfo>(resolve => terminal.onExit(({ exitCode, signal }) => resolve(signal
        ? { code: null, signal: signalName(signal) }
        : { code: exitCode, signal: null })));
    // Input chunks may split multi-byte characters; node-pty writes strings.
    const decoder = new StringDecoder('utf8');
    // ConPTY assigns the process ID asynchronously; node-pty reports 0 until then.
    const pid = () => terminal.pid > 0 ? terminal.pid : undefined;
    const kill = async () => {
        const current = pid();
        if (current !== undefined) await killProcessTree(current);
        // Closing the pseudoconsole reports the exit promptly.
        try { terminal.kill(); } catch { /* already closed */ }
    };
    return {
        get pid() { return pid(); },
        spawned: waitFor(() => pid() !== undefined, exited),
        exited,
        write: data => {
            const text = decoder.write(Buffer.from(data));
            if (text) terminal.write(text);
        },
        resize: size => terminal.resize(size.cols, size.rows),
        signal: signal => {
            // ConPTY turns ETX into a Ctrl+C event for the console's processes.
            if (signal === 'SIGINT' && process.platform === 'win32') terminal.write('\x03');
            else if (signal === 'SIGKILL') void kill();
            else signalProcess(pid(), signal);
        },
        kill,
    };
}

/** Resolve once `condition` holds, or once `until` settles. */
async function waitFor(condition: () => boolean, until: Promise<unknown>): Promise<void> {
    let settled = false;
    void until.then(() => { settled = true; });
    while (!condition() && !settled) await new Promise(resolve => setTimeout(resolve, 5));
}

function signalProcess(pid: number | undefined, signal: ConsoleSignal): void {
    if (pid === undefined) throw new Error('The process is not running');
    if (signal === 'SIGKILL') void killProcessTree(pid);
    else if (process.platform === 'win32') throw new Error(`${signal} cannot be delivered on Windows`);
    else signalProcessGroup(pid, signal);
}

type PtyModule = typeof import('@lydell/node-pty');
let ptyModule: Promise<PtyModule> | undefined;

function loadPty(): Promise<PtyModule> {
    ptyModule ??= import('@lydell/node-pty').then(
        module => (module as { default?: PtyModule }).default ?? module,
        error => {
            ptyModule = undefined;
            throw new Error(`TTY support is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        },
    );
    return ptyModule;
}

interface ParsedCommand {
    readonly command: string;
    readonly args: string[];
    readonly file?: string;
    readonly options: { readonly windowsVerbatimArguments?: boolean };
}

/** Resolve like {@link spawnPipeProcess}: PATHEXT lookup and escaped `.cmd` shims on Windows. */
function ptyCommand(command: readonly string[]): { file: string; args: string[] | string } {
    const [executable, ...args] = command;
    if (process.platform !== 'win32') return { file: executable!, args };
    const parse = (crossSpawn as unknown as { _parse(command: string, args: string[], options: object): ParsedCommand })._parse;
    const parsed = parse(executable!, args, {});
    // A shim runs through cmd.exe with an already escaped command line.
    if (parsed.options.windowsVerbatimArguments) return { file: parsed.command, args: parsed.args.join(' ') };
    return { file: parsed.file ?? parsed.command, args: parsed.args };
}

function signalName(signal: number): string {
    return Object.entries(os.constants.signals).find(([, value]) => value === signal)?.[0] ?? String(signal);
}
