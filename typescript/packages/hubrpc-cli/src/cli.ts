import { Command, InvalidArgumentError } from 'commander';
import { HubRpcConnection } from '@vscode/hubrpc';
import { isHubEndpoint, parseEndpointUri } from '@vscode/hubrpc/node';
import { connectionTokenBinderInterface } from '@vscode/hubrpc-hub/hub/server/connection-token-binder';
import { tapTransport } from '@vscode/hubrpc-hub/hub/server/transit';
import { callCommand, notifyCommand } from './commands/call';
import { executeBatch, parseBatchArgs } from './commands/batch';
import {
    disconnectBroker,
    getBrokerStatus,
    readBrokerNotifications,
} from './commands/connectionBrokerClient';
import {
    runConnectionBroker,
    spawnConnectionBroker,
} from './commands/connectionBrokerProcess';
import { parseDuration } from './duration';
import { checkCompatCommand, formatVerdict } from './commands/checkCompat';
import { completionsCommand } from './commands/completions';
import { defaultsCommand } from './commands/defaults';
import { hashCommand } from './commands/hash';
import { internalCompleteCommand } from './commands/internalComplete';
import { lsCommand } from './commands/ls';
import { topologyCommand, type TopologyFormat } from './commands/topology';
import { nodeCommand } from './commands/node';
import { pingCommand } from './commands/ping';
import {
    topologyParticipantsCommand,
    trafficWatchCommand,
} from './commands/participantWatch';
import { schemaCommand } from './commands/schema';
import { loadHubConfig, printHubConfigSchema, serveCommand } from './commands/serve';
import { tunnelCommand } from './commands/tunnel';
import { connectAs } from './commands/connectAs';
import { openDialTransport, openTargetTransport, type DialEndpoint } from './commands/connectAsTransports';
import { mcpForwardCommand } from './commands/mcpForward';
import {
    bootstrapApprovalCommandCapability,
    createHubApprovalCommandClient,
    formatApprovalDecision,
    formatApprovalRequests,
    type ApprovalCommandClient,
} from './commands/approval';
import { cliIdentity, formatCliIdentity } from './commands/identity';
import {
    connect as connectEndpoint,
    connectViaRootOverlay,
    type CliConnection,
    type ConnectLogOptions,
} from '@vscode/hubrpc-client';
import { type HubConfig } from '@vscode/hubrpc-client';
import { runHub, type RunningHub } from './engine/runHub';
import {
    type ResolvedEndpoint,
    resolveEndpoint,
    resolveTargetEndpoint,
    resolvedEndpointToConfig,
} from '@vscode/hubrpc-client';
import {
    type SigningSession,
    setupSigning,
    requestReflectionAccess,
    requestTopologyAccess,
} from '@vscode/hubrpc-client';
import { logoutCliIdentity } from '@vscode/hubrpc-client';
import { MethodRefWithOptHash } from './methodRef';
import { renderMethodParamHelp } from './methodHelp';
import { rewriteParamShortcuts } from './paramFlags';
import { formatPrincipalSource, parsePrincipalSpec, type PrincipalSpec } from '@vscode/hubrpc-client';
import { findMethodInSchema } from '@vscode/hubrpc-client';
import { fetchSchemaForMethodRef } from './schemaLookup';
import {
    loadStaticHubSchema,
    resolveStaticHubSchemaSource,
} from './staticHubSchema';

async function main(rawArgv: readonly string[]): Promise<void> {
    const program = new Command();
    program
        .name('hubrpc')
        .description(
            'CLI / TUI for hubrpc endpoints. Specify the server with --endpoint <uri>, ' +
            '--endpoint-cmd <command>, --endpoint-cmd-stdio <command>, or the HUBRPC_ENDPOINT env var.',
        )
        .option(
            '--endpoint <uri>',
            'endpoint URI (unix:/path?token=…, npipe://./pipe/…, ws[s]://host?token=…, ' +
            'ws-no-init://host?…, ' +
            'cmd:?command=… or cmd-stdio:?command=…)',
        )
        .option('--endpoint-cmd <command>', 'spawn a server, connect via an injected env socket')
        .option('--endpoint-cmd-stdio <command>', 'spawn a child and talk over its stdio')
        .option(
            '--endpoint-cmd-env <key=value>',
            'env var for the --endpoint-cmd / --endpoint-cmd-stdio child (repeatable)',
            (val: string, acc: Record<string, string> | undefined) => {
                const eq = val.indexOf('=');
                if (eq === -1) {
                    throw new InvalidArgumentError(`expected key=value, got '${val}'`);
                }
                const next = acc ?? {};
                next[val.slice(0, eq)] = val.slice(eq + 1);
                return next;
            },
        )
        .option('--endpoint-token <token>', 'token overriding the URI token / HUBRPC_TOKEN')
        .option(
            '--endpoint-cmd-cwd <dir>',
            'working directory for the --endpoint-cmd / --endpoint-cmd-stdio child',
        )
        .option(
            '-c, --config <file>',
            'run an in-process hub from this declarative config file and target it (see `serve --print-schema`)',
        )
        .option(
            '--provision-identity',
            'with --endpoint-cmd: provision & reuse a persistent identity (slot derived from cwd + command)',
        )
        .option(
            '--provision-identity-slot <slot>',
            'with --endpoint-cmd: provision & reuse a persistent identity under this explicit slot id',
        )
        .option(
            '--principal <spec>',
            'identity to sign calls with: "managed" (default, falls back to user:hubrpc-cli), ' +
            '"user:<id>" (per-user data dir), or "file:<path>"',
            (v) => {
                try {
                    parsePrincipalSpec(v);
                } catch (e) {
                    throw new InvalidArgumentError((e as Error).message);
                }
                return v;
            },
        )
        .option(
            '--log-messages',
            'log every JSON-RPC message to stderr, one coalesced flow per line (like the ' +
            'VS Code "hubrpc Flows" channel). For `serve` / `-c, --config` this is the ' +
            'in-process hub\'s routed traffic; for a direct `--endpoint` connection it taps ' +
            'the client transport. Ignored by `ui`.',
        )
        .option(
            '--log-transport',
            'log every raw JSON-RPC message sent and received to stderr, including transport initialization; '
            + 'may expose tokens and other sensitive payloads',
        )
        .showHelpAfterError();
    // Let `node <script>` pass the script's own flags through untouched.
    program.enablePositionalOptions();

    /** Parse the (already-validated) `--principal` value once opts are populated. */
    const getPrincipalSpec = (): PrincipalSpec =>
        parsePrincipalSpec(program.opts().principal as string | undefined);

    /** Resolve the endpoint from global flags + env once opts are populated. */
    const getEndpoint = (
        provisioningHandledElsewhere = false,
    ): ResolvedEndpoint | undefined => {
        const opts = program.opts();
        const r = resolveEndpoint({
            endpoint: opts.endpoint as string | undefined,
            endpointCmd: opts.endpointCmd as string | undefined,
            endpointCmdStdio: opts.endpointCmdStdio as string | undefined,
            endpointCmdEnv: opts.endpointCmdEnv as Record<string, string> | undefined,
            endpointToken: opts.endpointToken as string | undefined,
            endpointCmdCwd: opts.endpointCmdCwd as string | undefined,
            provisionIdentity: opts.provisionIdentity as boolean | undefined,
            provisionIdentitySlot: opts.provisionIdentitySlot as string | undefined,
            provisioningHandledElsewhere,
        });
        if (r.error) {
            process.stderr.write(`hubrpc: ${r.error}\n`);
            process.exit(2);
        }
        return r.endpoint;
    };

    // Resolved once per command, after global options are parsed. For `tunnel`,
    // global `--provision-identity[-slot]` binds to the target cmd \u2014 not the
    // source \u2014 so we tell the source resolver to skip its own provisioning check.
    let endpoint: ResolvedEndpoint | undefined;
    program.hook('preAction', (_thisCommand, actionCommand) => {
        endpoint = getEndpoint(actionCommand.name() === 'tunnel');
        g_hubConfigPath = program.opts().config as string | undefined;
        // Message logging goes to stderr, which would corrupt the full-screen
        // TUI — so it applies to every command except `ui`.
        g_logMessages = program.opts().logMessages === true
            && actionCommand.name() !== 'ui';
        g_logTransport = program.opts().logTransport === true
            && actionCommand.name() !== 'ui';
    });

    program
        .command('ls')
        .description(
            'List services and interfaces. Walks the bus recursively, following `hubrpc.directory` references.',
        )
        .option('--interface <id>', 'filter by interfaceId')
        .option('--interface-prefix <prefix>', 'filter by interfaceId prefix')
        .option('--service <id>', 'list a single service (no recursion)')
        .option('--service-prefix <prefix>', 'filter by serviceId prefix')
        .option('--search <regexp>', 'case-insensitive regexp over listings')
        .option('--depth <n>', 'max recursion depth (default 5)', (v) => Number.parseInt(v, 10))
        .option('--with-members', 'include request and notification members from interface schemas')
        .option('--json', 'legacy flat listing JSON; use --format json for graph state')
        .option('--format <format>', 'pretty, json, or jsonl')
        .option('--dump <file>', 'write topology and all schemas to one JSON fixture file')
        .option(
            '--dump-patches <file>',
            'write progressive RFC 6902 operations as JSON Lines; use - for stdout',
        )
        .option('--stream', 'legacy patch-log JSONL; use --format jsonl for reconstructable graph state')
        .option('--watch', 'continue observing directory changes until interrupted')
        .action(async (opts) => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const format = resolveGraphFormat(opts.format, {
                    json: opts.json === true,
                    stream: opts.stream === true,
                    watch: opts.watch === true,
                });
                const legacyOutput = opts.format === undefined
                    && opts.watch !== true
                    && (opts.json === true || opts.stream === true || opts.withMembers === true);
                const out = await lsCommand(channel, {
                    interfaceId: opts.interface,
                    interfacePrefix: opts.interfacePrefix,
                    serviceId: opts.service,
                    servicePrefix: opts.servicePrefix,
                    search: opts.search,
                    withMembers: !!opts.withMembers,
                    json: !!opts.json,
                    format: legacyOutput ? undefined : format,
                    dumpPath: opts.dump,
                    dumpPatchesPath: opts.dumpPatches,
                    stream: !!opts.stream,
                    watch: !!opts.watch,
                    emitLine: (line) => { process.stdout.write(line + '\n'); },
                    emitFrame: (frame) => { repaintTerminal(frame); },
                    stop: opts.watch ? _untilSignalled() : undefined,
                    maxDepth: typeof opts.depth === 'number' && !Number.isNaN(opts.depth) ?
                        opts.depth :
                        undefined,
                });
                if (out.length > 0) process.stdout.write(out + '\n');
            });
        });

    const topology = program
        .command('topology')
        .description('Inspect and optionally watch the merged transport topology.')
        .option(
            '--source <serviceId>',
            'topology provider serviceId; repeat for multiple fixed sources',
            collectOption,
        )
        .option('--depth <n>', 'directory discovery depth (default 5)', (v) => Number.parseInt(v, 10))
        .option('--node <nodeId>', 'filter by exact node id')
        .option('--service <serviceId>', 'filter route claims by exact service id')
        .option('--kind <kind>', 'filter nodes by hub or endpoint')
        .option('--search <regexp>', 'case-insensitive regexp over node metadata and routes')
        .option('--format <format>', 'pretty, json, or jsonl')
        .option('--json', 'alias for --format json')
        .option('--stream', 'alias for --format jsonl')
        .option('--watch', 'continue observing directory and topology changes')
        .action(async (opts) => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const format = resolveGraphFormat(opts.format, {
                    json: opts.json === true,
                    stream: opts.stream === true,
                    watch: opts.watch === true,
                });
                const kind = opts.kind === undefined ? undefined : String(opts.kind);
                if (kind !== undefined && kind !== 'hub' && kind !== 'endpoint') {
                    throw new InvalidArgumentError("--kind must be 'hub' or 'endpoint'");
                }
                const out = await topologyCommand(channel, {
                    sources: opts.source,
                    maxDepth: typeof opts.depth === 'number' && !Number.isNaN(opts.depth)
                        ? opts.depth
                        : undefined,
                    nodeId: opts.node,
                    serviceId: opts.service,
                    kind,
                    search: opts.search,
                    format,
                    watch: opts.watch === true,
                    emitLine: (line) => { process.stdout.write(line + '\n'); },
                    emitFrame: (frame) => { repaintTerminal(frame); },
                    stop: opts.watch ? _untilSignalled() : undefined,
                });
                if (out.length > 0) process.stdout.write(out + '\n');
            }, {
                requestReflectionAccess: false,
                requestTopologyAccess: { sourceServiceIds: opts.source },
            });
        });

    topology
        .command('participants')
        .description('List participant nodes; --search accepts a case-insensitive regexp.')
        .option('--search <regexp>', 'full-text regexp over participant metadata and routes')
        .option('--json', 'raw JSON output')
        .action(async (opts) => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await topologyParticipantsCommand(channel, opts.search);
                process.stdout.write(opts.json ? out + '\n' : out + '\n');
            }, {
                requestReflectionAccess: false,
                requestTopologyAccess: {},
            });
        });

    program
        .command('traffic')
        .description('Observe participant traffic.')
        .command('watch')
        .description('Watch node-wide traffic for a selected participant.')
        .option('--search <regexp>', 'participant metadata search regexp')
        .option('--node <nodeId>', 'select an exact topology node id')
        .option('--method <prefix>', 'only methods beginning with this prefix')
        .option('--payloads <bytes>', 'include payloads up to this many bytes', (v) => Number.parseInt(v, 10))
        .option('--format <format>', 'pretty, plain, or jsonl')
        .option('--resume [file]', 'restore the previous participant/filter selection')
        .action(async (opts) => {
            const format = opts.format as 'pretty' | 'plain' | 'jsonl';
            if (!['pretty', 'plain', 'jsonl'].includes(format)) {
                throw new InvalidArgumentError('--format must be pretty, plain, or jsonl');
            }
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                await trafficWatchCommand(channel, {
                    search: opts.search,
                    nodeId: opts.node,
                    methodPrefix: opts.method,
                    payloadBytes: opts.payloads,
                    format,
                    resume: opts.resume,
                    stop: _untilSignalled(),
                });
            }, { requestReflectionAccess: true });
        });

    program
        .command('defaults')
        .description('Print the preset service / interface for form-1 calls.')
        .option('--json', 'raw JSON output')
        .action(async (opts) => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await defaultsCommand(channel, { json: !!opts.json });
                process.stdout.write(out + '\n');
            });
        });

    program
        .command('schema <interfaceRef>')
        .description('Print an interface schema. `<interfaceRef>` is `id[@hash]`.')
        .option('--method <name>', 'show only this method')
        .option('--service <id>', 'route the lookup to this service (form-3); needed behind a hub')
        .option('--json', 'raw JSON output')
        .action(async (interfaceRef: string, opts) => {
            const { id, hash } = parseInterfaceRef(interfaceRef);
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await schemaCommand(channel, {
                    interfaceId: id,
                    hash,
                    method: opts.method,
                    serviceId: opts.service,
                    json: !!opts.json,
                });
                process.stdout.write(out + '\n');
            });
        });

    /**
     * Render `commander`'s static help for the given command, then (if a
     * methodRef is provided and an endpoint is reachable) fetch the live
     * schema and append a "Method parameters" block describing the
     * supported `--p:<name>` shortcuts.
     *
     * Best-effort: schema fetch failures degrade to static help with an
     * inline note instead of erroring out.
     */
    const _printCallHelp = async (cmd: Command, methodRef: string): Promise<void> => {
        process.stdout.write(cmd.helpInformation());
        if (methodRef.length === 0) {
            process.stdout.write(
                '\n(Pass a methodRef to see method-specific --p:<name> flags, e.g.\n'
                + '   hub call acme.email::send --help)\n',
            );
            return;
        }
        if (endpoint === undefined) {
            process.stdout.write(
                '\n(No endpoint configured: pass --endpoint / --endpoint-cmd or set HUBRPC_ENDPOINT\n'
                + 'to see method-specific --p:<name> flags here.)\n',
            );
            return;
        }
        let ref: MethodRefWithOptHash;
        try {
            ref = MethodRefWithOptHash.parseMethodRef(methodRef);
        } catch (e) {
            process.stdout.write(`\n(Could not parse method reference: ${(e as Error).message})\n`);
            return;
        }
        try {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const schema = await fetchSchemaForMethodRef(channel, ref);
                if (schema === undefined) {
                    process.stdout.write(
                        '\n(Bare-method refs (form 1) need a preset interface to look up the schema.)\n',
                    );
                    return;
                }
                const method = findMethodInSchema(schema, ref.methodName);
                if (method === undefined) {
                    process.stdout.write(
                        `\n(Method "${ref.methodName}" not found on interface ${schema.id}@${schema.hash}.)\n`,
                    );
                    return;
                }
                const rendered = renderMethodParamHelp(method, schema);
                if (rendered.text.length > 0) {
                    process.stdout.write('\n' + rendered.text);
                }
            });
        } catch (e) {
            process.stdout.write(`\n(Could not fetch method schema: ${(e as Error).message})\n`);
        }
    };

    program
        .command('call [methodRef]')
        .description(
            'Invoke a request. `<methodRef>` is `[svc::][iface::]method[@hash]`. '
            + 'Use `--p:<name> <value>` (or `--p:<name>=<value>`) as a shortcut for '
            + '`--param <name>=<value>`. Run `hub call <methodRef> --help` to see the '
            + 'method-specific `--p:` flags derived from the live schema.',
        )
        .option('--params <json>', 'inline params JSON, or "-" to read stdin')
        .option('--param <kv...>', 'param override, key=value (JSON or string)')
        .option('--no-validate', 'skip schema-based param validation')
        // Disable commander's built-in --help so we can intercept it and
        // append the dynamic "Method parameters" block.
        .helpOption(false)
        .option('-h, --help', 'show help (includes method params when reachable)')
        .action(async (methodRef: string | undefined, opts, cmd: Command) => {
            if (opts.help) {
                await _printCallHelp(cmd, methodRef ?? '');
                return;
            }
            if (methodRef === undefined) {
                process.stderr.write("hubrpc: missing required argument 'methodRef'.\n");
                process.stderr.write(cmd.helpInformation());
                process.exit(2);
            }
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await callCommand(channel, {
                    methodRef,
                    paramsArg: opts.params,
                    paramOverrides: opts.param,
                    noValidate: opts.validate === false,
                });
                process.stdout.write(out + '\n');
            }, { requestReflectionAccess: opts.validate !== false });
        });

    program
        .command('notify [methodRef]')
        .description(
            'Fire a notification (no response). Same `--p:<name>` shortcuts as `call`.',
        )
        .option('--params <json>', 'inline params JSON, or "-" to read stdin')
        .option('--param <kv...>', 'param override, key=value')
        .option('--no-validate', 'skip schema-based param validation')
        .helpOption(false)
        .option('-h, --help', 'show help (includes method params when reachable)')
        .action(async (methodRef: string | undefined, opts, cmd: Command) => {
            if (opts.help) {
                await _printCallHelp(cmd, methodRef ?? '');
                return;
            }
            if (methodRef === undefined) {
                process.stderr.write("hubrpc: missing required argument 'methodRef'.\n");
                process.stderr.write(cmd.helpInformation());
                process.exit(2);
            }
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await notifyCommand(channel, {
                    methodRef,
                    paramsArg: opts.params,
                    paramOverrides: opts.param,
                    noValidate: opts.validate === false,
                });
                process.stdout.write(out + '\n');
            }, { requestReflectionAccess: opts.validate !== false });
        });

    program
        .command('batch [batchArgs...]')
        .description(
            'Run sequential calls and notifications on one connection. Start each operation with '
            + '`--call <method>` or `--notify <method>`; following `--params`, `--param`, and '
            + '`--no-validate` flags apply to that operation.',
        )
        .allowUnknownOption()
        .addHelpText('after', `
Batch options:
  --call <method>        start a request operation
  --notify <method>      start a notification operation
  --params <json>        set inline JSON params for the preceding operation
  --param <key=value>    add a param override to the preceding operation (repeatable)
  --no-validate          skip validation for the preceding operation
  --continue-on-error    record an error and continue with later operations
`)
        .action(async (batchArgs: string[]) => {
            const plan = parseBatchArgs(batchArgs);
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const results = await executeBatch(plan, {
                    call: (options) => callCommand(channel, options),
                    notify: (options) => notifyCommand(channel, options),
                }, {
                    onStreamChunk: ({ index, method, payload }) => {
                        const text = typeof payload === 'string'
                            ? payload
                            : JSON.stringify(payload);
                        process.stderr.write(`[${index + 1} ${method}] ${text}\n`);
                    },
                });
                process.stdout.write(JSON.stringify(results, undefined, 2) + '\n');
            }, {
                requestReflectionAccess: plan.operations.some((operation) => !operation.noValidate),
            });
        });

    program
        .command('connect')
        .description(
            'Keep the configured endpoint connected in a detached broker process and print its local endpoint.',
        )
        .option('--timeout <duration>', 'exit after this much transport inactivity', '30s')
        .option('--ttl <duration>', 'hard maximum broker lifetime', '5min')
        .option(
            '--notification-limit <count>',
            'maximum buffered incoming notifications',
            (value) => parsePositiveInteger(value, '--notification-limit'),
            1_000,
        )
        .option(
            '--schema <path-or-url>',
            'serve static directory, interface schemas, and default-interface reflection from this JSON file or URL',
        )
        .action(async (opts: {
            timeout: string;
            ttl: string;
            notificationLimit: number;
            schema?: string;
        }) => {
            if (g_hubConfigPath !== undefined) {
                throw new Error('connect does not support --config; use an endpoint URI or command endpoint');
            }
            const schemaSource = opts.schema === undefined
                ? undefined
                : resolveStaticHubSchemaSource(opts.schema);
            if (schemaSource !== undefined) {
                await loadStaticHubSchema(schemaSource);
            }
            const brokerEndpoint = await spawnConnectionBroker({
                remote: needEndpoint(endpoint),
                timeoutMs: parseDuration(opts.timeout),
                ttlMs: parseDuration(opts.ttl),
                notificationLimit: opts.notificationLimit,
                schemaSource,
            });
            process.stdout.write(brokerEndpoint + '\n');
        });

    program
        .command('connection-status')
        .description('Read status from the connection broker at the configured endpoint.')
        .action(async () => {
            await withRawConnection(endpoint, async (channel) => {
                process.stdout.write(JSON.stringify(await getBrokerStatus(channel), undefined, 2) + '\n');
            });
        });

    program
        .command('disconnect')
        .description('Stop the connection broker at the configured endpoint.')
        .action(async () => {
            await withRawConnection(endpoint, async (channel) => {
                await disconnectBroker(channel);
            });
        });

    program
        .command('notifications')
        .description('Read incoming notifications buffered by the configured connection broker.')
        .option('--after <sequence>', 'read notifications after this sequence', (value) =>
            parseNonNegativeInteger(value, '--after'), 0)
        .option('--wait <duration>', 'wait for a notification before returning')
        .option('--follow', 'continue waiting and print notifications as JSON lines')
        .action(async (opts: { after: number; wait?: string; follow?: boolean; }) => {
            const waitMs = opts.wait === undefined
                ? (opts.follow ? 25_000 : 0)
                : Math.min(parseDuration(opts.wait), 30_000);
            await withRawConnection(endpoint, async (channel) => {
                let after = opts.after;
                do {
                    const batch = await readBrokerNotifications(channel, { after, waitMs });
                    if (opts.follow) {
                        for (const notification of batch.notifications) {
                            process.stdout.write(JSON.stringify(notification) + '\n');
                        }
                    } else {
                        process.stdout.write(JSON.stringify(batch, undefined, 2) + '\n');
                    }
                    after = batch.next;
                } while (opts.follow);
            });
        });

    program
        .command('_connection-broker')
        .description('(internal) Run a persistent connection broker.')
        .requiredOption('--remote-endpoint <uri>')
        .requiredOption('--timeout-ms <milliseconds>', '', (value) =>
            parsePositiveInteger(value, '--timeout-ms'))
        .requiredOption('--ttl-ms <milliseconds>', '', (value) =>
            parsePositiveInteger(value, '--ttl-ms'))
        .option('--notification-limit <count>', '', (value) =>
            parsePositiveInteger(value, '--notification-limit'), 1_000)
        .option('--schema <path-or-url>')
        .action(async (opts: {
            remoteEndpoint: string;
            timeoutMs: number;
            ttlMs: number;
            notificationLimit: number;
            schema?: string;
        }) => {
            const running = await runConnectionBroker({
                remote: parseEndpointUri(opts.remoteEndpoint),
                timeoutMs: opts.timeoutMs,
                ttlMs: opts.ttlMs,
                notificationLimit: opts.notificationLimit,
                ...(opts.schema === undefined
                    ? {}
                    : { staticHubSchema: await loadStaticHubSchema(opts.schema) }),
            });
            process.stdout.write(running.endpoint + '\n');
            await running.stopped;
        });

    program
        .command('hash <schema>')
        .description('Compute the hash of a local SvcInterfaceSchema JSON file.')
        .action((schema: string) => {
            const out = hashCommand({ schemaPath: schema });
            process.stdout.write(out + '\n');
        });

    program
        .command('check-compat <interfaceId> <local>')
        .description('Compare a local schema against the live one.')
        .action(async (interfaceId: string, local: string) => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const verdict = await checkCompatCommand(channel, { interfaceId, localPath: local });
                process.stdout.write(formatVerdict(verdict) + '\n');
                if (verdict.kind === 'incompatible') process.exit(1);
            });
        });

    program
        .command('ping')
        .description('One reflection round-trip; prints latency.')
        .action(async () => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await pingCommand(channel);
                process.stdout.write(out + '\n');
            });
        });
    program
        .command('serve [config]')
        .description(
            'Run a hub from a declarative config file and block until interrupted. '
            + 'The same config format drives the CLI hub, the server hub, and the VS Code extension.',
        )
        .option('--print-schema', 'print the config JSON Schema and exit')
        .option('--cmd-interactive', 'forward stdin to the single cmd endpoint (errors if more than one)')
        .action(async (config: string | undefined, opts: { printSchema?: boolean; cmdInteractive?: boolean; }) => {
            if (opts.printSchema) {
                process.stdout.write(printHubConfigSchema() + '\n');
                return;
            }
            if (config === undefined) {
                process.stderr.write('hubrpc: serve requires a <config> file (or --print-schema).\n');
                process.exit(2);
            }
            await serveCommand({
                configPath: config,
                cmdInteractive: opts.cmdInteractive,
                logMessages: g_logMessages,
            });
        });

    program
        .command('node <script> [args...]')
        .description("Run a node script under the supervisor's hash-pinned managed identity (svc::scriptRunner::run).")
        .option('--pty', 'prefer a real TTY (the supervisor may still fall back to a pipe)')
        .option('--no-pty', 'force pipe mode even when stdout is a TTY')
        .allowUnknownOption(true)
        .passThroughOptions(true)
        .action(async (script: string, args: string[] | undefined, opts: { pty?: boolean; }) => {
            const ep = needEndpoint(endpoint);
            const conn = await connectEndpoint(ep, wireLog('hub'));
            let exitCode = 1;
            try {
                const session = await setupSigning(conn.channel, conn.signing, getPrincipalSpec(), {
                    negotiateHubCaps: isHubEndpoint(ep),
                });
                reportIdentity(session);
                exitCode = await nodeCommand(conn.channel, {
                    script,
                    argv: args ?? [],
                    pty: opts.pty,
                });
            } finally {
                conn.close();
            }
            process.exit(exitCode);
        });

    program
        .command('tunnel <serviceId>')
        .description(
            'Claim <serviceId> on the source hub (--endpoint*) and forward every request it ' +
            'routes here to a target endpoint over a second connection. The target endpoint ' +
            'is set via --target-endpoint / --target-endpoint-cmd / --target-endpoint-cmd-stdio; ' +
            'when it is --target-endpoint-cmd, the spawned child sees ' +
            "`hubGrantedServiceId::get().grantedServiceIdNamespace` = <serviceId> from its local hub, " +
            'and global --provision-identity[-slot] applies to it. With `-c, --config`, the ' +
            'source hub is instead appended to the config as an endpoint claiming <serviceId>, ' +
            'and the in-process hub serves it (the config provides the target). Runs until Ctrl-C.',
        )
        .option(
            '--target-endpoint <uri>',
            'target endpoint URI (unix:/path?token=…, npipe://./pipe/…, ws[s]://host?token=…, ' +
            'cmd:?command=… or cmd-stdio:?command=…)',
        )
        .option(
            '--target-endpoint-cmd <command>',
            'spawn the target as a server, connect via an injected env socket; the child sees ' +
            'grantedServiceIdNamespace = <serviceId> via hubGrantedServiceId::get',
        )
        .option(
            '--target-endpoint-cmd-stdio <command>',
            'spawn the target and talk hubrpc over its stdio',
        )
        .option(
            '--target-endpoint-cmd-env <key=value>',
            'env var for the --target-endpoint-cmd / --target-endpoint-cmd-stdio child (repeatable)',
            (val: string, acc: Record<string, string> | undefined) => {
                const eq = val.indexOf('=');
                if (eq === -1) {
                    throw new InvalidArgumentError(`expected key=value, got '${val}'`);
                }
                const next = acc ?? {};
                next[val.slice(0, eq)] = val.slice(eq + 1);
                return next;
            },
        )
        .option(
            '--target-endpoint-token <token>',
            'token overriding the target URI token (no env fallback for the target)',
        )
        .option(
            '--target-endpoint-cmd-cwd <dir>',
            'working directory for the --target-endpoint-cmd / --target-endpoint-cmd-stdio child',
        )
        .option(
            '--bidi',
            'also forward every request/notification the target endpoint emits back to the ' +
            'source hub, exposing the hub to the endpoint (forwards everything, unsigned)',
        )
        .action(async (serviceId: string, cmdOpts: {
            targetEndpoint?: string;
            targetEndpointCmd?: string;
            targetEndpointCmdStdio?: string;
            targetEndpointCmdEnv?: Record<string, string>;
            targetEndpointToken?: string;
            targetEndpointCmdCwd?: string;
            bidi?: boolean;
        }) => {
            const localEp = needEndpoint(endpoint);

            // Config mode: append the source hub to the loaded config as an
            // endpoint claiming <serviceId>, then run that in-process hub. The
            // config itself provides the target that serves the service id, so
            // the manual two-connection forward path is not used.
            if (g_hubConfigPath !== undefined) {
                const baseConfig = loadHubConfig(g_hubConfigPath);
                const claimEndpoint = resolvedEndpointToConfig(localEp, {
                    claimServiceIds: [serviceId],
                });
                const config: HubConfig = {
                    ...baseConfig,
                    // The in-process hub serves <serviceId> and claims it on the
                    // source, so it must mount its own services under <serviceId>
                    // (not the default 'hub') for the claim and routing to line up.
                    hubServiceId: serviceId,
                    endpoints: [...baseConfig.endpoints, claimEndpoint],
                };
                const running = await runHub({ config, logMessages: g_logMessages });
                process.stderr.write(
                    `hubrpc: tunnel: claimed '${serviceId}' on source via config hub. Ctrl-C to stop.\n`,
                );
                await new Promise<void>((resolve) => {
                    const stop = (): void => {
                        running.dispose();
                        resolve();
                    };
                    process.once('SIGINT', stop);
                    process.once('SIGTERM', stop);
                });
                return;
            }

            const globalOpts = program.opts();
            const targetRes = resolveTargetEndpoint({
                targetEndpoint: cmdOpts.targetEndpoint,
                targetEndpointCmd: cmdOpts.targetEndpointCmd,
                targetEndpointCmdStdio: cmdOpts.targetEndpointCmdStdio,
                targetEndpointCmdEnv: cmdOpts.targetEndpointCmdEnv,
                targetEndpointToken: cmdOpts.targetEndpointToken,
                targetEndpointCmdCwd: cmdOpts.targetEndpointCmdCwd,
                provisionIdentity: globalOpts.provisionIdentity as boolean | undefined,
                provisionIdentitySlot: globalOpts.provisionIdentitySlot as string | undefined,
            });
            if (targetRes.error) {
                process.stderr.write(`hubrpc: ${targetRes.error}\n`);
                process.exit(2);
            }
            if (!targetRes.endpoint) {
                process.stderr.write(
                    'hubrpc: tunnel requires --target-endpoint / --target-endpoint-cmd / --target-endpoint-cmd-stdio.\n',
                );
                process.exit(2);
            }
            const targetEp = targetRes.endpoint;
            // Honor the legacy HUBRPC_REMOTE_ENDPOINT_TOKEN env var as a fallback
            // for token-bearing target URIs.
            const remoteTok = process.env.HUBRPC_REMOTE_ENDPOINT_TOKEN;
            const targetEpWithToken: ResolvedEndpoint =
                remoteTok !== undefined && (targetEp.kind === 'socket' || targetEp.kind === 'ws')
                    && targetEp.token === undefined
                    ? { ...targetEp, token: remoteTok }
                    : targetEp;

            const local = await connectEndpoint(localEp, wireLog('source'));
            // Connect straight to the target endpoint — no routing hub. For a
            // spawned cmd-env child we front it with a RootOverlay: its root-form
            // calls (identity::*, hubGrantedServiceId::*, reflection, hubAccess)
            // are served locally while every claimed request the tunnel forwards
            // is relayed to the child through the overlay splitter. This keeps
            // --provision-identity working (identity::* is served) without the
            // 'hub' service id / claim-wait dance a full local hub imposes.
            let remote: CliConnection;
            if (targetEpWithToken.kind === 'cmd-env') {
                remote = await connectViaRootOverlay({
                    command: targetEpWithToken.command,
                    provisionSlot: targetEpWithToken.provisionSlot,
                    env: targetEpWithToken.env,
                    ...(targetEpWithToken.cwd !== undefined ? { cwd: targetEpWithToken.cwd } : {}),
                    grantedNamespace: serviceId,
                    log: wireLog('target'),
                });
            } else {
                remote = await connectEndpoint(targetEpWithToken, wireLog('target'));
            }
            try {
                // Sign the claim where the source hub requires it (managed
                // identity with local-keypair fallback). The remote side is
                // left unsigned so requests forward verbatim.
                const session = await setupSigning(local.channel, local.signing, getPrincipalSpec(), {
                    negotiateHubCaps: isHubEndpoint(localEp),
                });
                reportIdentity(session);
                await tunnelCommand({ serviceId, local, remote, bidi: cmdOpts.bidi });
            } finally {
                remote.close();
                local.close();
            }
        });

    program
        .command('connect-as <binderServiceId> <slot>')
        .description(
            'Mint a single-use identity token for <slot> from the <binderServiceId> ' +
            '(a service implementing connectionTokenBinder, typically the hub service id), ' +
            'then splice a target endpoint onto the hub as a first-class participant with that ' +
            'slot\'s managed identity and a granted serviceId namespace (--granted-service-id, ' +
            'defaulting to <slot>). No local hub is started: the CLI ' +
            'proxies the connection (target ⟷ CLI ⟷ hub), so it works with every target kind and ' +
            '--log-messages taps the full flow. The hub-facing bound-token listener is ' +
            '--hub-endpoint (defaults to --endpoint when that is a ws/socket). Runs until Ctrl-C.',
        )
        .option(
            '--hub-endpoint <uri>',
            'ws/socket bound-token listener to splice the target onto (default: --endpoint)',
        )
        .option('--target-endpoint <uri>', 'target endpoint URI (unix:/…, ws[s]://…)')
        .option('--target-endpoint-cmd <command>', 'spawn the target as a server; it dials the CLI back')
        .option('--target-endpoint-cmd-stdio <command>', 'spawn the target and talk hubrpc over its stdio')
        .option(
            '--target-endpoint-cmd-env <key=value>',
            'env var for the --target-endpoint-cmd / --target-endpoint-cmd-stdio child (repeatable)',
            (val: string, acc: Record<string, string> | undefined) => {
                const eq = val.indexOf('=');
                if (eq === -1) {
                    throw new InvalidArgumentError(`expected key=value, got '${val}'`);
                }
                const next = acc ?? {};
                next[val.slice(0, eq)] = val.slice(eq + 1);
                return next;
            },
        )
        .option('--target-endpoint-token <token>', 'token overriding the target URI token')
        .option(
            '--target-endpoint-cmd-cwd <dir>',
            'working directory for the --target-endpoint-cmd / --target-endpoint-cmd-stdio child',
        )
        .option(
            '--granted-service-id <serviceId>',
            'serviceId namespace to grant the target (default: <slot>)',
        )
        .action(async (binderServiceId: string, slot: string, cmdOpts: {
            hubEndpoint?: string;
            targetEndpoint?: string;
            targetEndpointCmd?: string;
            targetEndpointCmdStdio?: string;
            targetEndpointCmdEnv?: Record<string, string>;
            targetEndpointToken?: string;
            targetEndpointCmdCwd?: string;
            grantedServiceId?: string;
        }) => {
            const localEp = needEndpoint(endpoint);

            // Resolve the hub-facing (bound-token) listener the target is spliced
            // onto. Defaults to --endpoint when that is itself a dial-able ws/socket.
            let hubEp: DialEndpoint;
            try {
                hubEp = _resolveDialEndpoint(cmdOpts.hubEndpoint, localEp);
            } catch (e) {
                process.stderr.write(`hubrpc: ${(e as Error).message}\n`);
                process.exit(2);
            }

            const targetRes = resolveTargetEndpoint({
                targetEndpoint: cmdOpts.targetEndpoint,
                targetEndpointCmd: cmdOpts.targetEndpointCmd,
                targetEndpointCmdStdio: cmdOpts.targetEndpointCmdStdio,
                targetEndpointCmdEnv: cmdOpts.targetEndpointCmdEnv,
                targetEndpointToken: cmdOpts.targetEndpointToken,
                targetEndpointCmdCwd: cmdOpts.targetEndpointCmdCwd,
            });
            if (targetRes.error) {
                process.stderr.write(`hubrpc: ${targetRes.error}\n`);
                process.exit(2);
            }
            if (!targetRes.endpoint) {
                process.stderr.write(
                    'hubrpc: connect-as requires --target-endpoint / --target-endpoint-cmd / --target-endpoint-cmd-stdio.\n',
                );
                process.exit(2);
            }
            const targetEp = targetRes.endpoint;

            // Broker connection: sign the mint call where the hub requires it.
            const broker = await connectEndpoint(localEp, wireLog('broker'));
            try {
                const session = await setupSigning(broker.channel, broker.signing, getPrincipalSpec(), {
                    negotiateHubCaps: isHubEndpoint(localEp),
                });
                reportIdentity(session);

                const brokerConn = new HubRpcConnection(broker.rpcChannel);
                const binder = brokerConn.service(binderServiceId).get(connectionTokenBinderInterface);

                const logLine = (line: string): void => { process.stderr.write(`hubrpc: ${line}\n`); };
                const serviceIdNamespace = cmdOpts.grantedServiceId ?? slot;
                await connectAs({
                    mintToken: async () => {
                        const { token } = await binder.bindConnectionToken({
                            identitySlot: slot,
                            serviceIdNamespace,
                        });
                        logLine(
                            `connect-as: minted token for identity slot '${slot}'` +
                            `${serviceIdNamespace !== slot ? `, granted serviceId '${serviceIdNamespace}'` : ''}` +
                            ` via ${binderServiceId}`,
                        );
                        return token;
                    },
                    openHubTransport: (token) => openDialTransport(hubEp, token),
                    openTargetTransport: () => openTargetTransport(targetEp, logLine),
                    ...(g_logMessages
                        ? {
                            tapTarget: (t) => tapTransport(t, {
                                log: logLine,
                                localLabel: 'cli',
                                remoteLabel: 'target',
                            }),
                        }
                        : {}),
                    log: logLine,
                    stop: _untilSignalled(),
                });
            } finally {
                broker.close();
            }
        });

    program
        .command('mcp-forward [mcpCommand...]')
        .description(
            'Expose an MCP server through the hub (--endpoint*) as a transparent forwarder. ' +
            'By default it claims this connection\'s granted serviceId namespace; pass ' +
            '--serviceId to claim a specific prefix. The MCP server command follows `--`, e.g. ' +
            '`hubrpc mcp-forward -- npx -y @modelcontextprotocol/server-everything` or ' +
            '`hubrpc mcp-forward --serviceId my-mcp -- npx -y @modelcontextprotocol/server-everything`. ' +
            'Each consumer that opens `<serviceId>::vscode.mcp-forward::connect` spawns a fresh child ' +
            'and gets its MCP stdio bridged raw over the stream. Runs until Ctrl-C.',
        )
        .option(
            '--serviceId <serviceId>',
            'serviceId prefix to claim (default: the connection\'s granted serviceId namespace)',
        )
        .option(
            '--env <key=value>',
            'env var for the spawned MCP server child (repeatable)',
            (val: string, acc: Record<string, string> | undefined) => {
                const eq = val.indexOf('=');
                if (eq === -1) {
                    throw new InvalidArgumentError(`expected key=value, got '${val}'`);
                }
                const next = acc ?? {};
                next[val.slice(0, eq)] = val.slice(eq + 1);
                return next;
            },
        )
        .action(async (mcpCommand: string[] | undefined, cmdOpts: {
            serviceId?: string;
            env?: Record<string, string>;
        }) => {
            const localEp = needEndpoint(endpoint);
            if (!mcpCommand || mcpCommand.length === 0) {
                process.stderr.write(
                    'hubrpc: mcp-forward requires an MCP server command after `--`, e.g. ' +
                    '`mcp-forward -- npx -y @modelcontextprotocol/server-everything`.\n',
                );
                process.exit(2);
            }
            const local = await connectEndpoint(localEp, wireLog('hub'));
            try {
                const session = await setupSigning(local.channel, local.signing, getPrincipalSpec(), {
                    negotiateHubCaps: isHubEndpoint(localEp),
                });
                reportIdentity(session);
                await mcpForwardCommand({
                    ...(cmdOpts.serviceId !== undefined ? { serviceId: cmdOpts.serviceId } : {}),
                    local,
                    command: { argv: mcpCommand },
                    ...(cmdOpts.env !== undefined ? { env: cmdOpts.env } : {}),
                });
            } finally {
                local.close();
            }
        });

    program
        .command('identity')
        .description('Inspect the persistent principal used by connected CLI commands.')
        .command('show')
        .description('Print the resolved persistent CLI identity.')
        .option('--json', 'stable machine-readable JSON output')
        .action(async (opts: { json?: boolean; }) => {
            await withResolvedSigning(endpoint, getPrincipalSpec(), async (_conn, session) => {
                const out = formatCliIdentity(cliIdentity(session), opts.json === true);
                process.stdout.write(out + '\n');
            });
        });

    const approval = program
        .command('approval')
        .description('Inspect and decide pending Hub access approval requests.');

    approval
        .command('requests')
        .description('List pending requests whose capability audience is this CLI identity.')
        .option('--json', 'stable machine-readable JSON output')
        .action(async (opts: { json?: boolean; }) => {
            await withApprovalClient(endpoint, getPrincipalSpec(), async (client) => {
                const out = formatApprovalRequests(
                    await client.requests(),
                    client.principalId,
                    opts.json === true,
                );
                process.stdout.write(out + '\n');
            });
        });

    approval
        .command('approve <request-id>')
        .description('Approve one pending request for this CLI identity.')
        .option('--json', 'stable machine-readable JSON output')
        .action(async (requestId: string, opts: { json?: boolean; }) => {
            await withApprovalClient(endpoint, getPrincipalSpec(), async (client) => {
                const outcome = await client.approve(requestId);
                process.stdout.write(
                    formatApprovalDecision(
                        'approved',
                        requestId,
                        client.principalId,
                        opts.json === true,
                        outcome,
                    ) + '\n',
                );
            });
        });

    approval
        .command('deny <request-id>')
        .description('Deny one pending request for this CLI identity.')
        .option('--reason <text>', 'optional denial reason')
        .option('--json', 'stable machine-readable JSON output')
        .action(async (requestId: string, opts: { reason?: string; json?: boolean; }) => {
            await withApprovalClient(endpoint, getPrincipalSpec(), async (client) => {
                const outcome = await client.deny(requestId, opts.reason);
                process.stdout.write(
                    formatApprovalDecision(
                        'denied',
                        requestId,
                        client.principalId,
                        opts.json === true,
                        outcome,
                    ) + '\n',
                );
            });
        });

    approval
        .command('ui')
        .description('Watch pending requests and approve or deny them interactively in the terminal.')
        .action(async () => {
            if (
                process.stdin.isTTY !== true
                || process.stdout.isTTY !== true
                || !Number.isInteger(process.stdout.columns)
                || process.stdout.columns <= 0
                || !Number.isInteger(process.stdout.rows)
                || process.stdout.rows <= 0
            ) {
                throw new Error('approval ui requires an interactive terminal with visible output');
            }
            const stop = new AbortController();
            const onSignal = () => stop.abort();
            await withApprovalClient(
                endpoint,
                getPrincipalSpec(),
                async (client) => {
                    process.once('SIGINT', onSignal);
                    process.once('SIGTERM', onSignal);
                    try {
                        const { runApprovalUi } = await import('./approval-ui/runApprovalUi');
                        await runApprovalUi({ client, signal: stop.signal });
                    } finally {
                        process.removeListener('SIGINT', onSignal);
                        process.removeListener('SIGTERM', onSignal);
                    }
                },
                () => { /* Ink owns the terminal while the approval UI is active. */ },
            );
        });

    program
        .command('ui')
        .description('Launch the terminal UI (form-based browser of services + methods).')
        .action(async () => {
            const acquired = await acquireConnection(endpoint);
            const { runUi } = await import('./ui/runUi');
            try {
                await runUi({ endpoint: acquired.ep, principalSpec: getPrincipalSpec() });
            } finally {
                acquired.running?.dispose();
            }
        });

    program
        .command('logout')
        .description(
            'Delete the stored CLI identity and cached capabilities. Next call will mint a fresh keypair and prompt for consent again.',
        )
        .action(async () => {
            const removed = await logoutCliIdentity();
            if (removed.length === 0) {
                process.stdout.write('hubrpc: no stored identity found.\n');
                return;
            }
            for (const f of removed) {
                process.stdout.write(`removed ${f}\n`);
            }
        });

    program
        .command('completions <shell>')
        .description(
            'Print a shell completion script. Supported: powershell. Install with ' +
            '`hub completions powershell | Out-String | Invoke-Expression` (one-shot) or ' +
            'append to $PROFILE.',
        )
        .action((shell: string) => {
            try {
                const script = completionsCommand({ shell });
                process.stdout.write(script);
                if (!script.endsWith('\n')) process.stdout.write('\n');
            } catch (e) {
                process.stderr.write(`hubrpc: ${(e as Error).message}\n`);
                process.exit(2);
            }
        });

    program
        .command('_complete')
        .description(
            '(internal) Emit completion candidates for a partial command line. ' +
            'Invoked by the scripts produced by `hub completions`.',
        )
        .option('--line <line>', 'the partial command line, including the binary name')
        .option('--point <n>', 'cursor position (0-indexed) into --line', (v) => Number.parseInt(v, 10))
        .action(async (opts: { line?: string; point?: number; }) => {
            // The completer must NEVER write to stderr or non-zero-exit — that
            // would surface in the user's prompt. Always exit 0 with whatever
            // we managed to compute (possibly nothing). Force-exit at the end
            // so any open socket / setup-signing timer can't keep the process
            // alive past the action — that hangs the user's shell on TAB.
            try {
                const line = opts.line ?? '';
                const point = typeof opts.point === 'number' && !Number.isNaN(opts.point)
                    ? opts.point
                    : line.length;
                const out = await internalCompleteCommand({ line, point });
                if (out.length > 0) process.stdout.write(out + '\n');
            } catch {
                // swallow
            }
            // Force-exit: completion is one-shot and must never hang.
            process.exit(0);
        });

    await program.parseAsync(['node', 'hubrpc', ...rewriteParamShortcuts(rawArgv)]);
}

async function withChannel(
    endpoint: ResolvedEndpoint | undefined,
    principalSpec: PrincipalSpec,
    fn: (channel: import('@vscode/hubrpc-client').CliChannel) => Promise<void>,
    opts: {
        requestReflectionAccess?: boolean;
        requestTopologyAccess?: { readonly sourceServiceIds?: readonly string[] };
    } = {},
): Promise<void> {
    const acquired = await acquireConnection(endpoint);
    // When `--config` runs an in-process hub, that hub already logs its routed
    // traffic (richer than the client leg) — so only tap the wire for a direct
    // remote connection, to avoid double-logging the control socket.
    const conn = await connectEndpoint(acquired.ep, acquired.running === undefined ? wireLog('hub') : undefined);
    try {
        if (
            acquired.ep.kind === 'ws-no-init'
            || (acquired.ep.kind === 'socket' && acquired.ep.brokerMode === 'raw')
        ) {
            await fn(conn.channel);
            return;
        }

        const session = await setupSigning(conn.channel, conn.signing, principalSpec, {
            negotiateHubCaps: acquired.running !== undefined || isHubEndpoint(acquired.ep),
        });
        reportIdentity(session);
        // Up-front, batched reflection grant across all services. One consent
        // prompt covers `ls` / `schema` / `defaults`; if denied we fall back to
        // per-call auto-cap negotiation installed by `setupSigning`.
        if (
            opts.requestReflectionAccess !== false
            && (acquired.running !== undefined || isHubEndpoint(acquired.ep))
        ) {
            const status = await requestReflectionAccess(session);
            if (status === 'denied') {
                process.stderr.write(
                    'hubrpc: reflection access denied; falling back to per-call negotiation.\n',
                );
            }
        }
        if (
            opts.requestTopologyAccess !== undefined
            && (acquired.running !== undefined || isHubEndpoint(acquired.ep))
        ) {
            const status = await requestTopologyAccess(session, opts.requestTopologyAccess);
            if (status === 'denied') {
                process.stderr.write(
                    'hubrpc: topology access denied; topology sources may be inaccessible.\n',
                );
            }
        }
        await fn(conn.channel);
    } finally {
        conn.close();
        acquired.running?.dispose();
    }
}

async function withResolvedSigning(
    endpoint: ResolvedEndpoint | undefined,
    principalSpec: PrincipalSpec,
    fn: (connection: CliConnection, session: SigningSession) => Promise<void>,
): Promise<void> {
    const acquired = await acquireConnection(endpoint);
    if (
        acquired.ep.kind === 'ws-no-init'
        || (acquired.ep.kind === 'socket' && acquired.ep.brokerMode === 'raw')
    ) {
        acquired.running?.dispose();
        throw new Error('identity and approval commands require a HubRPC endpoint');
    }
    const conn = await connectEndpoint(acquired.ep, acquired.running === undefined ? wireLog('hub') : undefined);
    try {
        const session = await setupSigning(conn.channel, conn.signing, principalSpec, {
            negotiateHubCaps: acquired.running !== undefined || isHubEndpoint(acquired.ep),
            autoNegotiatePerCall: false,
        });
        await fn(conn, session);
    } finally {
        conn.close();
        acquired.running?.dispose();
    }
}

async function withApprovalClient(
    endpoint: ResolvedEndpoint | undefined,
    principalSpec: PrincipalSpec,
    fn: (client: ApprovalCommandClient) => Promise<void>,
    log: (line: string) => void = (line) => process.stderr.write(`hubrpc: ${line}\n`),
): Promise<void> {
    await withResolvedSigning(endpoint, principalSpec, async (conn, session) => {
        reportIdentity(session);
        await bootstrapApprovalCommandCapability(session.principal);
        const connection = new HubRpcConnection(conn.rpcChannel);
        const client = createHubApprovalCommandClient(
            connection,
            session.principal.identity,
            log,
        );
        try {
            await fn(client);
        } finally {
            client.dispose();
        }
    });
}

async function withRawConnection(
    endpoint: ResolvedEndpoint | undefined,
    fn: (channel: import('@vscode/hubrpc-client').CliChannel) => Promise<void>,
): Promise<void> {
    if (g_hubConfigPath !== undefined) {
        throw new Error('connection broker commands do not support --config');
    }
    const conn = await connectEndpoint(needEndpoint(endpoint), wireLog('connection broker'));
    try {
        await fn(conn.channel);
    } finally {
        conn.close();
    }
}

function parsePositiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new InvalidArgumentError(`${option} must be a positive integer`);
    }
    return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new InvalidArgumentError(`${option} must be a non-negative integer`);
    }
    return parsed;
}

/**
 * Module-level config path, set per-command in the `preAction` hook. When set,
 * client commands run an in-process hub from the config and target its private
 * control socket instead of `--endpoint`.
 */
let g_hubConfigPath: string | undefined;

/**
 * Module-level flag, set per-command in the `preAction` hook. When set, the
 * in-process hub (`-c, --config` or `serve`) logs every routed JSON-RPC
 * message to stderr. Forced off for `ui` (it would corrupt the TUI).
 */
let g_logMessages = false;
let g_logTransport = false;

/**
 * Build the wire-tap options for a direct {@link connect}, or `undefined` when
 * `--log-messages` is off. Logs every JSON-RPC message crossing the client
 * transport to stderr, rendered like the hub "Flows" view — the way to observe
 * a connection that never routes through a local hub.
 */
function wireLog(remoteLabel: string): ConnectLogOptions | undefined {
    if (!g_logMessages && !g_logTransport) return undefined;
    return {
        ...(g_logMessages
            ? { log: (line: string) => process.stderr.write(`hubrpc: ${line}\n`) }
            : {}),
        ...(g_logTransport
            ? {
                trace: (direction: 'send' | 'receive', message: import('@vscode/hubrpc').JsonRpcMessage) =>
                    process.stderr.write(`hubrpc: transport ${direction} ${JSON.stringify(message)}\n`),
            }
            : {}),
        remoteLabel,
    };
}

/**
 * Resolve the endpoint a client command should connect to. With `--config`,
 * spins up an in-process hub and returns its control socket (the caller must
 * `running.dispose()` when done); otherwise returns the resolved `--endpoint`.
 */
async function acquireConnection(
    endpoint: ResolvedEndpoint | undefined,
): Promise<{ ep: ResolvedEndpoint; running?: RunningHub; }> {
    if (g_hubConfigPath !== undefined) {
        const config: HubConfig = loadHubConfig(g_hubConfigPath);
        const running = await runHub({ config, logMessages: g_logMessages });
        return {
            ep: { kind: 'socket', path: running.controlEndpoint.path, token: running.controlEndpoint.token },
            running,
        };
    }
    return { ep: needEndpoint(endpoint) };
}

/** Print the identity used to sign calls to stderr (keeps stdout clean for JSON output). */
function reportIdentity(session: SigningSession): void {
    process.stderr.write(
        `hubrpc: identity ${formatPrincipalSource(session.principalSource, session.principal.id)
        }\n`,
    );
}

function needEndpoint(endpoint: ResolvedEndpoint | undefined): ResolvedEndpoint {
    if (!endpoint) {
        process.stderr.write(
            'hubrpc: this command requires --endpoint / --endpoint-cmd / --endpoint-cmd-stdio ' +
            'or the HUBRPC_ENDPOINT env var to be set.\n',
        );
        process.exit(2);
    }
    return endpoint;
}

/**
 * Resolve the ws/socket bound-token listener `connect-as` splices the target
 * onto: an explicit `--hub-endpoint <uri>`, else the fallback endpoint when it
 * is itself a dial-able ws/socket. Throws otherwise (cmd endpoints aren't
 * dial-able bound listeners).
 */
function _resolveDialEndpoint(
    hubEndpoint: string | undefined,
    fallback: ResolvedEndpoint,
): DialEndpoint {
    if (hubEndpoint !== undefined) {
        const spec = parseEndpointUri(hubEndpoint);
        if (spec.kind !== 'ws' && spec.kind !== 'socket') {
            throw new Error(`--hub-endpoint must be a ws/socket URI, got '${spec.kind}'`);
        }
        return spec;
    }
    if (fallback.kind === 'ws' || fallback.kind === 'socket') {
        return fallback;
    }
    throw new Error(
        'connect-as requires --hub-endpoint <ws/socket uri> (the bound-token listener); ' +
        `--endpoint resolved to '${fallback.kind}', which is not a dial-able bound listener`,
    );
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

function resolveGraphFormat(
    rawFormat: unknown,
    aliases: { readonly json: boolean; readonly stream: boolean; readonly watch: boolean },
): TopologyFormat {
    if (aliases.json && aliases.stream) {
        throw new InvalidArgumentError('--json and --stream cannot be combined');
    }
    if (rawFormat !== undefined && (aliases.json || aliases.stream)) {
        throw new InvalidArgumentError('--format cannot be combined with --json or --stream');
    }
    if (rawFormat !== undefined
        && rawFormat !== 'pretty'
        && rawFormat !== 'json'
        && rawFormat !== 'jsonl') {
        throw new InvalidArgumentError("--format must be 'pretty', 'json', or 'jsonl'");
    }
    if (aliases.json) return 'json';
    if (aliases.stream) return 'jsonl';
    if (rawFormat !== undefined) return rawFormat;
    return aliases.watch && !process.stdout.isTTY ? 'jsonl' : 'pretty';
}

function collectOption(value: string, previous: readonly string[] | undefined): readonly string[] {
    return [...(previous ?? []), value];
}

function repaintTerminal(frame: string): void {
    process.stdout.write(`\u001b[2J\u001b[H${frame}\n`);
}

function parseInterfaceRef(raw: string): { id: string; hash: string | undefined; } {
    const at = raw.lastIndexOf('@');
    if (at > 0 && !raw.slice(at + 1).includes('::')) {
        return { id: raw.slice(0, at), hash: raw.slice(at + 1) };
    }
    return { id: raw, hash: undefined };
}

main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`hubrpc: ${formatCliError(e)}\n`);
    process.exit(1);
});

function formatCliError(error: unknown): string {
    if (typeof error !== 'object' || error === null) return String(error);

    const value = error as {
        readonly code?: unknown;
        readonly message?: unknown;
        readonly data?: unknown;
    };
    const message = typeof value.message === 'string' ? value.message : String(error);
    if (typeof value.code !== 'number' && typeof value.code !== 'string') return message;

    const data = value.data === undefined ? '' : ` data=${safeJson(value.data)}`;
    return `[${value.code}] ${message}${data}`;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
