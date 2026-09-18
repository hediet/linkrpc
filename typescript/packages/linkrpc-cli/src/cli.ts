import { Command, InvalidArgumentError } from 'commander';
import { LinkRpcConnection, type JsonValue } from '@hediet/linkrpc';
import { formatEndpointUri, isHubEndpoint, parseEndpointUri } from '@hediet/linkrpc/node';
import { connectionTokenBinderInterface } from '@hediet/linkrpc-hub/hub/server/connection-token-binder';
import { tapTransport } from '@hediet/linkrpc-hub/hub/server/transit';
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
import { codegenCommand } from './commands/codegen';
import { completionsCommand } from './commands/completions';
import { defaultsCommand } from './commands/defaults';
import { hashCommand } from './commands/hash';
import { internalCompleteCommand } from './commands/internalComplete';
import { lsCommand } from './commands/ls';
import { topologyCommand, type TopologyFormat } from './commands/topology';
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
import { jsonRpcStdioCommand } from './commands/jsonRpcStdio';
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
} from '@hediet/linkrpc-client';
import { type HubConfig } from '@hediet/linkrpc-client';
import { runHub, type RunningHub } from './engine/runHub';
import {
    type ResolvedEndpoint,
    resolveTargetEndpoint,
    resolvedEndpointToConfig,
} from '@hediet/linkrpc-client';
import {
    type SigningSession,
    setupSigning,
    requestReflectionAccess,
    requestTopologyAccess,
} from '@hediet/linkrpc-client';
import { logoutCliIdentity } from '@hediet/linkrpc-client';
import { MethodRefWithOptHash } from './methodRef';
import { renderMethodParamHelp } from './methodHelp';
import { rewriteParamShortcuts } from './paramFlags';
import { formatPrincipalSource, parsePrincipalSpec, type PrincipalSpec } from '@hediet/linkrpc-client';
import { findMethodInSchema } from '@hediet/linkrpc-client';
import { fetchSchemaForMethodRef } from './schemaLookup';
import {
    loadStaticHubSchema,
    resolveStaticHubSchemaSource,
} from './staticHubSchema';
import {
    ContextStore,
    type ContextReference,
    type ContextValues,
    type ValidationMode,
    formatContextReference,
} from './contexts';
import {
    type CliProfile,
    type ResolvedInvocationContext,
    mutationReference,
    resolveInvocationContext,
    resolveInvocationEndpoint,
    validationDefault,
} from './invocationContext';
import { resolveCliInvocation } from './cliInvocation';
import { withStaticHubReflection } from './commands/staticHubReflection';

export async function main(
    rawArgv: readonly string[],
    executableName: 'linkrpc' | 'rpc' | 'hub' = 'linkrpc',
): Promise<void> {
    const cliInvocation = resolveCliInvocation(rawArgv, executableName);
    const profile = cliInvocation.profile;
    const program = new Command();
    program.configureHelp({ showGlobalOptions: true });
    program
        .name(cliInvocation.programName)
        .description(
            profile === 'hub'
                ? 'CLI / TUI for LinkRPC hubs. Shared RPC commands use hub initialization, signing, '
                    + 'capability negotiation, and required schema validation by default.'
                : 'CLI / TUI for JSON-RPC and LinkRPC endpoints. Shared commands use the RPC profile '
                    + 'with automatic schema validation and no endpoint environment override by default.',
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
        .option(
            '--endpoint-token <token>',
            'fill the exact token=% placeholder in --endpoint (or a context endpoint)',
        )
        .option(
            '--endpoint-cmd-cwd <dir>',
            'working directory for the --endpoint-cmd / --endpoint-cmd-stdio child',
        )
        .option(
            '--context <selector>',
            'use an exact folder, id:<name>, :root, or :empty context; otherwise look up from cwd',
        )
        .option(
            '--context-set',
            'persist context-capable overrides supplied on this command to the active context',
        )
        .option(
            '--new-context <selector>',
            'create a new context from the effective command values; fails if it already exists',
        )
        .option('--schema <path-or-url>', 'static schema catalog used for discovery and validation')
        .option(
            '--validation <mode>',
            'schema validation mode: auto, required, or off',
            parseValidationMode,
        )
        .option('--use-env', 'allow LINKRPC_* / legacy HUBRPC_* endpoint variables to override context')
        .option('--no-use-env', 'ignore LINKRPC_* / legacy HUBRPC_* endpoint variables')
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
            profile === 'hub'
                ? 'log every JSON-RPC message to stderr, one coalesced flow per line (like the ' +
                    'VS Code "linkrpc Flows" channel). For `serve` / `-c, --config` this is the ' +
                    'in-process hub\'s routed traffic; for a direct `--endpoint` connection it taps ' +
                    'the client transport. Ignored by `ui`.'
                : 'log every JSON-RPC message on a direct endpoint connection to stderr, one ' +
                    'coalesced flow per line (like the VS Code "linkrpc Flows" channel). Ignored by `ui`.',
        )
        .option(
            '--log-transport',
            'log every raw JSON-RPC message sent and received to stderr, including transport initialization; '
            + 'may expose tokens and other sensitive payloads',
        )
        .showHelpAfterError();
    if (profile === 'hub') {
        program.option(
            '-c, --config <file>',
            'run an in-process hub from this declarative config file and target it (see `serve --print-schema`)',
        );
    }
    /** Parse the effective context/flag principal once the pre-action hook has resolved it. */
    const getPrincipalSpec = (): PrincipalSpec =>
        parsePrincipalSpec(g_invocation?.values.principal);

    // Resolved once per command after inherited options, context defaults, and
    // the profile-specific environment policy have been merged.
    let endpoint: ResolvedEndpoint | undefined;
    let pendingContextSet:
        | {
            readonly store: ContextStore;
            readonly reference: Exclude<ContextReference, { readonly kind: 'empty'; }>;
            readonly values: ContextValues;
        }
        | undefined;
    let pendingNewContext:
        | {
            readonly store: ContextStore;
            readonly reference: Exclude<ContextReference, { readonly kind: 'empty'; }>;
            readonly values: ContextValues;
        }
        | undefined;
    let preparedNewContext:
        | {
            readonly store: ContextStore;
            readonly reference: Exclude<ContextReference, { readonly kind: 'empty'; }>;
        }
        | undefined;
    program.hook('preAction', async (_thisCommand, actionCommand) => {
        const commandPath = getCommandPath(actionCommand);
        const allowMissingContext = commandPath === 'context set';
        const store = new ContextStore();
        const cliOverrides = collectContextOverrides(program, actionCommand);
        const selector = explicitOption<string>(program, 'context');
        const useEnvironment = explicitOption<boolean>(program, 'useEnv');
        g_contextStore = store;
        g_invocation = await resolveInvocationContext({
            profile,
            store,
            ...(selector !== undefined ? { selector } : {}),
            cliOverrides,
            ...(useEnvironment !== undefined ? { useEnvironment } : {}),
            allowMissingContext,
        });
        if (profile === 'rpc' && g_invocation.values.config !== undefined) {
            throw new Error('--config is only available in the hub profile');
        }

        if (program.opts().contextSet === true) {
            if (program.opts().newContext !== undefined) {
                throw new Error('--context-set cannot be combined with --new-context');
            }
            if (Object.keys(cliOverrides).length === 0) {
                throw new Error('--context-set requires at least one context-capable override');
            }
            pendingContextSet = {
                store,
                reference: await mutationReference(store, g_invocation.selected),
                values: cliOverrides,
            };
        }

        if (program.opts().newContext !== undefined) {
            const reference = mutableReference(
                await store.resolveReference(program.opts().newContext as string),
            );
            await store.assertCanCreate(reference);
            preparedNewContext = { store, reference };
        }
        if (preparedNewContext !== undefined && commandPath !== 'connection create') {
            pendingNewContext = {
                store,
                reference: preparedNewContext.reference,
                values: g_invocation.values,
            };
        }

        endpoint = commandUsesEndpoint(commandPath) || hasEndpointOverrides(cliOverrides)
            ? resolveInvocationEndpoint(g_invocation, actionCommand.name() === 'tunnel')
            : undefined;
        g_hubConfigPath = g_invocation.values.config;
        // Message logging goes to stderr, which would corrupt the full-screen
        // TUI — so it applies to every command except `ui`.
        g_logMessages = program.opts().logMessages === true
            && actionCommand.name() !== 'ui';
        g_logTransport = program.opts().logTransport === true
            && actionCommand.name() !== 'ui';
    });
    program.hook('postAction', async () => {
        if (pendingContextSet !== undefined) {
            await pendingContextSet.store.set(
                pendingContextSet.reference,
                pendingContextSet.values,
            );
            process.stderr.write(
                `linkrpc: updated context ${formatContextReference(pendingContextSet.reference)}.\n`,
            );
            pendingContextSet = undefined;
        }
        if (pendingNewContext !== undefined) {
            await createContextFromInvocation(
                pendingNewContext.store,
                pendingNewContext.reference,
                pendingNewContext.values,
            );
            pendingNewContext = undefined;
        }
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
                const legacyOutput = opts.format === undefined && opts.watch !== true;
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

    if (profile === 'hub') {
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
    }

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
        .command('codegen')
        .description('Generate a TypeScript interface definition from an offline schema bundle.')
        .requiredOption('--input <bundle>', 'local static hub schema bundle')
        .requiredOption('--interface <id>', 'interface id to generate')
        .requiredOption('--name <name>', 'exported TypeScript const name')
        .requiredOption('--output <file>', 'generated TypeScript output file')
        .option(
            '--preserve-wire-schema',
            'freeze the canonical input schema verbatim in the generated definition',
        )
        .option('--check', 'fail if the output is missing or stale without overwriting it')
        .action(async (opts) => {
            await codegenCommand({
                input: opts.input,
                interfaceId: opts.interface,
                name: opts.name,
                output: opts.output,
                preserveWireSchema: opts.preserveWireSchema === true,
                check: opts.check === true,
            });
        });

    const schema = program
        .command('schema')
        .description('Inspect, hash, and compare LinkRPC interface schemas.');

    schema
        .command('show <interfaceRef>')
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

    schema
        .command('hash <schema>')
        .description('Compute the hash of a local LinkRpcInterfaceSchema JSON file.')
        .action((schemaPath: string) => {
            const out = hashCommand({ schemaPath });
            process.stdout.write(out + '\n');
        });

    schema
        .command('check-compat <interfaceId> <local>')
        .description('Compare a local schema against the live interface schema.')
        .action(async (interfaceId: string, local: string) => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const verdict = await checkCompatCommand(channel, { interfaceId, localPath: local });
                process.stdout.write(formatVerdict(verdict) + '\n');
                if (verdict.kind === 'incompatible') process.exitCode = 1;
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
                '\n(No endpoint configured: pass --endpoint / --endpoint-cmd or set LINKRPC_ENDPOINT\n'
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
                process.stderr.write("linkrpc: missing required argument 'methodRef'.\n");
                process.stderr.write(cmd.helpInformation());
                process.exit(2);
            }
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const validation = opts.validate === false
                    ? 'off'
                    : effectiveValidation(profile);
                const out = await callCommand(channel, {
                    methodRef,
                    paramsArg: opts.params,
                    paramOverrides: opts.param,
                    validation,
                });
                process.stdout.write(out + '\n');
            }, { requestReflectionAccess: effectiveValidation(profile) !== 'off' });
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
                process.stderr.write("linkrpc: missing required argument 'methodRef'.\n");
                process.stderr.write(cmd.helpInformation());
                process.exit(2);
            }
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const validation = opts.validate === false
                    ? 'off'
                    : effectiveValidation(profile);
                const out = await notifyCommand(channel, {
                    methodRef,
                    paramsArg: opts.params,
                    paramOverrides: opts.param,
                    validation,
                });
                process.stdout.write(out + '\n');
            }, { requestReflectionAccess: effectiveValidation(profile) !== 'off' });
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
                    validation: effectiveValidation(profile),
                    onStreamChunk: ({ index, method, payload }) => {
                        const text = typeof payload === 'string'
                            ? payload
                            : JSON.stringify(payload);
                        process.stderr.write(`[${index + 1} ${method}] ${text}\n`);
                    },
                });
                process.stdout.write(JSON.stringify(results, undefined, 2) + '\n');
            }, {
                requestReflectionAccess: effectiveValidation(profile) !== 'off'
                    && plan.operations.some((operation) => !operation.noValidate),
            });
        });

    const connection = program
        .command('connection')
        .description('Create, inspect, consume, and destroy persistent RPC connections.');

    connection
        .command('create')
        .description('Create a detached persistent connection and print its local endpoint.')
        .option('--timeout <duration>', 'exit after this much transport inactivity')
        .option('--ttl <duration>', 'hard maximum broker lifetime')
        .option(
            '--notification-limit <count>',
            'maximum buffered incoming notifications',
            (value) => parsePositiveInteger(value, '--notification-limit'),
        )
        .action(async (opts: {
            timeout?: string;
            ttl?: string;
            notificationLimit?: number;
        }) => {
            if (g_hubConfigPath !== undefined) {
                throw new Error('connection create does not support --config; use an endpoint URI or command endpoint');
            }
            const schemaSource = g_invocation?.values.schema === undefined
                ? undefined
                : resolveStaticHubSchemaSource(g_invocation.values.schema);
            if (schemaSource !== undefined) {
                await loadStaticHubSchema(schemaSource);
            }
            const timeout = opts.timeout ?? g_invocation?.values.connectionTimeout ?? '30s';
            const ttl = opts.ttl ?? g_invocation?.values.connectionTtl ?? '5min';
            const notificationLimit = opts.notificationLimit
                ?? g_invocation?.values.notificationLimit
                ?? 1_000;
            const brokerEndpoint = await spawnConnectionBroker({
                remote: needEndpoint(endpoint),
                timeoutMs: parseDuration(timeout),
                ttlMs: parseDuration(ttl),
                notificationLimit,
                schemaSource,
            });
            if (preparedNewContext !== undefined) {
                if (g_invocation === undefined) {
                    throw new Error('context resolver is unavailable');
                }
                try {
                    await createConnectionContext(
                        preparedNewContext.store,
                        preparedNewContext.reference,
                        g_invocation.values,
                        brokerEndpoint,
                    );
                } catch (error) {
                    try {
                        await stopConnectionBroker(brokerEndpoint);
                    } catch (cleanupError) {
                        throw new AggregateError(
                            [error, cleanupError],
                            'failed to create the context and stop the new connection broker',
                        );
                    }
                    throw error;
                }
            }
            process.stdout.write(brokerEndpoint + '\n');
        });

    connection
        .command('status')
        .description('Read status from the connection broker at the configured endpoint.')
        .action(async () => {
            await withRawConnection(endpoint, async (channel) => {
                process.stdout.write(JSON.stringify(await getBrokerStatus(channel), undefined, 2) + '\n');
            });
        });

    connection
        .command('destroy')
        .description('Stop the connection broker at the configured endpoint.')
        .action(async () => {
            await withRawConnection(endpoint, async (channel) => {
                await disconnectBroker(channel);
            });
        });

    connection
        .command('notifications')
        .description(
            'Read server notifications buffered by the persistent connection; --follow emits JSON Lines.',
        )
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

    const context = program
        .command('context')
        .description('Show how the active context resolves, or explicitly modify shared context defaults.')
        .action(() => {
            printSelectedContext(true);
        });

    context
        .command('show')
        .description('Show only the selected context and its stored defaults.')
        .action(() => {
            printSelectedContext(false);
        });

    context
        .command('list')
        .description('List every path, named, and root context in the global store.')
        .action(async () => {
            if (g_contextStore === undefined) throw new Error('context store is unavailable');
            for (const item of await g_contextStore.list()) {
                process.stdout.write(`${formatContextReference(item.reference)}\n`);
            }
        });

    context
        .command('set')
        .description(
            'Set explicit context-capable flags on the active context; creates a cwd context when none exists.',
        )
        .option('--unset <key...>', 'remove one or more stored context values')
        .action(async (opts: { unset?: string[] }) => {
            if (g_contextStore === undefined || g_invocation === undefined) {
                throw new Error('context resolver is unavailable');
            }
            const target = explicitOption<string>(program, 'context') !== undefined
                ? mutableReference(g_invocation.selected.reference)
                : await mutationReference(g_contextStore, g_invocation.selected);
            const overrides = g_invocation.cliOverrides;
            const unset = (opts.unset ?? []).map(parseContextValueKey);
            if (Object.keys(overrides).length === 0 && unset.length === 0) {
                throw new Error('context set requires at least one context-capable flag or --unset');
            }
            let result = Object.keys(overrides).length === 0
                ? g_invocation.selected.context
                : await g_contextStore.set(target, overrides);
            if (unset.length > 0) {
                result = await g_contextStore.unset(target, unset);
            }
            process.stdout.write(`Updated context ${formatContextReference(target)}.\n`);
            if (result !== undefined) printContextValues(result.values, false);
        });

    context
        .command('remove')
        .description('Remove the selected context from the global store.')
        .action(async () => {
            if (g_contextStore === undefined || g_invocation === undefined) {
                throw new Error('context resolver is unavailable');
            }
            const reference = g_invocation.selected.reference;
            if (
                reference.kind === 'empty'
                || (reference.kind === 'root' && explicitOption<string>(program, 'context') === undefined)
            ) {
                throw new Error('select the context to remove explicitly with --context');
            }
            const removed = await g_contextStore.remove(reference);
            if (!removed) throw new Error(`context ${formatContextReference(reference)} does not exist`);
            process.stdout.write(`Removed context ${formatContextReference(reference)}.\n`);
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
        .command('ping')
        .description('One reflection round-trip; prints latency.')
        .action(async () => {
            await withChannel(endpoint, getPrincipalSpec(), async (channel) => {
                const out = await pingCommand(channel);
                process.stdout.write(out + '\n');
            });
        });
    if (profile === 'hub') {
        program
            .command('json-rpc-stdio <serviceId>')
            .description(
                'Expose <serviceId>::jsonRpcConnection::connectRaw as a newline-delimited '
                + "JSON-RPC endpoint on this process's stdin/stdout.",
            )
            .option('--params <json>', 'JSON value passed to the remote transport factory')
            .action(async (serviceId: string, opts: { params?: string; }) => {
                const localEp = needEndpoint(endpoint);
                let params: JsonValue | undefined;
                if (opts.params !== undefined) {
                    try {
                        params = JSON.parse(opts.params) as JsonValue;
                    } catch (error) {
                        throw new InvalidArgumentError(
                            `invalid --params JSON: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
                const local = await connectEndpoint(localEp, wireLog('hub'));
                try {
                    const session = await setupSigning(local.channel, local.signing, getPrincipalSpec(), {
                        negotiateHubCaps: isHubEndpoint(localEp),
                    });
                    reportIdentity(session);
                    await jsonRpcStdioCommand({
                        local,
                        serviceId,
                        ...(params === undefined ? {} : { params }),
                    });
                } finally {
                    local.close();
                }
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
                process.stderr.write('linkrpc: serve requires a <config> file (or --print-schema).\n');
                process.exit(2);
            }
            await serveCommand({
                configPath: config,
                cmdInteractive: opts.cmdInteractive,
                logMessages: g_logMessages,
            });
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
            'spawn the target and talk linkrpc over its stdio',
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
                    `linkrpc: tunnel: claimed '${serviceId}' on source via config hub. Ctrl-C to stop.\n`,
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
                process.stderr.write(`linkrpc: ${targetRes.error}\n`);
                process.exit(2);
            }
            if (!targetRes.endpoint) {
                process.stderr.write(
                    'linkrpc: tunnel requires --target-endpoint / --target-endpoint-cmd / --target-endpoint-cmd-stdio.\n',
                );
                process.exit(2);
            }
            const targetEp = targetRes.endpoint;
            // Honor the legacy LINKRPC_REMOTE_ENDPOINT_TOKEN env var as a fallback
            // for token-bearing target URIs.
            const remoteTok = process.env.LINKRPC_REMOTE_ENDPOINT_TOKEN;
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
        .option('--target-endpoint-cmd-stdio <command>', 'spawn the target and talk linkrpc over its stdio')
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
                process.stderr.write(`linkrpc: ${(e as Error).message}\n`);
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
                process.stderr.write(`linkrpc: ${targetRes.error}\n`);
                process.exit(2);
            }
            if (!targetRes.endpoint) {
                process.stderr.write(
                    'linkrpc: connect-as requires --target-endpoint / --target-endpoint-cmd / --target-endpoint-cmd-stdio.\n',
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

                const brokerConn = new LinkRpcConnection(broker.rpcChannel);
                const binder = brokerConn.service(binderServiceId).get(connectionTokenBinderInterface);

                const logLine = (line: string): void => { process.stderr.write(`linkrpc: ${line}\n`); };
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
            '`linkrpc mcp-forward -- npx -y @modelcontextprotocol/server-everything` or ' +
            '`linkrpc mcp-forward --serviceId my-mcp -- npx -y @modelcontextprotocol/server-everything`. ' +
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
                    'linkrpc: mcp-forward requires an MCP server command after `--`, e.g. ' +
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
    }

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

    if (profile === 'hub') {
        program
            .command('logout')
            .description(
                'Delete the stored CLI identity and cached capabilities. Next call will mint a fresh keypair and prompt for consent again.',
            )
            .action(async () => {
                const removed = await logoutCliIdentity();
                if (removed.length === 0) {
                    process.stdout.write('linkrpc: no stored identity found.\n');
                    return;
                }
                for (const f of removed) {
                    process.stdout.write(`removed ${f}\n`);
                }
            });
    }

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
                process.stderr.write(`linkrpc: ${(e as Error).message}\n`);
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

    if (profile === 'rpc') {
        program
            .command('hub')
            .description('Run the same shared commands with the hub profile and expose hub-only commands.');
    }

    await program.parseAsync([
        'node',
        cliInvocation.programName,
        ...rewriteParamShortcuts(cliInvocation.argv),
    ]);
}

function collectContextOverrides(program: Command, actionCommand: Command): ContextValues {
    const opts = program.opts();
    const result: Record<string, unknown> = {};
    copyExplicit(program, opts, result, 'endpoint');
    copyExplicit(program, opts, result, 'endpointCmd');
    copyExplicit(program, opts, result, 'endpointCmdStdio');
    copyExplicit(program, opts, result, 'endpointCmdEnv');
    copyExplicit(program, opts, result, 'endpointToken');
    copyExplicit(program, opts, result, 'endpointCmdCwd');
    copyExplicit(program, opts, result, 'config');
    copyExplicit(program, opts, result, 'provisionIdentity');
    copyExplicit(program, opts, result, 'provisionIdentitySlot');
    copyExplicit(program, opts, result, 'principal');
    copyExplicit(program, opts, result, 'schema');
    copyExplicit(program, opts, result, 'validation');

    if (getCommandPath(actionCommand) === 'connection create') {
        const actionOpts = actionCommand.opts();
        copyExplicit(actionCommand, actionOpts, result, 'timeout', 'connectionTimeout');
        copyExplicit(actionCommand, actionOpts, result, 'ttl', 'connectionTtl');
        copyExplicit(actionCommand, actionOpts, result, 'notificationLimit');
    }
    return result as ContextValues;
}

function copyExplicit(
    command: Command,
    source: Record<string, unknown>,
    target: Record<string, unknown>,
    optionName: string,
    contextName = optionName,
): void {
    if (command.getOptionValueSource(optionName) === 'cli') {
        target[contextName] = source[optionName];
    }
}

function explicitOption<T>(command: Command, name: string): T | undefined {
    return command.getOptionValueSource(name) === 'cli'
        ? command.opts()[name] as T
        : undefined;
}

async function createContextFromInvocation(
    store: ContextStore,
    reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
    values: ContextValues,
): Promise<void> {
    await store.replace(reference, values, { createOnly: true });
    process.stderr.write(`linkrpc: created context ${formatContextReference(reference)}.\n`);
}

async function createConnectionContext(
    store: ContextStore,
    reference: Exclude<ContextReference, { readonly kind: 'empty'; }>,
    values: ContextValues,
    brokerEndpoint: string,
): Promise<void> {
    const {
        endpoint: _endpoint,
        endpointCmd: _endpointCmd,
        endpointCmdStdio: _endpointCmdStdio,
        endpointCmdEnv: _endpointCmdEnv,
        endpointToken: _endpointToken,
        endpointCmdCwd: _endpointCmdCwd,
        provisionIdentity: _provisionIdentity,
        provisionIdentitySlot: _provisionIdentitySlot,
        ...rest
    } = values;
    const connectionEndpoint = splitEndpointToken(brokerEndpoint);
    await createContextFromInvocation(store, reference, {
        ...rest,
        ...connectionEndpoint,
    });
}

function splitEndpointToken(endpoint: string): Pick<ContextValues, 'endpoint' | 'endpointToken'> {
    const parsed = parseEndpointUri(endpoint);
    if ((parsed.kind !== 'socket' && parsed.kind !== 'ws') || parsed.token === undefined) {
        return { endpoint };
    }
    const { token, ...withoutToken } = parsed;
    const separator = formatEndpointUri(withoutToken).includes('?') ? '&' : '?';
    return {
        endpoint: `${formatEndpointUri(withoutToken)}${separator}token=%`,
        endpointToken: token,
    };
}

async function stopConnectionBroker(endpoint: string): Promise<void> {
    const connection = await connectEndpoint(parseEndpointUri(endpoint));
    try {
        await disconnectBroker(connection.channel);
    } finally {
        connection.close();
    }
}

function mutableReference(
    reference: ContextReference,
): Exclude<ContextReference, { readonly kind: 'empty'; }> {
    if (reference.kind === 'empty') {
        throw new Error(':empty is immutable and cannot be modified');
    }
    return reference;
}

function printSelectedContext(effective: boolean): void {
    if (g_invocation === undefined) throw new Error('context resolver is unavailable');
    const selected = g_invocation.selected;
    process.stdout.write('Context\n');
    process.stdout.write(`  Reference: ${formatContextReference(selected.reference)}\n`);
    process.stdout.write(`  Selected via: ${contextSelectionDescription(selected.selectedBy)}\n`);
    if (effective) {
        process.stdout.write(`  Profile: ${g_invocation.profile}\n`);
        const environmentStatus = g_invocation.environmentApplied
            ? Object.keys(g_invocation.environmentValues).length > 0
                ? 'enabled'
                : 'enabled (no variables set)'
            : 'disabled';
        process.stdout.write(
            `  Environment overrides: ${environmentStatus}\n`,
        );
    }

    process.stdout.write('\nStored defaults\n');
    printContextValues(selected.context?.values ?? {}, false);
    if (!effective) return;

    process.stdout.write('\nEffective values\n');
    printContextValues(g_invocation.values, false, (key) => {
        if (hasContextValue(g_invocation?.cliOverrides, key)) return 'command line';
        if (hasContextValue(g_invocation?.environmentValues, key)) return 'environment';
        if (hasContextValue(g_invocation?.contextValues, key)) return 'context';
        return undefined;
    });
}

function contextSelectionDescription(selectedBy: ResolvedInvocationContext['selected']['selectedBy']): string {
    switch (selectedBy) {
        case 'argument': return '--context';
        case 'environment': return 'LINKRPC_CONTEXT (HUBRPC_CONTEXT fallback)';
        case 'cwd': return 'current-directory lookup';
        case 'root': return ':root fallback';
        case 'empty': return 'no matching context (:empty)';
    }
}

function hasContextValue(
    values: ContextValues | undefined,
    key: keyof ContextValues,
): boolean {
    return values !== undefined && values[key] !== undefined;
}

function printContextValues(
    values: ContextValues,
    revealToken: boolean,
    source?: (key: keyof ContextValues) => string | undefined,
): void {
    const entries = Object.entries(values);
    if (entries.length === 0) {
        process.stdout.write('  (none)\n');
        return;
    }
    for (const [key, value] of entries) {
        const contextKey = key as keyof ContextValues;
        const rendered = key === 'endpointToken' && !revealToken
            ? '<stored>'
            : key === 'endpoint' && typeof value === 'string' && !revealToken
                ? redactEndpointTokens(value)
            : typeof value === 'string'
                ? value
                : JSON.stringify(value);
        const valueSource = source?.(contextKey);
        process.stdout.write(
            `  --${contextValueFlag(contextKey)} = ${rendered}${valueSource ? `  (${valueSource})` : ''}\n`,
        );
    }

    function redactEndpointTokens(endpoint: string): string {
        return endpoint.replace(/([?&]token=)([^&#]*)/g, (_match, prefix: string, token: string) =>
            `${prefix}${token === '%' ? '%' : '<stored>'}`);
    }
}

function contextValueFlag(key: keyof ContextValues): string {
    const names: Record<keyof ContextValues, string> = {
        endpoint: 'endpoint',
        endpointCmd: 'endpoint-cmd',
        endpointCmdStdio: 'endpoint-cmd-stdio',
        endpointCmdEnv: 'endpoint-cmd-env',
        endpointToken: 'endpoint-token',
        endpointCmdCwd: 'endpoint-cmd-cwd',
        config: 'config',
        provisionIdentity: 'provision-identity',
        provisionIdentitySlot: 'provision-identity-slot',
        principal: 'principal',
        schema: 'schema',
        validation: 'validation',
        connectionTimeout: 'connection-timeout',
        connectionTtl: 'connection-ttl',
        notificationLimit: 'notification-limit',
    };
    return names[key];
}

function parseContextValueKey(value: string): keyof ContextValues {
    const entry = (Object.keys({
        endpoint: true,
        endpointCmd: true,
        endpointCmdStdio: true,
        endpointCmdEnv: true,
        endpointToken: true,
        endpointCmdCwd: true,
        config: true,
        provisionIdentity: true,
        provisionIdentitySlot: true,
        principal: true,
        schema: true,
        validation: true,
        connectionTimeout: true,
        connectionTtl: true,
        notificationLimit: true,
    }) as (keyof ContextValues)[]).find((key) => contextValueFlag(key) === value);
    if (entry === undefined) throw new InvalidArgumentError(`unknown context value "${value}"`);
    return entry;
}

function effectiveValidation(profile: CliProfile): ValidationMode {
    return g_invocation?.values.validation ?? validationDefault(profile);
}

function parseValidationMode(value: string): ValidationMode {
    if (value === 'auto' || value === 'required' || value === 'off') return value;
    throw new InvalidArgumentError("--validation must be 'auto', 'required', or 'off'");
}

function getCommandPath(command: Command): string {
    const names: string[] = [];
    for (let cursor: Command | null = command; cursor?.parent !== null; cursor = cursor.parent) {
        names.unshift(cursor.name());
    }
    return names.join(' ');
}

function commandUsesEndpoint(commandPath: string): boolean {
    return !(
        commandPath === 'context'
        || commandPath.startsWith('context ')
        || commandPath === 'codegen'
        || commandPath === 'schema hash'
        || commandPath === 'completions'
        || commandPath === '_complete'
        || commandPath === '_connection-broker'
        || commandPath === 'serve'
        || commandPath === 'logout'
    );
}

function hasEndpointOverrides(values: ContextValues): boolean {
    return values.endpoint !== undefined
        || values.endpointCmd !== undefined
        || values.endpointCmdStdio !== undefined
        || values.endpointCmdEnv !== undefined
        || values.endpointToken !== undefined
        || values.endpointCmdCwd !== undefined
        || values.provisionIdentity !== undefined
        || values.provisionIdentitySlot !== undefined;
}

async function withChannel(
    endpoint: ResolvedEndpoint | undefined,
    principalSpec: PrincipalSpec,
    fn: (channel: import('@hediet/linkrpc-client').CliChannel) => Promise<void>,
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
        const schemaSource = g_invocation?.values.schema;
        const channel = schemaSource === undefined
            ? conn.channel
            : withStaticHubReflection(conn.channel, await loadStaticHubSchema(schemaSource));
        if (
            acquired.ep.kind === 'ws-no-init'
            || (acquired.ep.kind === 'socket' && acquired.ep.brokerMode === 'raw')
        ) {
            await fn(channel);
            return;
        }
        if (g_invocation?.profile === 'rpc') {
            await fn(channel);
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
            && schemaSource === undefined
            && (acquired.running !== undefined || isHubEndpoint(acquired.ep))
        ) {
            const status = await requestReflectionAccess(session);
            if (status === 'denied') {
                process.stderr.write(
                    'linkrpc: reflection access denied; falling back to per-call negotiation.\n',
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
                    'linkrpc: topology access denied; topology sources may be inaccessible.\n',
                );
            }
        }
        await fn(channel);
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
        throw new Error('identity and approval commands require a LinkRPC endpoint');
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
    log: (line: string) => void = (line) => process.stderr.write(`linkrpc: ${line}\n`),
): Promise<void> {
    await withResolvedSigning(endpoint, principalSpec, async (conn, session) => {
        reportIdentity(session);
        await bootstrapApprovalCommandCapability(session.principal);
        const connection = new LinkRpcConnection(conn.rpcChannel);
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
    fn: (channel: import('@hediet/linkrpc-client').CliChannel) => Promise<void>,
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
let g_contextStore: ContextStore | undefined;
let g_invocation: ResolvedInvocationContext | undefined;

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
            ? { log: (line: string) => process.stderr.write(`linkrpc: ${line}\n`) }
            : {}),
        ...(g_logTransport
            ? {
                trace: (direction: 'send' | 'receive', message: import('@hediet/linkrpc').JsonRpcMessage) =>
                    process.stderr.write(`linkrpc: transport ${direction} ${JSON.stringify(message)}\n`),
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
        `linkrpc: identity ${formatPrincipalSource(session.principalSource, session.principal.id)
        }\n`,
    );
}

function needEndpoint(endpoint: ResolvedEndpoint | undefined): ResolvedEndpoint {
    if (!endpoint) {
        process.stderr.write(
            'linkrpc: this command requires --endpoint / --endpoint-cmd / --endpoint-cmd-stdio ' +
            'or the LINKRPC_ENDPOINT env var to be set.\n',
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

export function runCli(executableName: 'linkrpc' | 'rpc' | 'hub'): void {
    main(process.argv.slice(2), executableName).catch((e: unknown) => {
        process.stderr.write(`linkrpc: ${formatCliError(e)}\n`);
        process.exit(1);
    });
}

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
