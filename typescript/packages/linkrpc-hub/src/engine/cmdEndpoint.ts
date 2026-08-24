/**
 * Helpers for `cmd-env` / `cmd-stdio` endpoints: a human-readable label for
 * log prefixing, line-prefixed piping of a child's console output, and
 * optional stdin forwarding for `--cmd-interactive`.
 */
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { EndpointConfig } from '../config';
import type { EndpointCommand } from '@hediet/linkrpc/node';

/**
 * Short label for a transport, used to prefix its console log lines.
 * Preference order: an explicit name (the `namedEndpoints` key) → the command
 * basename (`cmd` / `argv[0]`) → the URI host / socket basename → the kind.
 */
export function endpointLabel(ep: EndpointConfig, nameKey?: string): string {
    if (nameKey !== undefined && nameKey.length > 0) return nameKey;
    switch (ep.kind) {
        case 'cmd-env':
        case 'cmd-stdio': {
            const first = ep.cmd ?? ep.argv?.[0];
            if (first) return path.basename(first.split(/\s+/)[0] ?? first);
            return ep.kind;
        }

        case 'uri':
            return _hostish(ep.uri);
        case 'ws':
            return _hostish(ep.url);
        case 'socket':
            return path.basename(ep.path) || 'socket';
    }
}

export function endpointCommand(
    ep: Extract<EndpointConfig, { kind: 'cmd-env' | 'cmd-stdio'; }>,
): EndpointCommand {
    if (ep.argv !== undefined && ep.argv.length > 0) return { argv: ep.argv };
    if (ep.cmd !== undefined) return { command: ep.cmd };
    throw new Error('cmd endpoint requires either `cmd` or `argv`');
}

export function killChild(child: ChildProcess): void {
    if (!child.killed) child.kill();
}

function _hostish(uri: string): string {
    try {
        return new URL(uri).host || uri;
    } catch {
        return uri;
    }
}

/**
 * Pipe a child's stdout/stderr to `log`, one prefixed line at a time. Pass
 * `includeStdout: false` for `cmd-stdio`, whose stdout carries the RPC stream
 * (only stderr is human output there).
 */
export function pipeChildLogs(
    child: ChildProcess,
    label: string,
    log: (line: string) => void,
    opts: { includeStdout: boolean },
): void {
    const emit = (chunk: string): void => {
        for (const line of chunk.split(/\r?\n/)) {
            if (line.length > 0) log(`[${label}] ${line}`);
        }
    };
    if (opts.includeStdout && child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', emit);
    }
    if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', emit);
    }
}

/**
 * Forward this process's stdin to a child's stdin (for `--cmd-interactive`).
 * Returns a teardown that detaches the listener and restores the tty.
 */
export function forwardStdin(child: ChildProcess): () => void {
    const stdin = process.stdin;
    if (!child.stdin) return () => { };
    const onData = (chunk: Buffer | string): void => {
        child.stdin?.write(chunk);
    };
    stdin.resume();
    stdin.on('data', onData);
    return () => {
        stdin.off('data', onData);
        stdin.pause();
    };
}
