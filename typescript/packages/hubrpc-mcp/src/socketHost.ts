import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { randomBytes, randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HubRpcMcpServer, type HubRpcMcpServerOptions } from "./server";

/**
 * Per-session wiring the host asks its owner to provide. Created once per MCP
 * `initialize`, keyed by `sessionId`. The owner decides how that session reaches
 * the hub (e.g. an in-process `defaultConnection`) and what to tear down when the
 * session closes.
 */
export interface McpSession {
    /** Options for this session's {@link HubRpcMcpServer} (e.g. a `defaultConnection`). */
    readonly serverOptions: HubRpcMcpServerOptions;
    /**
     * Teardown for resources scoped to this session, run after the session's
     * server is disposed. Note: this fires on MCP *session* close — do **not**
     * wipe long-lived identity here if you want it to survive a client reload.
     */
    readonly dispose?: () => void;
}

export interface McpSocketHostOptions {
    /** Display name used only for log lines. */
    readonly label?: string;
    /**
     * Mints per-session wiring. Called once per MCP `initialize`, before the
     * client's session id is acknowledged. The `sessionId` is the id the host
     * will report back to the client, so the owner can key identity on it (the
     * consumer-provisioned mode).
     */
    readonly createSession: (ctx: { readonly sessionId: string }) => Promise<McpSession>;
    /** Optional structured logger; defaults to a no-op. */
    readonly log?: (message: string) => void;
    /**
     * Where the host listens:
     * - `"socket"` (default): a local Unix domain socket / named pipe. Most
     *   private (no TCP port at all), but some MCP clients — notably the Copilot
     *   harness — don't support `unix`/`pipe` transports yet.
     * - `"http"`: a loopback (`127.0.0.1`) TCP port with a random bearer token.
     *   Use this until the socket transport is supported everywhere.
     */
    readonly transport?: "socket" | "http";
}

/**
 * Describes where the host is listening, as transport-level facts — not as any
 * particular client's URI encoding. A consumer (e.g. the VS Code extension)
 * translates this into whatever its MCP client expects; for VS Code that means a
 * `unix`/`pipe` URI with the socket path in `uri.path` and {@link requestPath}
 * in `uri.fragment`, but that encoding is the consumer's concern, not ours.
 */
export type McpSocketEndpoint =
    | {
          /**
           * `unixSocket` on posix, `namedPipe` on Windows. Discriminates how
           * {@link McpSocketEndpoint.path} is interpreted by the OS / an HTTP
           * client's `socketPath`.
           */
          readonly kind: "unixSocket" | "namedPipe";
          /**
           * Exact OS path the server listens on and that an HTTP client passes to
           * `socketPath`: a filesystem path for `unixSocket`, a `\\.\pipe\…` path
           * for `namedPipe`. Note a `namedPipe` path contains backslashes and is
           * therefore not representable as a URL string — keep it as-is rather
           * than round-tripping through `URL`/`Uri.parse`.
           */
          readonly path: string;
          /** HTTP request path the host serves (defaults to `/mcp`). */
          readonly requestPath: string;
          /** Bearer token the client must send in the `Authorization` header. */
          readonly authorizationToken: string;
      }
    | {
          /** A loopback TCP port, reachable over plain `http://`. */
          readonly kind: "tcp";
          /** Host the server is bound to (always `127.0.0.1`). */
          readonly host: string;
          /** TCP port the server listens on. */
          readonly port: number;
          /** HTTP request path the host serves (defaults to `/mcp`). */
          readonly requestPath: string;
          /** Bearer token the client must send in the `Authorization` header. */
          readonly authorizationToken: string;
      };

const REQUEST_PATH = "/mcp";

interface ActiveSession {
    readonly server: HubRpcMcpServer;
    readonly session: McpSession;
}

/**
 * Hosts one or more {@link HubRpcMcpServer} sessions over a local endpoint —
 * by default a Unix domain socket on posix / a named pipe on Windows, or, when
 * `transport: "http"` is set, a loopback (`127.0.0.1`) TCP port. The `http`
 * transport exists for clients that don't yet support the `unix`/`pipe`
 * transport (e.g. the Copilot harness).
 *
 * The host owns the generic plumbing: the socket/pipe or TCP port, bearer-token
 * auth, and the per-session Streamable HTTP transport lifecycle. *How* each
 * session reaches the hub — and what identity it signs as — is delegated
 * entirely to {@link McpSocketHostOptions.createSession}, so the same host serves
 * both the server-provisioned and consumer-provisioned identity modes.
 */
export class McpSocketHost {
    public static async start(options: McpSocketHostOptions): Promise<McpSocketHost> {
        const host = new McpSocketHost(options);
        await host._listen();
        return host;
    }

    private readonly _options: McpSocketHostOptions;
    private readonly _http: http.Server;
    private readonly _token = randomBytes(24).toString("base64url");
    private readonly _transport: "socket" | "http";
    private readonly _kind: McpSocketEndpoint["kind"];
    /** Set for the socket/pipe transport; the OS path we listen on. */
    private readonly _path: string | undefined;
    /** Loopback host for the TCP (`http`) transport. */
    private readonly _host = "127.0.0.1";
    /** Bound port for the TCP (`http`) transport; filled in after `_listen`. */
    private _port = 0;
    private readonly _transports = new Map<string, StreamableHTTPServerTransport>();
    private readonly _active = new Map<StreamableHTTPServerTransport, ActiveSession>();
    private _disposed = false;

    private constructor(options: McpSocketHostOptions) {
        this._options = options;
        this._http = http.createServer((req, res) => void this._handleHttp(req, res));
        this._transport = options.transport ?? "socket";
        if (this._transport === "http") {
            this._kind = "tcp";
            this._path = undefined;
        } else {
            this._kind = process.platform === "win32" ? "namedPipe" : "unixSocket";
            this._path =
                process.platform === "win32"
                    ? `\\\\.\\pipe\\hubrpc-mcp-${randomUUID()}`
                    : path.join(os.tmpdir(), `hubrpc-mcp-${randomUUID()}.sock`);
        }
    }

    /** The advertised endpoint (socket/pipe path or TCP host:port + bearer token). */
    public get endpoint(): McpSocketEndpoint {
        if (this._kind === "tcp") {
            return {
                kind: "tcp",
                host: this._host,
                port: this._port,
                requestPath: REQUEST_PATH,
                authorizationToken: this._token,
            };
        }
        return {
            kind: this._kind,
            path: this._path!,
            requestPath: REQUEST_PATH,
            authorizationToken: this._token,
        };
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        for (const { server, session } of this._active.values()) {
            server.dispose();
            session.dispose?.();
        }
        this._active.clear();
        this._transports.clear();
        this._http.close();
        // Node unlinks the Unix socket on graceful close; remove it best-effort
        // in case the server never fully started. Named pipes / TCP need no cleanup.
        if (this._kind === "unixSocket" && this._path) {
            fs.rm(this._path, { force: true }, () => {});
        }
    }

    private _log(message: string): void {
        this._options.log?.(this._options.label ? `[${this._options.label}] ${message}` : message);
    }

    private _listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            this._http.once("error", reject);
            const onListening = () => {
                this._http.removeListener("error", reject);
                if (this._kind === "tcp") {
                    const addr = this._http.address();
                    if (!addr || typeof addr === "string") {
                        reject(new Error("hubrpc-mcp: failed to bind loopback TCP port"));
                        return;
                    }
                    this._port = addr.port;
                    this._log(`listening on tcp ${this._host}:${this._port}`);
                } else {
                    this._log(`listening on ${this._kind} ${this._path}`);
                }
                resolve();
            };
            if (this._kind === "tcp") {
                this._http.listen(0, this._host, onListening);
            } else {
                this._http.listen(this._path!, onListening);
            }
        });
    }

    private async _handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!req.url || !req.url.startsWith(REQUEST_PATH)) {
            res.statusCode = 404;
            res.end();
            return;
        }
        if (req.headers.authorization !== `Bearer ${this._token}`) {
            this._log(`${req.method} ${req.url} → 401 (bad/missing auth)`);
            res.statusCode = 401;
            res.end();
            return;
        }

        const sessionHeader = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
        let transport = sessionId ? this._transports.get(sessionId) : undefined;

        if (!transport) {
            if (req.method !== "POST") {
                this._log(`${req.method} without known session id → 400 (only POST initialize starts a session)`);
                res.statusCode = 400;
                res.end();
                return;
            }
            transport = await this._openSession();
        }

        await transport.handleRequest(req, res);
    }

    private async _openSession(): Promise<StreamableHTTPServerTransport> {
        // The session id is fixed up front so `createSession` can key identity on
        // it (the consumer-provisioned mode) and the transport reports it back.
        const sessionId = randomUUID();
        const session = await this._options.createSession({ sessionId });
        const server = new HubRpcMcpServer(session.serverOptions);

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
            onsessioninitialized: (sid) => {
                this._transports.set(sid, transport);
                this._log(`session initialized sid=${sid}`);
            },
        });
        this._active.set(transport, { server, session });

        transport.onclose = () => {
            if (transport.sessionId) {
                this._transports.delete(transport.sessionId);
                this._log(`session closed sid=${transport.sessionId}`);
            }
            this._active.delete(transport);
            // Dispose the server (tears down its connection pool / in-process leg)
            // before the session's own teardown.
            server.dispose();
            session.dispose?.();
        };

        await server.connect(transport);
        return transport;
    }
}
