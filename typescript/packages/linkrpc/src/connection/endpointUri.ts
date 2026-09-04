/**
 * A strict, RFC-3986 URI vocabulary for "where the linkrpc server lives, and
 * how to reach (or start) it". Every endpoint round-trips through
 * {@link parseEndpointUri} / {@link formatEndpointUri} and is a valid `new URL()`
 * — safe to put in env vars, logs, and config.
 *
 * Supported schemes:
 *   - `unix:/path/to.sock?token=…`           → {@link SocketEndpoint}
 *   - `npipe://./pipe/name?token=…`          → {@link SocketEndpoint} (Windows)
 *   - `ws://host:port?token=…` / `wss:…`     → {@link WsEndpoint} (LinkRPC handshake)
 *   - `ws-no-init://host:port?…`             → {@link WsNoInitEndpoint}
 *   - `cmd-stdio:?command=…` / `…?argv=…`    → {@link CmdStdioEndpoint}
 *   - `cmd:?command=…` / `…?argv=…`          → {@link CmdEnvEndpoint}
 *
 * The command payload is `{ command: string } | { argv: string[] }`:
 *   - `?command=node%20server.js` — one verbatim string, split by the OS shell.
 *   - `?argv=node&argv=server.js` — repeated `argv` params, structure-preserving.
 *
 * A bare string with no scheme (legacy `LINKRPC_ENDPOINT`) is auto-detected: a
 * `ws://`/`wss://` URL stays WebSocket, anything else is a socket path.
 */

/** Verbatim command line (`{ command }`) or pre-split argv (`{ argv }`). */
export type EndpointCommand =
    | { readonly command: string }
    | { readonly argv: readonly string[] };

/** Named pipe / unix-domain-socket the server already listens on. */
export interface SocketEndpoint {
    readonly kind: 'socket';
    readonly path: string;
    readonly token?: string;
    /**
     * Present on sockets created by `hub connect`. Local framing still uses the
     * LinkRPC transport handshake; this describes whether forwarded application
     * calls target a LinkRPC or plain JSON-RPC peer.
     */
    readonly brokerMode?: 'linkrpc' | 'raw';
}

/** A running WebSocket hub; `token` rides in the `hubrpc::initialize` handshake. */
export interface WsEndpoint {
    readonly kind: 'ws';
    readonly url: string;
    readonly token?: string;
}

/**
 * A running plain-JSON-RPC WebSocket endpoint. Unlike {@link WsEndpoint}, CLI
 * consumers use it without the `hubrpc::initialize` handshake or LinkRPC signing.
 * Query parameters are preserved verbatim for protocols that authenticate
 * during the WebSocket upgrade (for example AHP's `tkn` parameter).
 */
export interface WsNoInitEndpoint {
    readonly kind: 'ws-no-init';
    /** Actual `ws://` URL passed to the WebSocket constructor. */
    readonly url: string;
}

/** Spawn a child and talk linkrpc over its stdin/stdout. */
export interface CmdStdioEndpoint {
    readonly kind: 'cmd-stdio';
    readonly command: EndpointCommand;
    /** Extra environment variables injected into the spawned child. */
    readonly env?: Readonly<Record<string, string>>;
    /** Working directory for the spawned child. */
    readonly cwd?: string;
}

/**
 * Spawn a child against a freshly-started *local hub*: the parent listens on a
 * private socket, hands the child its address + token via `LINKRPC_ENDPOINT` /
 * `LINKRPC_TOKEN`, and the child dials in as a hub participant (registering its
 * services), exactly as it would against a remote hub.
 */
export interface CmdEnvEndpoint {
    readonly kind: 'cmd-env';
    readonly command: EndpointCommand;
    /**
     * When set, the local hub provisions (or reuses) a *persistent* managed
     * identity under this slot id, so the child's HPKE wrap/unwrap keys survive
     * across runs (sealed archives re-open).
     */
    readonly provisionSlot?: string;
    /** Extra environment variables injected into the spawned child. */
    readonly env?: Readonly<Record<string, string>>;
    /** Working directory for the spawned child. */
    readonly cwd?: string;
}

export type ResolvedEndpoint =
    | SocketEndpoint
    | WsEndpoint
    | WsNoInitEndpoint
    | CmdStdioEndpoint
    | CmdEnvEndpoint;

const TOKEN_PARAM = 'token';
const BROKER_PARAM = 'broker';
const COMMAND_PARAM = 'command';
const ARGV_PARAM = 'argv';
const PROVISION_SLOT_PARAM = 'provisionSlot';
const ENV_PARAM = 'env';
const CWD_PARAM = 'cwd';

function _tryParseUrl(uri: string): URL | undefined {
    try {
        return new URL(uri);
    } catch {
        return undefined;
    }
}

function _looksLikeWsUrl(uri: string): boolean {
    return /^wss?:\/\//i.test(uri);
}

/** True for a Windows named-pipe path (`\\.\pipe\…` or `\\?\pipe\…`). */
function _isWindowsPipePath(path: string): boolean {
    return /^\\\\[.?]\\pipe\\/i.test(path);
}

function _parseCommand(url: URL): EndpointCommand {
    const argv = url.searchParams.getAll(ARGV_PARAM);
    if (argv.length > 0) {
        return { argv };
    }
    const command = url.searchParams.get(COMMAND_PARAM);
    if (command !== null) {
        return { command };
    }
    throw new Error(
        `endpoint '${url.protocol}' requires a '${COMMAND_PARAM}' or '${ARGV_PARAM}' query parameter`,
    );
}

/** Parse repeated `env=KEY=VALUE` params into a record (first `=` splits). */
function _parseEnv(url: URL): Readonly<Record<string, string>> | undefined {
    const entries = url.searchParams.getAll(ENV_PARAM);
    if (entries.length === 0) {
        return undefined;
    }
    const env: Record<string, string> = {};
    for (const entry of entries) {
        const eq = entry.indexOf('=');
        if (eq === -1) {
            throw new Error(`endpoint '${ENV_PARAM}' param must be 'KEY=VALUE', got '${entry}'`);
        }
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
}

/**
 * Parse a strict endpoint URI into an {@link ResolvedEndpoint}. Throws on an
 * unknown scheme or a malformed command endpoint. A bare (scheme-less) string
 * is auto-detected as `ws`/`wss` URL or a socket path.
 */
export function parseEndpointUri(uri: string): ResolvedEndpoint {
    const trimmed = uri.trim();
    if (trimmed === '') {
        throw new Error('endpoint URI is empty');
    }

    const url = _tryParseUrl(trimmed);
    if (!url) {
        // Bare form (no scheme): legacy LINKRPC_ENDPOINT.
        if (_looksLikeWsUrl(trimmed)) {
            return { kind: 'ws', url: trimmed };
        }
        return { kind: 'socket', path: trimmed };
    }

    switch (url.protocol) {
        case 'ws:':
        case 'wss:': {
            const token = url.searchParams.get(TOKEN_PARAM) ?? undefined;
            // The token travels in the LinkRPC initialize handshake, never the URL.
            url.searchParams.delete(TOKEN_PARAM);
            const cleanUrl = url.toString();
            return token !== undefined ?
                { kind: 'ws', url: cleanUrl, token } :
                { kind: 'ws', url: cleanUrl };
        }
        case 'ws-no-init:': {
            const wsUrl = new URL(trimmed.replace(/^ws-no-init:/i, 'ws:')).toString();
            return { kind: 'ws-no-init', url: wsUrl };
        }
        case 'unix:': {
            const token = url.searchParams.get(TOKEN_PARAM) ?? undefined;
            const brokerMode = _parseBrokerMode(url);
            const path = decodeURIComponent(url.pathname);
            return {
                kind: 'socket',
                path,
                ...(token !== undefined ? { token } : {}),
                ...(brokerMode !== undefined ? { brokerMode } : {}),
            };
        }
        case 'npipe:': {
            const token = url.searchParams.get(TOKEN_PARAM) ?? undefined;
            const brokerMode = _parseBrokerMode(url);
            // `npipe://./pipe/foo` → `\\.\pipe\foo`.
            const host = url.host === '' ? '.' : url.host;
            const tail = decodeURIComponent(url.pathname).replace(/\//g, '\\');
            const path = `\\\\${host}${tail}`;
            return {
                kind: 'socket',
                path,
                ...(token !== undefined ? { token } : {}),
                ...(brokerMode !== undefined ? { brokerMode } : {}),
            };
        }
        case 'cmd-stdio:': {
            const env = _parseEnv(url);
            const cwd = url.searchParams.get(CWD_PARAM) ?? undefined;
            return {
                kind: 'cmd-stdio',
                command: _parseCommand(url),
                ...(env !== undefined ? { env } : {}),
                ...(cwd !== undefined ? { cwd } : {}),
            };
        }
        case 'cmd:': {
            const command = _parseCommand(url);
            const provisionSlot = url.searchParams.get(PROVISION_SLOT_PARAM) ?? undefined;
            const env = _parseEnv(url);
            const cwd = url.searchParams.get(CWD_PARAM) ?? undefined;
            return {
                kind: 'cmd-env',
                command,
                ...(provisionSlot !== undefined ? { provisionSlot } : {}),
                ...(env !== undefined ? { env } : {}),
                ...(cwd !== undefined ? { cwd } : {}),
            };
        }
        default:
            throw new Error(
                `unsupported endpoint scheme '${url.protocol}' `
                + `(expected unix:, npipe:, ws:, wss:, ws-no-init:, cmd:, or cmd-stdio:)`,
            );
    }
}

export interface FormatEndpointOptions {
    /** Emit the real token instead of redacting it. Default: redact. */
    readonly revealToken?: boolean;
}

const REDACTED = '***';

function _appendToken(params: URLSearchParams, token: string | undefined, reveal: boolean): void {
    if (token === undefined) return;
    params.set(TOKEN_PARAM, reveal ? token : REDACTED);
}

function _parseBrokerMode(url: URL): SocketEndpoint['brokerMode'] {
    const value = url.searchParams.get(BROKER_PARAM);
    if (value === null) return undefined;
    if (value === 'linkrpc' || value === 'raw') return value;
    throw new Error(`endpoint '${BROKER_PARAM}' param must be 'linkrpc' or 'raw', got '${value}'`);
}

function _appendCommand(params: URLSearchParams, command: EndpointCommand): void {
    if ('argv' in command) {
        for (const a of command.argv) params.append(ARGV_PARAM, a);
    } else {
        params.set(COMMAND_PARAM, command.command);
    }
}

function _appendEnv(params: URLSearchParams, env: Readonly<Record<string, string>> | undefined): void {
    if (env === undefined) return;
    for (const [key, value] of Object.entries(env)) {
        params.append(ENV_PARAM, `${key}=${value}`);
    }
}

/**
 * Render an {@link ResolvedEndpoint} back to a canonical strict URI. The token is
 * redacted (`***`) unless `revealToken` is set, so the result is paste-safe for
 * logs. Round-trips with {@link parseEndpointUri} when `revealToken` is true.
 */
export function formatEndpointUri(spec: ResolvedEndpoint, options?: FormatEndpointOptions): string {
    const reveal = options?.revealToken === true;
    switch (spec.kind) {
        case 'socket': {
            const params = new URLSearchParams();
            _appendToken(params, spec.token, reveal);
            if (spec.brokerMode !== undefined) params.set(BROKER_PARAM, spec.brokerMode);
            const query = params.toString();
            const suffix = query === '' ? '' : `?${query}`;
            if (_isWindowsPipePath(spec.path)) {
                // `\\.\pipe\foo` → `npipe://./pipe/foo`.
                const m = spec.path.match(/^\\\\([.?])\\(.*)$/);
                const host = m ? m[1] : '.';
                const tail = (m ? m[2] : spec.path).replace(/\\/g, '/');
                return `npipe://${host}/${tail}${suffix}`;
            }
            return `unix:${spec.path}${suffix}`;
        }
        case 'ws': {
            const url = new URL(spec.url);
            _appendToken(url.searchParams, spec.token, reveal);
            return url.toString();
        }
        case 'ws-no-init': {
            return spec.url.replace(/^ws:/i, 'ws-no-init:');
        }
        case 'cmd-stdio': {
            const params = new URLSearchParams();
            _appendCommand(params, spec.command);
            _appendEnv(params, spec.env);
            if (spec.cwd !== undefined) params.set(CWD_PARAM, spec.cwd);
            return `cmd-stdio:?${params.toString()}`;
        }
        case 'cmd-env': {
            const params = new URLSearchParams();
            _appendCommand(params, spec.command);
            if (spec.provisionSlot !== undefined) {
                params.set(PROVISION_SLOT_PARAM, spec.provisionSlot);
            }
            _appendEnv(params, spec.env);
            if (spec.cwd !== undefined) params.set(CWD_PARAM, spec.cwd);
            return `cmd:?${params.toString()}`;
        }
    }
}

/** True for endpoints that connect to existing, possibly-remote infrastructure. */
export function isHubEndpoint(spec: ResolvedEndpoint): spec is SocketEndpoint | WsEndpoint {
    return (spec.kind === 'socket' && spec.brokerMode !== 'raw') || spec.kind === 'ws';
}
