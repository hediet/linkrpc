import { createInterface } from 'node:readline';
import {
    LinkRpcConnection,
    RpcError,
    TransportPair,
    type InterfaceDefinition,
    type JsonValue,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
    type MemberMap,
    type MethodSchema,
    type PrincipalWithStore,
} from '@hediet/linkrpc';
import { isHubEndpoint, parseEndpointUri } from '@hediet/linkrpc/node';
import {
    hostParticipant,
    ParticipantServices,
    type ParticipantHostOptions,
} from '@hediet/linkrpc-hub/participant-host';
import {
    connect as connectEndpoint,
    connectViaTransport,
    parsePrincipalSpec,
    setupSigning,
    type ResolvedEndpoint,
} from '@hediet/linkrpc-client-internal';
import { resolveLocalEndpoint } from './localEndpoint';
import { formatJson, readParamsArg } from './output';
import { mergeParams } from './paramParsing';
import { explainValidation } from './validation';

/** Extract the result type of a request member without depending on `RequestType`'s full generic arity. */
type RequestResultOf<M> = M extends { readonly kind: 'request'; readonly _result: infer TResult } ? TResult : never;

export interface ServiceCliInterface<
    T extends InterfaceDefinition<MemberMap> = InterfaceDefinition<MemberMap>,
> {
    readonly interface: T;
    /** Subcommand group name when exposing multiple interfaces (e.g. `'pipelines'`). */
    readonly command?: string;
    /**
     * Fill missing parameters before validation. `paramNames` is the exact set of
     * top-level parameter names declared by the target method's schema.
     */
    readonly fillParams?: (
        params: Record<string, unknown>,
        meta: { readonly method: string; readonly paramNames: ReadonlySet<string> },
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    /** Optional TTY formatters per method. Piped stdout or `--json` always prints JSON. */
    readonly formatResult?: {
        readonly [K in keyof T['members'] as T['members'][K] extends { readonly kind: 'request' } ? K : never]?: (
            result: RequestResultOf<T['members'][K]>,
        ) => string;
    };
}

/** Type-inference helper so `formatResult` callbacks receive each method's exact result type. */
export function defineServiceCliInterface<T extends InterfaceDefinition<MemberMap>>(
    spec: ServiceCliInterface<T>,
): ServiceCliInterface<T> {
    return spec;
}

export interface ServiceCliChannel {
    sendRequestWithStream<TResult = JsonValue>(
        method: string,
        params: unknown,
        options?: {
            readonly onStreamMessage?: (payload: JsonValue) => void;
            readonly interfaceHash?: string;
        },
    ): { readonly result: Promise<TResult> };
    sendNotification(method: string, params: unknown): Promise<void>;
}

export interface ServiceCliContext {
    /** Remote service ID when running against a hub (`--remote-service`), or `undefined` in direct mode. */
    readonly remoteServiceId: string | undefined;
    readonly channel: ServiceCliChannel;
    readonly json: boolean;
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
}

export interface ServiceCliConnection {
    readonly channel: ServiceCliChannel;
    readonly signed?: boolean;
    close(): void | Promise<void>;
}

export interface ServiceCliConnectOptions {
    readonly remoteServiceId?: string;
    readonly endpoint?: string;
    readonly principal?: string;
    readonly sign: boolean;
}

export interface ServiceAppSetupContext {
    /** `'direct'` for an in-process CLI invocation; `'serve'` when hosted as a LinkRPC participant. */
    readonly mode: 'direct' | 'serve';
    /** Remaining CLI arguments passed to `serve` (empty in direct mode). */
    readonly argv: readonly string[];
    readonly connection: LinkRpcConnection;
    readonly services: ParticipantServices;
    readonly serviceId: string | undefined;
    readonly principal: PrincipalWithStore | undefined;
    readonly signal: AbortSignal;
}

export type ServiceAppCleanup = void | { dispose(): void } | AsyncDisposable;

export interface ServiceAppHostOptions
    extends Omit<ParticipantHostOptions, 'setup' | 'registrationMode'> {
    readonly registrationMode?: ParticipantHostOptions['registrationMode'];
}

export interface ServiceAppOptions {
    readonly name: string;
    readonly description?: string;
    readonly interfaces: readonly ServiceCliInterface[];
    /**
     * Registers handlers for the app's interfaces. Called in direct CLI mode and in serve mode;
     * NOT called for `--help` or remote mode (`--remote-service` / `--endpoint`).
     */
    readonly setup: (context: ServiceAppSetupContext) => ServiceAppCleanup | Promise<ServiceAppCleanup>;
    /** Extra local subcommands (e.g. a TUI like `watch-run`). Works in both direct and remote mode. */
    readonly extraCommands?: Readonly<Record<string, (args: readonly string[], ctx: ServiceCliContext) => Promise<void>>>;
    /** Options forwarded to `hostParticipant` in serve mode (`registrationMode` defaults to `'all'`). */
    readonly hostOptions?: ServiceAppHostOptions | ((argv: readonly string[]) => ServiceAppHostOptions);
    /** Called once `hostParticipant` is bound in serve mode (useful for logging or tests). */
    readonly onServeReady?: (handle: { readonly endpoint: string; dispose(): Promise<void> }) => void;
    /** Override hub hosting in serve mode (mainly for tests). */
    readonly serve?: (argv: readonly string[]) => Promise<void>;
    /** Override remote connection in `--remote-service` / `--endpoint` mode (mainly for tests). */
    readonly connect?: (opts: ServiceCliConnectOptions) => Promise<ServiceCliConnection>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stdin?: NodeJS.ReadableStream;
    readonly stdout?: NodeJS.WritableStream;
    readonly stderr?: NodeJS.WritableStream;
    readonly isTty?: boolean;
}

/**
 * Unified entry point for a LinkRPC service, CLI, and stdio MCP server:
 * - **Serve mode** when `argv[0] === 'serve'` (supports `LINKRPC_ENDPOINT` or `--listen <ws://...> --token <secret>`).
 * - **MCP stdio mode** when `argv[0] === 'mcp'` (or `--remote-service <id> mcp`).
 * - **Remote CLI mode** when `--remote-service <id>`, `LINKRPC_REMOTE_SERVICE`, or `--endpoint <uri>`
 *   is provided: skips `setup` and calls the remote service over LinkRPC.
 * - **Direct CLI mode (default)** otherwise: runs `setup` in-process over a `TransportPair`,
 *   validates parameters locally, invokes the handler, and disposes cleanup on exit.
 */
export async function runServiceApp(
    options: ServiceAppOptions,
    argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
    const env = options.env ?? process.env;
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const isTty = options.isTty ?? (stdout === process.stdout && process.stdout.isTTY === true);

    if (argv[0] === 'serve') {
        await _runServe(options, argv.slice(1), stderr);
        return;
    }

    const cliArgv = argv[0] === '--cli' ? argv.slice(1) : argv;
    const parsed = _parseTopLevel(cliArgv, options, env);
    if (parsed.kind === 'help') {
        stdout.write(parsed.text);
        return;
    }
    if (parsed.kind === 'mcp') {
        await _runMcpStdio(options, parsed.connOpts, options.stdin ?? process.stdin, stdout);
        return;
    }
    if (parsed.kind === 'extra') {
        await _withTargetConnection(options, parsed.connOpts, async conn => {
            await parsed.handler(parsed.args, {
                remoteServiceId: parsed.connOpts.remoteServiceId,
                channel: conn.channel,
                json: parsed.json,
                stdout,
                stderr,
            });
        });
        return;
    }

    const { spec, schema, methodName, methodSchema, rawMethodArgs, json, connOpts } = parsed;
    if (rawMethodArgs.includes('--help') || rawMethodArgs.includes('-h')) {
        stdout.write(_renderMethodHelp(options.name, spec, schema, methodName, methodSchema));
        return;
    }

    const { paramSchema, paramNames } = _inspectParams(methodSchema, schema);
    const { baseParams, overrides } = _parseMethodFlags(rawMethodArgs, paramSchema, schema.components?.schemas ?? {}, paramNames);
    let params = mergeParams({ base: baseParams, overrides }) ?? {};

    if (spec.fillParams !== undefined && _isPlainObject(params)) {
        params = await spec.fillParams({ ...params }, { method: methodName, paramNames });
    }

    const issues = explainValidation(params, methodSchema.params, schema.components?.schemas ?? {});
    if (issues.length > 0) {
        const lines = ['Parameter validation failed:'];
        for (const issue of issues) {
            lines.push(`  ${issue.path || '(root)'}: ${issue.reason}`);
        }
        throw new Error(lines.join('\n'));
    }

    const wireMethod = connOpts.remoteServiceId !== undefined
        ? `${connOpts.remoteServiceId}::${schema.id}::${methodName}`
        : `${schema.id}::${methodName}`;

    await _withTargetConnection(options, connOpts, async conn => {
        try {
            if (methodSchema.result === undefined) {
                await conn.channel.sendNotification(wireMethod, params as never);
                return;
            }
            const call = conn.channel.sendRequestWithStream(wireMethod, params as never, {
                onStreamMessage: chunk => _writeStreamChunk(stderr, chunk),
                ...(conn.signed === true ? { interfaceHash: schema.hash } : {}),
            });
            const result = await call.result;
            const formatter = (spec.formatResult as Record<string, ((v: unknown) => string) | undefined> | undefined)?.[methodName];
            const text = !json && isTty && formatter !== undefined
                ? formatter(result)
                : formatJson(result);
            stdout.write(text.endsWith('\n') ? text : `${text}\n`);
        } catch (err) {
            if (err instanceof RpcError) {
                const detail = err.data !== undefined ? `\n${formatJson(err.data)}` : '';
                throw new Error(`RPC error (${err.code}): ${err.message}${detail}`);
            }
            throw err;
        }
    });
}

// ---------------------------------------------------------------------------
// Serve, direct in-process, and remote connections
// ---------------------------------------------------------------------------

async function _runServe(
    options: ServiceAppOptions,
    serveArgv: readonly string[],
    stderr: NodeJS.WritableStream,
): Promise<void> {
    if (options.serve !== undefined) {
        await options.serve(serveArgv);
        return;
    }
    const { rest, listen, token } = _extractServeFlags(serveArgv);
    const resolvedHostOptions = typeof options.hostOptions === 'function'
        ? options.hostOptions(rest)
        : options.hostOptions;
    const listenEndpoint = listen !== undefined
        ? {
            endpoint: listen.startsWith('listen:') ? listen : `listen:${listen}`,
            ...(token !== undefined ? { token } : {}),
        }
        : undefined;
    const host = await hostParticipant({
        registrationMode: 'all',
        ...resolvedHostOptions,
        ...(listenEndpoint !== undefined ? { endpoint: listenEndpoint } : {}),
        setup: async hostCtx => {
            const cleanup = await options.setup({
                mode: 'serve',
                argv: rest,
                connection: hostCtx.connection,
                services: hostCtx.services,
                serviceId: hostCtx.serviceId,
                principal: hostCtx.principal,
                signal: hostCtx.signal,
            });
            hostCtx.connection.enableReflection();
            if (hostCtx.serviceId !== undefined) {
                hostCtx.connection.enableReflection({ serviceId: hostCtx.serviceId });
            }
            return cleanup;
        },
    });
    if (listen !== undefined) {
        stderr.write(`${options.name}: listening on ${host.endpoint}\n`);
    }
    options.onServeReady?.(host);
    await host.done;
}

function _extractServeFlags(argv: readonly string[]): {
    readonly rest: string[];
    readonly listen?: string;
    readonly token?: string;
} {
    let listen: string | undefined;
    let token: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const valueFlag = _readValueFlag(argv, i, ['--listen', '--token']);
        if (valueFlag !== undefined) {
            if (valueFlag.flag === '--listen') listen = valueFlag.value;
            else if (valueFlag.flag === '--token') token = valueFlag.value;
            i = valueFlag.nextIndex;
            continue;
        }
        rest.push(argv[i]!);
    }
    return { rest, listen, token };
}

async function _withTargetConnection<T>(
    options: ServiceAppOptions,
    connOpts: ServiceCliConnectOptions,
    fn: (conn: ServiceCliConnection) => Promise<T>,
): Promise<T> {
    const isRemote = connOpts.remoteServiceId !== undefined || connOpts.endpoint !== undefined;
    const conn = isRemote
        ? (options.connect !== undefined ? await options.connect(connOpts) : await _connectRemote(connOpts))
        : await _connectDirect(options);
    try {
        return await fn(conn);
    } finally {
        await conn.close();
    }
}

async function _connectDirect(options: ServiceAppOptions): Promise<ServiceCliConnection> {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    const services = new ParticipantServices(server, 'root', undefined);
    const abort = new AbortController();
    let cleanup: ServiceAppCleanup = undefined;
    let client: ReturnType<typeof connectViaTransport> | undefined;

    const closeAll = async () => {
        abort.abort();
        client?.close();
        try {
            if (cleanup && Symbol.asyncDispose in cleanup) {
                await cleanup[Symbol.asyncDispose]();
            } else if (cleanup) {
                cleanup.dispose();
            }
        } finally {
            services.dispose();
            server.close();
        }
    };

    try {
        cleanup = await options.setup({
            mode: 'direct',
            argv: [],
            connection: server,
            services,
            serviceId: undefined,
            principal: undefined,
            signal: abort.signal,
        });
        server.enableReflection();
        client = connectViaTransport(pair.a);
        return { channel: client.channel, close: closeAll };
    } catch (err) {
        await closeAll();
        throw err;
    }
}

async function _connectRemote(opts: ServiceCliConnectOptions): Promise<ServiceCliConnection> {
    const endpoint: ResolvedEndpoint = opts.endpoint !== undefined
        ? parseEndpointUri(opts.endpoint)
        : resolveLocalEndpoint();
    const conn = await connectEndpoint(endpoint);
    try {
        if (!opts.sign) {
            return { channel: conn.channel, close: () => conn.close() };
        }
        const principalSpec = parsePrincipalSpec(opts.principal);
        await setupSigning(conn.channel, conn.signing, principalSpec, {
            negotiateHubCaps: isHubEndpoint(endpoint),
            autoNegotiatePerCall: true,
        });
        return { channel: conn.channel, signed: true, close: () => conn.close() };
    } catch (err) {
        conn.close();
        throw err;
    }
}

function _writeStreamChunk(stderr: NodeJS.WritableStream, payload: JsonValue): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    stderr.write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Command routing & flag parsing
// ---------------------------------------------------------------------------

type ParsedInvocation =
    | { readonly kind: 'help'; readonly text: string }
    | { readonly kind: 'mcp'; readonly connOpts: ServiceCliConnectOptions }
    | {
        readonly kind: 'extra';
        readonly handler: (args: readonly string[], ctx: ServiceCliContext) => Promise<void>;
        readonly args: readonly string[];
        readonly json: boolean;
        readonly connOpts: ServiceCliConnectOptions;
    }
    | {
        readonly kind: 'method';
        readonly spec: ServiceCliInterface;
        readonly schema: LinkRpcInterfaceSchema;
        readonly methodName: string;
        readonly methodSchema: MethodSchema;
        readonly rawMethodArgs: readonly string[];
        readonly json: boolean;
        readonly connOpts: ServiceCliConnectOptions;
    };

function _parseTopLevel(
    argv: readonly string[],
    options: ServiceAppOptions,
    env: Readonly<Record<string, string | undefined>>,
): ParsedInvocation {
    const { rest, remoteServiceId, json, endpoint, principal, sign } = _extractGlobalFlags(argv, env);
    const connOpts: ServiceCliConnectOptions = { remoteServiceId, endpoint, principal, sign };
    const flatSingle = options.interfaces.length === 1 && options.interfaces[0]!.command === undefined;

    if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
        return { kind: 'help', text: _renderRootHelp(options, flatSingle) };
    }

    const first = rest[0]!;
    if (first === 'mcp') {
        return { kind: 'mcp', connOpts };
    }
    const extraHandler = options.extraCommands?.[first];
    if (extraHandler !== undefined) {
        return { kind: 'extra', handler: extraHandler, args: rest.slice(1), json, connOpts };
    }

    if (flatSingle) {
        const spec = options.interfaces[0]!;
        const schema = spec.interface.toSchema();
        const methodName = _resolveMethodName(first, schema);
        return {
            kind: 'method',
            spec,
            schema,
            methodName,
            methodSchema: schema.methods[methodName]!,
            rawMethodArgs: rest.slice(1),
            json,
            connOpts,
        };
    }

    const spec = _resolveGroup(first, options.interfaces, options.extraCommands);
    const schema = spec.interface.toSchema();
    const afterGroup = rest.slice(1);
    if (afterGroup.length === 0 || afterGroup[0] === '--help' || afterGroup[0] === '-h') {
        return { kind: 'help', text: _renderGroupHelp(options.name, spec, schema) };
    }

    const methodName = _resolveMethodName(afterGroup[0]!, schema);
    return {
        kind: 'method',
        spec,
        schema,
        methodName,
        methodSchema: schema.methods[methodName]!,
        rawMethodArgs: afterGroup.slice(1),
        json,
        connOpts,
    };
}

function _extractGlobalFlags(
    argv: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
): {
    readonly rest: string[];
    readonly remoteServiceId?: string;
    readonly json: boolean;
    readonly endpoint?: string;
    readonly principal?: string;
    readonly sign: boolean;
} {
    let remoteServiceId: string | undefined = env.LINKRPC_REMOTE_SERVICE?.trim() || undefined;
    let json = false;
    let endpoint: string | undefined;
    let principal: string | undefined;
    let sign = true;
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i]!;
        if (tok === '--') {
            rest.push(...argv.slice(i));
            break;
        }
        if (tok === '--json') {
            json = true;
            continue;
        }
        if (tok === '--no-sign') {
            sign = false;
            continue;
        }
        const valueFlag = _readValueFlag(argv, i, ['--remote-service', '--endpoint', '--principal']);
        if (valueFlag !== undefined) {
            if (valueFlag.flag === '--remote-service') remoteServiceId = valueFlag.value;
            else if (valueFlag.flag === '--endpoint') endpoint = valueFlag.value;
            else if (valueFlag.flag === '--principal') principal = valueFlag.value;
            i = valueFlag.nextIndex;
            continue;
        }
        rest.push(tok);
    }
    return { rest, remoteServiceId, json, endpoint, principal, sign };
}

function _readValueFlag(
    argv: readonly string[],
    index: number,
    names: readonly string[],
): { readonly flag: string; readonly value: string; readonly nextIndex: number } | undefined {
    const tok = argv[index]!;
    for (const name of names) {
        if (tok === name) {
            const value = argv[index + 1];
            if (value === undefined) throw new Error(`${name} requires a value.`);
            return { flag: name, value, nextIndex: index + 1 };
        }
        if (tok.startsWith(`${name}=`)) {
            return { flag: name, value: tok.slice(name.length + 1), nextIndex: index };
        }
    }
    return undefined;
}

function _parseMethodFlags(
    args: readonly string[],
    paramSchema: LinkRpcJsonSchema | undefined,
    components: Record<string, LinkRpcJsonSchema>,
    paramNames: ReadonlySet<string>,
): { readonly baseParams: unknown; readonly overrides: string[] } {
    let baseParams: unknown;
    const overrides: string[] = [];
    const byNormalized = new Map<string, string>();
    for (const name of paramNames) {
        byNormalized.set(_normalizeKey(name), name);
    }

    for (let i = 0; i < args.length; i++) {
        const tok = args[i]!;
        if (tok === '--') break;

        if (tok === '--params' || tok.startsWith('--params=')) {
            const raw = tok === '--params' ? args[++i] : tok.slice('--params='.length);
            if (raw === undefined) throw new Error('--params requires a JSON value or "-".');
            baseParams = readParamsArg(raw);
            continue;
        }
        if (tok === '--param' || tok.startsWith('--param=')) {
            const raw = tok === '--param' ? args[++i] : tok.slice('--param='.length);
            if (raw === undefined) throw new Error('--param requires key=value.');
            overrides.push(raw);
            continue;
        }
        if (!tok.startsWith('--')) {
            throw new Error(`Unexpected positional argument "${tok}". Pass parameters as --<name> <value>.`);
        }

        const rawKeyVal = tok.startsWith('--p:') ? tok.slice('--p:'.length) : tok.slice(2);
        const eq = rawKeyVal.indexOf('=');
        const rawKey = eq >= 0 ? rawKeyVal.slice(0, eq) : rawKeyVal;
        const resolvedKey = _resolveParamPath(rawKey, byNormalized, paramSchema, components, paramNames);

        if (eq >= 0) {
            overrides.push(`${resolvedKey}=${rawKeyVal.slice(eq + 1)}`);
            continue;
        }
        const next = args[i + 1];
        if (next === undefined || next.startsWith('-')) {
            overrides.push(`${resolvedKey}=true`);
            continue;
        }
        overrides.push(`${resolvedKey}=${next}`);
        i++;
    }

    return { baseParams, overrides };
}

function _resolveParamPath(
    rawPath: string,
    topByNormalized: ReadonlyMap<string, string>,
    rootSchema: LinkRpcJsonSchema | undefined,
    components: Record<string, LinkRpcJsonSchema>,
    topNames: ReadonlySet<string>,
): string {
    const segments = rawPath.split('.');
    const head = topByNormalized.get(_normalizeKey(segments[0]!));
    if (head === undefined) {
        const suggestion = _closest(segments[0]!, [...topNames].map(_toKebab));
        const hint = suggestion ? ` Did you mean --${suggestion}?` : '';
        throw new Error(`Unknown option "--${rawPath}".${hint}`);
    }
    if (segments.length === 1) return head;

    const resolved = [head];
    let cursor = _propertySchema(rootSchema, head, components);
    for (let s = 1; s < segments.length; s++) {
        const seg = segments[s]!;
        const props = _objectProperties(cursor, components);
        if (props === undefined) {
            resolved.push(seg);
            cursor = undefined;
            continue;
        }
        const match = Object.keys(props).find(k => _normalizeKey(k) === _normalizeKey(seg));
        resolved.push(match ?? seg);
        cursor = match !== undefined ? _resolveRef(props[match]!, components) : undefined;
    }
    return resolved.join('.');
}

function _resolveGroup(
    raw: string,
    interfaces: readonly ServiceCliInterface[],
    extraCommands?: Readonly<Record<string, unknown>>,
): ServiceCliInterface {
    const norm = _normalizeKey(raw);
    for (const spec of interfaces) {
        const name = _groupName(spec);
        if (_normalizeKey(name) === norm || _normalizeKey(spec.interface.info.id) === norm) {
            return spec;
        }
    }
    const candidates = [...interfaces.map(_groupName), ...Object.keys(extraCommands ?? {}), 'serve'];
    const suggestion = _closest(raw, candidates);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
    throw new Error(`Unknown command "${raw}".${hint}`);
}

function _resolveMethodName(raw: string, schema: LinkRpcInterfaceSchema): string {
    const names = Object.keys(schema.methods);
    if (names.includes(raw)) return raw;
    const norm = _normalizeKey(raw);
    const match = names.find(n => _normalizeKey(n) === norm);
    if (match !== undefined) return match;
    const suggestion = _closest(raw, names.map(_toKebab));
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
    throw new Error(`Unknown method "${raw}" on ${schema.id}.${hint}`);
}

function _groupName(spec: ServiceCliInterface): string {
    if (spec.command !== undefined) return spec.command;
    const id = spec.interface.info.id;
    const dot = id.lastIndexOf('.');
    return dot >= 0 ? id.slice(dot + 1) : id;
}

// ---------------------------------------------------------------------------
// Help rendering (offline, from InterfaceDefinition)
// ---------------------------------------------------------------------------

function _renderRootHelp(options: ServiceAppOptions, flatSingle: boolean): string {
    const lines: string[] = [];
    lines.push(options.description ? `${options.name} — ${options.description}` : options.name);
    lines.push('');
    lines.push('USAGE');
    lines.push(flatSingle
        ? `  ${options.name} <command> [options]`
        : `  ${options.name} <group> <command> [options]`);
    lines.push(`  ${options.name} serve [serve-options]`);
    lines.push(`  ${options.name} mcp`);
    lines.push('');

    if (flatSingle) {
        const schema = options.interfaces[0]!.interface.toSchema();
        lines.push('COMMANDS');
        lines.push(..._formatMethodRows(schema));
    } else {
        lines.push('GROUPS');
        const rows = options.interfaces.map(spec => {
            const schema = spec.interface.toSchema();
            return [_groupName(spec), schema.description ?? schema.id];
        });
        lines.push(..._formatTwoCol(rows));
    }

    const extraNames = Object.keys(options.extraCommands ?? {});
    if (extraNames.length > 0) {
        lines.push('');
        lines.push('EXTRA COMMANDS');
        for (const name of extraNames) lines.push(`  ${name}`);
    }

    lines.push('');
    lines.push('GLOBAL OPTIONS');
    lines.push(..._formatTwoCol([
        ['--remote-service <id>', 'Call a remote hub service instead of running locally (env: LINKRPC_REMOTE_SERVICE)'],
        ['--endpoint <uri>', 'Remote LinkRPC endpoint URI (implies remote mode)'],
        ['--principal <spec>', 'Signing principal override for remote calls'],
        ['--json', 'Print raw JSON output'],
        ['--params <json|->', 'Base JSON params object (or "-" for stdin)'],
        ['-h, --help', 'Show help'],
    ]));
    return `${lines.join('\n')}\n`;
}

function _renderGroupHelp(appName: string, spec: ServiceCliInterface, schema: LinkRpcInterfaceSchema): string {
    const group = _groupName(spec);
    const lines: string[] = [];
    lines.push(`${appName} ${group} (${schema.id})`);
    if (schema.description) lines.push(schema.description);
    lines.push('');
    lines.push('USAGE');
    lines.push(`  ${appName} ${group} <method> [options]`);
    lines.push('');
    lines.push('METHODS');
    lines.push(..._formatMethodRows(schema));
    lines.push('');
    lines.push(`Run "${appName} ${group} <method> --help" for method parameters.`);
    return `${lines.join('\n')}\n`;
}

function _renderMethodHelp(
    appName: string,
    spec: ServiceCliInterface,
    schema: LinkRpcInterfaceSchema,
    methodName: string,
    methodSchema: MethodSchema,
): string {
    const cmd = spec.command !== undefined ? `${appName} ${_groupName(spec)} ${_toKebab(methodName)}` : `${appName} ${_toKebab(methodName)}`;
    const tags = _formatAnnotations(methodSchema);
    const lines: string[] = [];
    lines.push(`${cmd}${tags ? `  ${tags}` : ''}`);
    if (methodSchema.description) lines.push(methodSchema.description);
    lines.push('');

    const components = schema.components?.schemas ?? {};
    const resolved = _resolveRef(methodSchema.params, components);
    const props = _objectProperties(resolved, components);
    if (props === undefined) {
        lines.push('PARAMETERS');
        lines.push('  (pass with --params <json>)');
        return `${lines.join('\n')}\n`;
    }

    const required = new Set<string>(
        typeof resolved === 'object' && resolved !== null && Array.isArray((resolved as { required?: unknown }).required)
            ? (resolved as { required: string[] }).required
            : [],
    );
    const names = Object.keys(props);
    lines.push('PARAMETERS');
    if (names.length === 0) {
        lines.push('  (none)');
    } else {
        const rows = names.map(name => {
            const prop = _resolveRef(props[name]!, components);
            const flag = `--${_toKebab(name)} <${_typeLabel(prop)}>`;
            const req = required.has(name) ? 'required' : 'optional';
            const desc = _descriptionOf(prop);
            return [flag, `${req}${desc ? `  ${desc}` : ''}`];
        });
        lines.push(..._formatTwoCol(rows));
    }
    return `${lines.join('\n')}\n`;
}

function _formatMethodRows(schema: LinkRpcInterfaceSchema): string[] {
    const rows = Object.entries(schema.methods).map(([name, m]) => {
        const tags = _formatAnnotations(m);
        const desc = [tags, m.description].filter(Boolean).join(' ');
        return [_toKebab(name), desc];
    });
    return _formatTwoCol(rows);
}

function _formatAnnotations(m: MethodSchema): string {
    const a = m.annotations;
    if (!a) return '';
    const tags: string[] = [];
    if (a.readOnly) tags.push('readOnly');
    if (a.dangerous) tags.push('dangerous');
    if (a.idempotent && !a.readOnly) tags.push('idempotent');
    if (a.expensive) tags.push('expensive');
    return tags.length > 0 ? `[${tags.join(', ')}]` : '';
}

function _formatTwoCol(rows: readonly (readonly [string, string])[]): string[] {
    if (rows.length === 0) return [];
    const width = Math.max(...rows.map(r => r[0].length));
    return rows.map(([left, right]) => `  ${left.padEnd(width)}${right ? `  ${right}` : ''}`);
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function _inspectParams(
    methodSchema: MethodSchema,
    schema: LinkRpcInterfaceSchema,
): { readonly paramSchema: LinkRpcJsonSchema; readonly paramNames: ReadonlySet<string> } {
    const components = schema.components?.schemas ?? {};
    const paramSchema = _resolveRef(methodSchema.params, components);
    const props = _objectProperties(paramSchema, components);
    return { paramSchema, paramNames: new Set(props ? Object.keys(props) : []) };
}

function _resolveRef(s: LinkRpcJsonSchema, components: Record<string, LinkRpcJsonSchema>): LinkRpcJsonSchema {
    if (typeof s === 'object' && s !== null && '$ref' in s) {
        const m = /^#\/components\/schemas\/(.+)$/.exec((s as { $ref: string }).$ref);
        if (m && components[m[1]!] !== undefined) return components[m[1]!]!;
    }
    return s;
}

function _objectProperties(
    s: LinkRpcJsonSchema | undefined,
    components: Record<string, LinkRpcJsonSchema>,
): Record<string, LinkRpcJsonSchema> | undefined {
    if (s === undefined) return undefined;
    const resolved = _resolveRef(s, components);
    if (typeof resolved !== 'object' || resolved === null) return undefined;
    if ((resolved as { type?: unknown }).type !== 'object') return undefined;
    return (resolved as { properties?: Record<string, LinkRpcJsonSchema> }).properties ?? {};
}

function _propertySchema(
    s: LinkRpcJsonSchema | undefined,
    key: string,
    components: Record<string, LinkRpcJsonSchema>,
): LinkRpcJsonSchema | undefined {
    const props = _objectProperties(s, components);
    return props?.[key] !== undefined ? _resolveRef(props[key]!, components) : undefined;
}

function _typeLabel(s: LinkRpcJsonSchema): string {
    if (s === true) return 'any';
    if (s === false) return 'never';
    const obj = s as unknown as Record<string, unknown>;
    if (typeof obj.type === 'string') {
        if (obj.type === 'array' && obj.items !== undefined) {
            return `${_typeLabel(obj.items as LinkRpcJsonSchema)}[]`;
        }
        return obj.type;
    }
    if (Array.isArray(obj.enum)) return obj.enum.map(v => String(v)).join('|');
    if (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf)) return 'union';
    return 'value';
}

function _descriptionOf(s: LinkRpcJsonSchema): string {
    if (typeof s !== 'object' || s === null) return '';
    const desc = (s as { description?: unknown }).description;
    return typeof desc === 'string' ? desc.replace(/\s+/g, ' ').trim() : '';
}

function _isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Naming & suggestions
// ---------------------------------------------------------------------------

function _toKebab(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function _normalizeKey(name: string): string {
    return name.replace(/-/g, '').toLowerCase();
}

function _closest(input: string, candidates: readonly string[]): string | undefined {
    let best: { value: string; dist: number } | undefined;
    const normInput = _normalizeKey(input);
    for (const candidate of candidates) {
        const dist = _levenshtein(normInput, _normalizeKey(candidate));
        if (best === undefined || dist < best.dist) best = { value: candidate, dist };
    }
    return best !== undefined && best.dist <= Math.max(2, Math.floor(normInput.length / 2)) ? best.value : undefined;
}

function _levenshtein(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1]!
                : 1 + Math.min(prev[j]!, cur[j - 1]!, prev[j - 1]!);
        }
        prev = cur;
    }
    return prev[b.length]!;
}

// ---------------------------------------------------------------------------
// Stdio MCP server (`<app> mcp`)
// ---------------------------------------------------------------------------

interface McpToolEntry {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations?: {
        readonly readOnlyHint?: boolean;
        readonly destructiveHint?: boolean;
        readonly idempotentHint?: boolean;
    };
    readonly spec: ServiceCliInterface;
    readonly schema: LinkRpcInterfaceSchema;
    readonly methodName: string;
    readonly methodSchema: MethodSchema;
}

function _buildMcpTools(options: ServiceAppOptions): Map<string, McpToolEntry> {
    const flatSingle = options.interfaces.length === 1 && options.interfaces[0]!.command === undefined;
    const tools = new Map<string, McpToolEntry>();
    for (const spec of options.interfaces) {
        const schema = spec.interface.toSchema();
        const prefix = flatSingle ? '' : `${_groupName(spec)}_`;
        const components = schema.components?.schemas ?? {};
        for (const [methodName, methodSchema] of Object.entries(schema.methods)) {
            if (methodSchema.result === undefined) continue;
            const name = `${prefix}${methodName}`;
            const inputSchema = _toMcpInputSchema(methodSchema.params, components);
            const a = methodSchema.annotations;
            const annotations = a !== undefined ? {
                ...(a.readOnly !== undefined ? { readOnlyHint: a.readOnly } : {}),
                ...(a.dangerous !== undefined ? { destructiveHint: a.dangerous } : a.readOnly ? { destructiveHint: false } : {}),
                ...(a.idempotent !== undefined ? { idempotentHint: a.idempotent } : a.readOnly ? { idempotentHint: true } : {}),
            } : undefined;
            tools.set(name, {
                name,
                ...(methodSchema.description !== undefined ? { description: methodSchema.description } : {}),
                inputSchema,
                ...(annotations !== undefined && Object.keys(annotations).length > 0 ? { annotations } : {}),
                spec,
                schema,
                methodName,
                methodSchema,
            });
        }
    }
    return tools;
}

function _toMcpInputSchema(
    paramsSchema: LinkRpcJsonSchema,
    components: Record<string, LinkRpcJsonSchema>,
): Record<string, unknown> {
    const resolved = _inlineRefs(paramsSchema, components, new Set());
    if (typeof resolved === 'object' && resolved !== null && (resolved as { type?: unknown }).type === 'object') {
        return resolved as Record<string, unknown>;
    }
    return { type: 'object', properties: {} };
}

function _inlineRefs(
    node: unknown,
    components: Record<string, LinkRpcJsonSchema>,
    seen: ReadonlySet<string>,
): unknown {
    if (Array.isArray(node)) {
        return node.map(item => _inlineRefs(item, components, seen));
    }
    if (typeof node !== 'object' || node === null) return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
        const m = /^#\/components\/schemas\/(.+)$/.exec(obj.$ref);
        if (m && components[m[1]!] !== undefined && !seen.has(m[1]!)) {
            const nextSeen = new Set(seen);
            nextSeen.add(m[1]!);
            return _inlineRefs(components[m[1]!], components, nextSeen);
        }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = _inlineRefs(v, components, seen);
    }
    return out;
}

async function _runMcpStdio(
    options: ServiceAppOptions,
    connOpts: ServiceCliConnectOptions,
    stdin: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
): Promise<void> {
    const tools = _buildMcpTools(options);
    const writeMsg = (msg: Record<string, unknown>) => {
        stdout.write(`${JSON.stringify(msg)}\n`);
    };

    await _withTargetConnection(options, connOpts, async conn => {
        const rl = createInterface({ input: stdin, crlfDelay: Infinity });
        try {
            for await (const rawLine of rl) {
                const line = rawLine.trim();
                if (line === '') continue;
                let req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
                try {
                    req = JSON.parse(line) as typeof req;
                } catch {
                    writeMsg({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
                    continue;
                }
                const hasId = req.id !== undefined;
                if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
                    continue;
                }
                if (req.method === 'initialize') {
                    if (hasId) {
                        writeMsg({
                            jsonrpc: '2.0',
                            id: req.id,
                            result: {
                                protocolVersion: typeof req.params?.protocolVersion === 'string'
                                    ? req.params.protocolVersion
                                    : '2025-03-26',
                                capabilities: { tools: {} },
                                serverInfo: { name: options.name, version: '0.1.0' },
                            },
                        });
                    }
                    continue;
                }
                if (req.method === 'ping') {
                    if (hasId) writeMsg({ jsonrpc: '2.0', id: req.id, result: {} });
                    continue;
                }
                if (req.method === 'tools/list') {
                    if (hasId) {
                        writeMsg({
                            jsonrpc: '2.0',
                            id: req.id,
                            result: {
                                tools: [...tools.values()].map(t => ({
                                    name: t.name,
                                    ...(t.description !== undefined ? { description: t.description } : {}),
                                    inputSchema: t.inputSchema,
                                    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
                                })),
                            },
                        });
                    }
                    continue;
                }
                if (req.method === 'tools/call') {
                    const toolName = typeof req.params?.name === 'string' ? req.params.name : '';
                    const entry = tools.get(toolName);
                    if (entry === undefined) {
                        if (hasId) {
                            writeMsg({
                                jsonrpc: '2.0',
                                id: req.id,
                                result: { isError: true, content: [{ type: 'text', text: `Unknown tool "${toolName}".` }] },
                            });
                        }
                        continue;
                    }
                    try {
                        let args: unknown = req.params?.arguments ?? {};
                        const { paramNames } = _inspectParams(entry.methodSchema, entry.schema);
                        if (entry.spec.fillParams !== undefined && _isPlainObject(args)) {
                            args = await entry.spec.fillParams({ ...args }, { method: entry.methodName, paramNames });
                        }
                        const issues = explainValidation(args, entry.methodSchema.params, entry.schema.components?.schemas ?? {});
                        if (issues.length > 0) {
                            const msg = ['Parameter validation failed:', ...issues.map(i => `  ${i.path || '(root)'}: ${i.reason}`)].join('\n');
                            if (hasId) {
                                writeMsg({
                                    jsonrpc: '2.0',
                                    id: req.id,
                                    result: { isError: true, content: [{ type: 'text', text: msg }] },
                                });
                            }
                            continue;
                        }
                        const wireMethod = connOpts.remoteServiceId !== undefined
                            ? `${connOpts.remoteServiceId}::${entry.schema.id}::${entry.methodName}`
                            : `${entry.schema.id}::${entry.methodName}`;
                        const result = await conn.channel.sendRequestWithStream(wireMethod, args as never, {
                            ...(conn.signed === true ? { interfaceHash: entry.schema.hash } : {}),
                        }).result;
                        if (hasId) {
                            writeMsg({
                                jsonrpc: '2.0',
                                id: req.id,
                                result: {
                                    content: [{ type: 'text', text: formatJson(result) }],
                                    ...(_isPlainObject(result) ? { structuredContent: result } : {}),
                                },
                            });
                        }
                    } catch (err) {
                        if (hasId) {
                            const msg = err instanceof Error ? err.message : String(err);
                            writeMsg({
                                jsonrpc: '2.0',
                                id: req.id,
                                result: { isError: true, content: [{ type: 'text', text: msg }] },
                            });
                        }
                    }
                    continue;
                }
                if (hasId) {
                    writeMsg({
                        jsonrpc: '2.0',
                        id: req.id,
                        error: { code: -32601, message: `Method not found: ${req.method}` },
                    });
                }
            }
        } finally {
            rl.close();
        }
    });
}
