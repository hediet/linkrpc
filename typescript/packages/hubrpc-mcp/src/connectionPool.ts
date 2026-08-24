import type { IMessageTransport, IRequestSender, SigningCallCtx } from '@vscode/hubrpc';
import {
    formatEndpointUri,
    HUBRPC_ENDPOINT_VAR,
    HUBRPC_TOKEN_VAR,
    parseEndpointUri,
    type ResolvedEndpoint,
} from '@vscode/hubrpc/node';
import {
    type CliConnection,
    connect,
    connectViaTransport,
    setupSigning,
    type SigningSession,
} from '@vscode/hubrpc-client';
import type { HubAccessRequest, HubAccessResult } from '@vscode/hubrpc/hub/common';
import type { SignedCapability } from '@vscode/hubrpc';

/** Receives one trace line at a time. */
export type TraceListener = (line: string) => void;

/**
 * Minimal hub-access surface the MCP tools consume from a connection: read the
 * current grants and request more. Satisfied by both a CLI {@link SigningSession}
 * (endpoint pool) and a {@link import('@vscode/hubrpc/hub/client').HubSigningSender}
 * (consumer-provided sender).
 */
export interface HubAccess {
    listGrants(): readonly SignedCapability[];
    requestAccess(req: HubAccessRequest): Promise<HubAccessResult>;
}

/**
 * One MCP-server-wide live hubrpc connection. We keep a single connection per
 * unique endpoint URI (path/url + token) so repeated tool calls reuse the same
 * socket and the per-connection `lastResultVal` survives across runs.
 */
export interface PooledConnection {
    readonly channel: IRequestSender<SigningCallCtx>;
    /** Redacted endpoint URI of this connection, for labels and tool results. */
    readonly endpoint: string;
    /**
     * Canonical endpoint URI (token revealed) — uniquely identifies this
     * connection. Used to key per-connection background tasks so that a new
     * request on the same connection supersedes the previous task.
     */
    readonly key: string;
    /**
     * Hub signing session: signs every outbound call with the connection's
     * identity and exposes the grant surface ({@link HubAccess}). For the
     * endpoint pool this is a CLI `SigningSession`; for a consumer-provided
     * sender it is the sender itself.
     */
    readonly session: HubAccess;
    /** Most recent value returned by `runHubRpcScript`. Updated after each run. */
    lastResultVal: unknown;
    /**
     * Subscribe `listener` to every JSON-RPC trace line produced while
     * the subscription is live (in addition to the always-on stderr
     * mirror). Returns a disposer that removes the listener. Multiple
     * concurrent listeners are supported — each sees every line —
     * which means concurrent runs on the same pooled connection will
     * see each other's traces. That matches the channel's own
     * concurrency model.
     */
    addTraceListener(listener: TraceListener): () => void;
    /** Emit a trace line on this connection (also writes to stderr). */
    trace(line: string): void;
    /** Close the underlying socket and drop the entry from the pool. */
    dispose(): void;
}

/**
 * Subset of {@link ConnectionPool} used by the MCP server, extracted so tests
 * can inject a fake pool without standing up a real hub connection.
 */
export interface IConnectionPool {
    resolve(endpointUri: string | undefined): Promise<PooledConnection>;
    dispose(): void;
}

/** Plain JSON-RPC connection descriptor sent by the MCP client. */
export interface ConnectionPoolOptions {
    /**
     * Endpoint used when a tool call does not specify a `connection`. When
     * neither the caller nor a default is supplied, the pool falls back to the
     * `HUBRPC_ENDPOINT` / `HUBRPC_TOKEN` environment variables.
     */
    readonly defaultEndpoint?: ResolvedEndpoint;
    /**
     * Opens the **default** connection (the one used when a tool call supplies
     * no `connection` argument) over an in-process transport instead of dialing
     * a socket — typically a leg into an in-process hub participant. When set it
     * takes precedence over {@link defaultEndpoint} / env vars for the
     * no-argument case; explicit `connection` endpoint URIs still dial normally.
     *
     * Called lazily on first use; the returned {@link DefaultTransport.dispose}
     * runs when the pooled connection is disposed.
     */
    readonly defaultTransport?: () => DefaultTransport;
}

/**
 * An in-process transport supplying the pool's default connection, plus
 * presentation/teardown hooks. The pool wraps {@link transport} in a managed
 * signing connection ({@link connectViaTransport} + `setupSigning`), exactly as
 * it would a dialed socket.
 */
export interface DefaultTransport {
    /** In-memory transport whose peer serves the hub (incl. `identity::*`). */
    readonly transport: IMessageTransport;
    /** Human-readable label for traces / tool results. Defaults to `"inproc"`. */
    readonly label?: string;
    /** Extra teardown run when the pooled connection is disposed (after `cli.close`). */
    readonly dispose?: () => void;
}

/**
 * Maintains live hub connections keyed by the canonical endpoint URI (path/url
 * + token). Connections are created lazily on first use and reused for every
 * subsequent call against the same endpoint. Setting up the hub signing session
 * (which may surface a consent modal the first time) happens once per endpoint
 * and the resulting session is cached on the pool entry.
 */
export class ConnectionPool implements IConnectionPool {
    private readonly _entries = new Map<string, Promise<PooledConnection>>();
    private readonly _defaultEndpoint: ResolvedEndpoint | undefined;
    private readonly _defaultTransport: (() => DefaultTransport) | undefined;

    /** Pool key for the in-process default connection (see {@link ConnectionPoolOptions.defaultTransport}). */
    private static readonly _DEFAULT_INPROC_KEY = '<default-inproc>';

    public constructor(options: ConnectionPoolOptions = {}) {
        this._defaultEndpoint = options.defaultEndpoint;
        this._defaultTransport = options.defaultTransport;
    }

    /**
     * Resolve a pooled connection for `endpointUri` (a strict endpoint URI such
     * as `unix:/path?token=…`, `npipe://./pipe/…?token=…`, or
     * `wss://host?token=…`). When omitted, an in-process default transport (if
     * configured) is used; otherwise it falls back to the configured default
     * endpoint, then to the `HUBRPC_ENDPOINT` / `HUBRPC_TOKEN` env vars. A token
     * absent from the URI is filled in from `HUBRPC_TOKEN` when present.
     */
    public async resolve(endpointUri: string | undefined): Promise<PooledConnection> {
        if (endpointUri === undefined && this._defaultTransport) {
            return this._resolveCached(
                ConnectionPool._DEFAULT_INPROC_KEY,
                (key) => this._openInProc(this._defaultTransport!(), key),
            );
        }
        const spec = this._resolveSpec(endpointUri);
        // Canonical URI (token revealed) uniquely identifies the connection.
        const key = formatEndpointUri(spec, { revealToken: true });
        return this._resolveCached(key, (k) => this._open(spec, k));
    }

    /**
     * Shared cache-or-open: returns the in-flight/cached entry for `key`, or
     * starts `open(key)` and caches the promise so concurrent callers share the
     * same signing setup. On failure the entry is evicted so the next call
     * retries cleanly.
     */
    private _resolveCached(
        key: string,
        open: (key: string) => Promise<PooledConnection>,
    ): Promise<PooledConnection> {
        const existing = this._entries.get(key);
        if (existing) return existing;
        const pending = open(key);
        this._entries.set(key, pending);
        pending.catch(() => this._entries.delete(key));
        return pending;
    }

    private _resolveSpec(endpointUri: string | undefined): ResolvedEndpoint {
        if (endpointUri !== undefined) {
            return _withEnvToken(parseEndpointUri(endpointUri));
        }
        return this._defaultEndpoint ?? _resolveFromEnv();
    }

    private async _open(
        spec: ResolvedEndpoint,
        key: string,
    ): Promise<PooledConnection> {
        const display = formatEndpointUri(spec);
        const cli: CliConnection = await connect(spec);
        return this._finishOpen(cli, display, key);
    }

    private async _openInProc(
        def: DefaultTransport,
        key: string,
    ): Promise<PooledConnection> {
        const cli = connectViaTransport(def.transport);
        return this._finishOpen(cli, def.label ?? 'inproc', key, def.dispose);
    }

    /**
     * Wrap an already-open {@link CliConnection} in a managed signing session
     * and build the {@link PooledConnection}. Shared by the dialed-socket and
     * in-process default paths — both sign as a managed principal and bootstrap
     * the `hubAccess` cap, the only difference being how the transport was
     * obtained. `extraDispose` runs on disposal after the connection is closed.
     */
    private async _finishOpen(
        cli: CliConnection,
        display: string,
        key: string,
        extraDispose?: () => void,
    ): Promise<PooledConnection> {
        const traceListeners = new Set<TraceListener>();
        const trace = (line: string): void => {
            process.stderr.write(`${line}\n`);
            for (const l of traceListeners) {
                try {
                    l(line);
                } catch { /* listener errors must not break the wire */ }
            }
        };
        _installTransportTrace(cli.channel, display, trace);
        try {
            trace(
                `hubrpc-mcp[${display}] requesting hub signing session (may prompt for reflection-cap consent on first use)`,
            );
            const session = await setupSigning(
                cli.channel,
                cli.signing,
                { kind: 'managed' },
                { negotiateHubCaps: true, autoNegotiatePerCall: false },
            );
            const entry: PooledConnection = {
                channel: cli.channel,
                endpoint: display,
                key,
                session,
                lastResultVal: undefined,
                addTraceListener: (listener) => {
                    traceListeners.add(listener);
                    return () => traceListeners.delete(listener);
                },
                trace,
                dispose: () => {
                    cli.close();
                    extraDispose?.();
                    this._entries.delete(key);
                },
            };
            return entry;
        } catch (e) {
            cli.close();
            extraDispose?.();
            throw e;
        }
    }

    public dispose(): void {
        for (const pending of this._entries.values()) {
            pending.then(
                (e) => e.dispose(),
                () => {/* failed open, nothing to close */ },
            );
        }
        this._entries.clear();
    }
}

/**
 * Fill a missing socket/ws token from `HUBRPC_TOKEN` when the URI itself didn't
 * carry one. Command endpoints (`cmd:` / `cmd-stdio:`) carry no token.
 */
function _withEnvToken(spec: ResolvedEndpoint): ResolvedEndpoint {
    if ((spec.kind === 'socket' || spec.kind === 'ws') && spec.token === undefined) {
        const token = process.env[HUBRPC_TOKEN_VAR];
        if (token) return { ...spec, token };
    }
    return spec;
}

function _resolveFromEnv(): ResolvedEndpoint {
    const endpoint = process.env[HUBRPC_ENDPOINT_VAR];
    if (!endpoint) {
        throw new Error(
            `No connection supplied and ${HUBRPC_ENDPOINT_VAR} is not set. ` +
            `Pass a 'connection' endpoint URI (e.g. unix:/path?token=… or ` +
            `wss://host?token=…) to the tool, or run the MCP server inside a ` +
            `VS Code window with the team-tools hub active.`,
        );
    }
    return _withEnvToken(parseEndpointUri(endpoint));
}

/**
 * Wrap `channel.sendRequest` / `channel.sendNotification` so every
 * outbound JSON-RPC envelope and its outcome is emitted as a trace
 * line. Catches everything the MCP server drives (tool-issued `call` /
 * `notify`, `explore`, and the hub's `hubAccess::requestAccess`
 * permission round-trips).
 *
 * IMPORTANT: the wrappers forward the third `opts` argument verbatim. It
 * carries the per-call {@link SigningCallCtx} (e.g. `signerOverride: null` for
 * the unsigned `identity::*` bootstrap round-trips). Dropping it would make a
 * managed identity's `identity::sign` calls get signed — which recurses
 * (signing a call needs another `identity::sign`), blowing the heap.
 */
function _installTransportTrace(
    channel: IRequestSender<SigningCallCtx>,
    endpoint: string,
    trace: TraceListener,
): void {
    const send = channel.sendRequest.bind(channel);
    const notify = channel.sendNotification.bind(channel);
    let seq = 0;
    channel.sendRequest = async (method, params, opts) => {
        const id = ++seq;
        trace(`hubrpc-mcp[${endpoint}] → #${id} request ${method} ${_fmt(params)}`);
        try {
            const result = await send(method, params, opts);
            trace(`hubrpc-mcp[${endpoint}] ← #${id} result ${_fmt(result)}`);
            return result;
        } catch (e) {
            trace(`hubrpc-mcp[${endpoint}] ← #${id} error ${(e as Error).message}`);
            throw e;
        }
    };
    channel.sendNotification = async (method, params, opts) => {
        const id = ++seq;
        trace(`hubrpc-mcp[${endpoint}] → #${id} notify ${method} ${_fmt(params)}`);
        await notify(method, params, opts);
    };
}

const _MAX_TRACE_PAYLOAD = 2000;

function _fmt(v: unknown): string {
    if (v === undefined) return '(no params)';
    let s: string;
    try {
        s = JSON.stringify(v);
    } catch {
        s = String(v);
    }
    if (s === undefined) s = 'undefined';
    return s.length > _MAX_TRACE_PAYLOAD ?
        `${s.slice(0, _MAX_TRACE_PAYLOAD)}…(+${s.length - _MAX_TRACE_PAYLOAD} chars)` :
        s;
}
