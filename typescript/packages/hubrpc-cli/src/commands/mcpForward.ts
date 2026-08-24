import { HubRpcConnection } from '@vscode/hubrpc';
import { hubGrantedServiceIdInterface } from '@vscode/hubrpc/hub/common';
import { type EndpointCommand } from '@vscode/hubrpc/node';
import { spawnCommand } from '@vscode/hubrpc-hub/spawn';
import * as readline from 'node:readline';
import type { CliConnection } from '@vscode/hubrpc-client';
import { mcpForwardInterface } from '../mcpForward.interface';

/**
 * Front door for claiming a serviceId within the connection's granted
 * namespace — interface-form `hubGrantedServiceId::register`. Same claim the
 * `tunnel` command uses.
 */
const CLAIM_METHOD = `${hubGrantedServiceIdInterface.info.id}::register`;

/** Read-only connection facts — `hubGrantedServiceId::get`. */
const INFO_METHOD = `${hubGrantedServiceIdInterface.info.id}::get`;

export interface McpForwardOptions {
    /**
     * Prefix to claim on the hub; the MCP server is reached as
     * `<serviceId>::vscode.mcp-forward::connect`. When omitted, the connection's
     * granted serviceId namespace (`hubGrantedServiceId::get`) is claimed as-is.
     */
    readonly serviceId?: string;
    /** Live, signed connection to the hub we claim `serviceId` on and serve from. */
    readonly local: CliConnection;
    /** The MCP server child to spawn (one fresh child per `connect` leg). */
    readonly command: EndpointCommand;
    /** Extra env merged on top of `process.env` for the spawned child. */
    readonly env?: Readonly<Record<string, string>>;
    /** Resolves to stop the forwarder (e.g. on SIGINT). Defaults to first SIGINT/SIGTERM. */
    readonly stop?: Promise<void>;
    /** Sink for human-readable status lines (defaults to stderr). */
    readonly log?: (line: string) => void;
}

/**
 * Run a transparent MCP forwarder until stopped.
 *
 * Serves {@link mcpForwardInterface} under `serviceId` on the hub: each inbound
 * `connect` request spawns a fresh MCP server child and shuttles raw JSON-RPC
 * frames between the child's stdio (newline-delimited JSON, the MCP stdio
 * transport framing) and the request's duplex stream. The forwarder never
 * parses MCP semantics — it only splits/joins NDJSON lines so each line becomes
 * one opaque `frame`. {@link HubRpcConnection.enableReflection} is enabled so
 * the hub's directory can discover the service.
 *
 * Resolves when {@link McpForwardOptions.stop} resolves (or on SIGINT/SIGTERM).
 */
export async function mcpForwardCommand(opts: McpForwardOptions): Promise<void> {
    const log = opts.log ?? ((line) => process.stderr.write(line + '\n'));

    // Default the prefix to the connection's granted serviceId namespace, so a
    // forwarder run without an explicit `--serviceId` claims exactly what it is
    // already entitled to.
    const serviceId = opts.serviceId ?? await _resolveGrantedServiceId(opts.local);

    // A typed connection that SERVES the forward interface over the hub link.
    // Constructing it binds the inbound handler, so do this BEFORE claiming so
    // no `connect` can race in between the claim landing and the handler being
    // installed.
    const conn = new HubRpcConnection(opts.local.rpcChannel);
    conn.register(
        mcpForwardInterface,
        {
            connect: (_params, _ctx, stream) => _runLeg(opts.command, opts.env, stream, log),
        },
        { serviceId },
    );
    // Advertise reflection (directory + schemas) under the same serviceId so the
    // hub's referral-only directory fan-out can discover and surface this leg.
    conn.enableReflection({ serviceId });

    // Claim the prefix via the granted-namespace front door. The local
    // connection's signing layer signs this where the hub requires it.
    await opts.local.channel.sendRequest(CLAIM_METHOD, { serviceId });
    log(`mcp-forward: claimed '${serviceId}' — forwarding MCP stdio to ${_describe(opts.command)}`);

    await (opts.stop ?? _untilSignalled());
    log('mcp-forward: stopping');
}

/**
 * Resolve the connection's granted serviceId namespace
 * (`hubGrantedServiceId::get`) to use as the default forward prefix. Throws if
 * the namespace is empty ("claim nothing freely") — the caller must then pass an
 * explicit `--serviceId`.
 */
async function _resolveGrantedServiceId(local: CliConnection): Promise<string> {
    const info = await local.channel.sendRequest(INFO_METHOD, {}) as {
        grantedServiceIdNamespace?: string;
    } | null | undefined;
    const granted = info?.grantedServiceIdNamespace ?? '';
    if (granted.length === 0) {
        throw new Error(
            'mcp-forward: this connection has no granted serviceId namespace to claim; '
            + 'pass an explicit --serviceId.',
        );
    }
    return granted;
}

/**
 * One MCP session leg: spawn the child, bridge stdio<->stream, and resolve when
 * the child exits or the caller cancels (killing the child).
 */
function _runLeg(
    command: EndpointCommand,
    env: Readonly<Record<string, string>> | undefined,
    stream: { send(p: { frame: unknown; }): void; onMessage(l: (p: { frame: unknown; }) => void): void; readonly signal: AbortSignal; },
    log: (line: string) => void,
): Promise<{ serverInfo?: { name: string; version: string; }; }> {
    return new Promise((resolve) => {
        const child = spawnCommand(command, {
            stdio: ['pipe', 'pipe', 'inherit'],
            ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
        });
        if (!child.stdin || !child.stdout) {
            log('mcp-forward: child exposes no stdio');
            if (!child.killed) child.kill();
            resolve({});
            return;
        }

        let settled = false;
        const rl = readline.createInterface({ input: child.stdout });
        const finish = (): void => {
            if (settled) return;
            settled = true;
            rl.close();
            if (!child.killed) child.kill();
            resolve({});
        };

        // child stdout (NDJSON) → stream: each line becomes one opaque frame.
        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0) return;
            let frame: unknown;
            try {
                frame = JSON.parse(trimmed);
            } catch {
                // MCP stdio servers must emit JSON-only on stdout; skip stray
                // non-JSON lines defensively instead of corrupting the stream.
                return;
            }
            if (stream.signal.aborted) return;
            stream.send({ frame });
        });

        // stream → child stdin: re-serialize each frame as one NDJSON line.
        stream.onMessage(({ frame }) => {
            if (!child.stdin || child.stdin.destroyed) return;
            child.stdin.write(JSON.stringify(frame) + '\n');
        });

        // Caller cancelled / disconnected → kill the child and settle.
        if (stream.signal.aborted) {
            finish();
            return;
        }
        stream.signal.addEventListener('abort', finish, { once: true });

        // Child exited → settle so the consumer drops its client.
        child.on('exit', finish);
        child.on('error', (err) => {
            log(`mcp-forward: child error: ${String(err)}`);
            finish();
        });
    });
}

/** Resolve on the next `SIGINT` / `SIGTERM`. */
function _untilSignalled(): Promise<void> {
    return new Promise<void>((resolve) => {
        const done = (): void => {
            process.removeListener('SIGINT', done);
            process.removeListener('SIGTERM', done);
            resolve();
        };
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
    });
}

/** One-line description of the spawned command for logs. */
function _describe(command: EndpointCommand): string {
    return 'argv' in command ? command.argv.join(' ') : command.command;
}
