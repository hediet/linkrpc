/**
 * Shared completion core: resolve a command line + cursor into a structured
 * candidate list, opening a best-effort hub connection when the slot needs
 * dynamic data.
 *
 * This is the reusable engine behind two front-ends:
 *   - the CLI's `_complete` command (see `../commands/internalComplete.ts`),
 *     which formats the result as `text\ttooltip` lines for shell scripts;
 *   - the VS Code extension's terminal completion provider, which maps the
 *     structured result onto `TerminalCompletionItem`s.
 *
 * Endpoint selection is caller-controllable: `endpointOverride` wins over the
 * line's `--endpoint`, and `env` controls (or disables, via `{}`) the
 * `LINKRPC_ENDPOINT` fallback — the extension passes `{}` so completion targets
 * the endpoint named on the line rather than the extension host's environment.
 */
import { setupSigning } from '@hediet/linkrpc-client';
import { parsePrincipalSpec } from '@hediet/linkrpc-client';
import { connect } from '@hediet/linkrpc-client';
import { isHubEndpoint } from '@hediet/linkrpc/node';
import { type ResolvedEndpoint } from '@hediet/linkrpc-client';
import { complete, type CompleteOptions, type Completion } from './complete';
import { withFileCache } from './cache';
import { ChannelDirectorySource, type DirectorySource } from './directorySource';
import { parseLine } from './parse';
import { resolveSlot, type Slot } from './resolve';
import {
    HUB_COMMAND_TREE,
    RPC_COMMAND_TREE,
    type SlotType,
} from './tree';
import { ContextStore, type ContextValues } from '../contexts';
import {
    type CliProfile,
    resolveInvocationContext,
    resolveInvocationEndpoint,
} from '../invocationContext';
import { loadStaticHubSchema, type StaticHubSchema } from '../staticHubSchema';
import { withStaticHubReflection } from '../commands/staticHubReflection';
import { normalizeCliExecutable } from '../cliInvocation';

/** Slot types that require talking to a hub. Anything else is static-only. */
const DYNAMIC_SLOT_TYPES: ReadonlySet<SlotType> = new Set([
    'serviceId',
    'interfaceId',
    'interfaceRef',
    'methodRef',
]);

export interface CompleteForLineOptions {
    readonly line: string;
    readonly point: number;
    /**
     * Endpoint URI to connect to, overriding any `--endpoint` on the line and
     * the env fallback. When omitted, the line's `--endpoint` (then `env`) is
     * used.
     */
    readonly endpointOverride?: string;
    /**
     * Environment consulted for the `LINKRPC_ENDPOINT` fallback. Defaults to
     * `process.env`. Pass `{}` to disable the env fallback entirely (the
     * extension does this so completion never targets the extension host's
     * environment).
     */
    readonly env?: NodeJS.ProcessEnv;
    /** Override the directory source (tests). */
    readonly directoryOverride?: DirectorySource;
    /** Suppress the connect attempt entirely (tests). */
    readonly skipConnect?: boolean;
}

export interface CompleteForLineResult {
    /** Completion candidates, already prefix-filtered, sorted and de-duped. */
    readonly candidates: readonly Completion[];
    /** The resolved slot the cursor sits in (subcommand / flag / positional). */
    readonly slot: Slot;
    /**
     * Offset of the first character the candidate replaces (i.e. the start of
     * the current word). Equal to `point - replacementLength`.
     */
    readonly replacementIndex: number;
    /** Length of the current word prefix the candidate replaces. */
    readonly replacementLength: number;
}

/**
 * Resolve completion candidates for the cursor at `point` in `line`, opening a
 * hub connection only when the slot needs dynamic data.
 */
export async function completeForLine(
    opts: CompleteForLineOptions,
): Promise<CompleteForLineResult> {
    const parsed = parseLine(opts.line, opts.point);
    const executable = normalizeCliExecutable(parsed.tokensBefore[0]?.text);
    const tree = executable === 'hub' ? HUB_COMMAND_TREE : RPC_COMMAND_TREE;
    const ctx = resolveSlot(parsed, tree);
    const profile: CliProfile = executable === 'hub' || ctx.commandPath[0]?.name === 'hub'
        ? 'hub'
        : 'rpc';
    const prefix = parsed.currentWordPrefix;

    let directory: DirectorySource | undefined = opts.directoryOverride;
    let closeConnection: (() => void) | undefined;
    if (!directory && !opts.skipConnect && _slotWantsDynamic(ctx.slot)) {
        const opened = await _openDirectoryFromLine(ctx.seenFlagValues, {
            endpointOverride: opts.endpointOverride,
            env: opts.env,
            profile,
        });
        directory = opened?.source;
        closeConnection = opened?.close;
    }

    try {
        const completeOpts: CompleteOptions = {
            line: opts.line,
            point: opts.point,
            tree,
            ...(directory !== undefined ? { directory } : {}),
        };
        const candidates = await complete(completeOpts);
        return {
            candidates,
            slot: ctx.slot,
            replacementIndex: opts.point - prefix.length,
            replacementLength: prefix.length,
        };
    } finally {
        closeConnection?.();
    }
}

function _slotWantsDynamic(slot: Slot): boolean {
    if (slot.kind === 'flag-value') {
        return slot.flag.valueType !== undefined && DYNAMIC_SLOT_TYPES.has(slot.flag.valueType);
    }
    if (slot.kind === 'positional') return DYNAMIC_SLOT_TYPES.has(slot.type);
    return false;
}

interface OpenedDirectory {
    readonly source: DirectorySource;
    readonly close: () => void;
}

interface OpenDirectoryOptions {
    readonly endpointOverride?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly profile: CliProfile;
}

/**
 * Try to open a `DirectorySource` against the hub the partial command line
 * points at (or `endpointOverride`). The returned `close()` MUST be called:
 * the underlying socket otherwise keeps the process alive past action return,
 * hanging the user's prompt.
 *
 * Any failure → `undefined` (the orchestrator falls back to static-only).
 */
async function _openDirectoryFromLine(
    seenFlagValues: ReadonlyMap<string, string | undefined>,
    opts: OpenDirectoryOptions,
): Promise<OpenedDirectory | undefined> {
    try {
        return await _openDirectoryFromLineCore(seenFlagValues, opts);
    } catch {
        return undefined;
    }
}

async function _openDirectoryFromLineCore(
    seenFlagValues: ReadonlyMap<string, string | undefined>,
    opts: OpenDirectoryOptions,
): Promise<OpenedDirectory | undefined> {
    const invocation = await resolveInvocationContext({
        profile: opts.profile,
        store: new ContextStore(),
        selector: seenFlagValues.get('--context'),
        cliOverrides: completionContextOverrides(seenFlagValues, opts.endpointOverride),
        env: opts.env,
        useEnvironment: seenFlagValues.has('--use-env')
            ? true
            : seenFlagValues.has('--no-use-env')
                ? false
                : undefined,
    });
    let endpoint: ResolvedEndpoint | undefined;
    try {
        endpoint = resolveInvocationEndpoint(invocation);
    } catch {
        return undefined;
    }
    if (endpoint === undefined) return undefined;

    // Never spawn a child process during completion (cmd / cmd-stdio / cmd-env).
    if (
        endpoint.kind !== 'socket'
        && endpoint.kind !== 'ws'
        && endpoint.kind !== 'ws-no-init'
    ) return undefined;

    const opened = await _connectWithDeadline(endpoint, 800);
    if (!opened) return undefined;
    const isRaw = endpoint.kind === 'ws-no-init'
        || (endpoint.kind === 'socket' && endpoint.brokerMode === 'raw');
    if (opts.profile === 'hub' && !isRaw) {
        try {
            const principalSpec = parsePrincipalSpec(invocation.values.principal);
            await _withDeadline(
                setupSigning(opened.channel, opened.signing, principalSpec, {
                    negotiateHubCaps: isHubEndpoint(endpoint),
                }),
                800,
            );
        } catch {
            opened.close();
            return undefined;
        }
    }
    const staticSchema = invocation.values.schema === undefined
        ? undefined
        : await loadStaticHubSchema(invocation.values.schema);
    const channel = staticSchema === undefined
        ? opened.channel
        : withStaticHubReflection(opened.channel, staticSchema);
    const live = new ChannelDirectorySource(channel);
    const cached = withFileCache(live, _endpointCacheKey(endpoint, staticSchema));
    return { source: cached, close: () => opened.close() };
}

function completionContextOverrides(
    seen: ReadonlyMap<string, string | undefined>,
    endpointOverride: string | undefined,
): ContextValues {
    const endpoint = endpointOverride ?? seen.get('--endpoint');
    return {
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(seen.get('--endpoint-cmd') !== undefined
            ? { endpointCmd: seen.get('--endpoint-cmd') }
            : {}),
        ...(seen.get('--endpoint-cmd-stdio') !== undefined
            ? { endpointCmdStdio: seen.get('--endpoint-cmd-stdio') }
            : {}),
        ...(endpointOverride === undefined && seen.get('--endpoint-token') !== undefined
            ? { endpointToken: seen.get('--endpoint-token') }
            : {}),
        ...(seen.has('--provision-identity') ? { provisionIdentity: true } : {}),
        ...(seen.get('--provision-identity-slot') !== undefined
            ? { provisionIdentitySlot: seen.get('--provision-identity-slot') }
            : {}),
        ...(seen.get('--principal') !== undefined ? { principal: seen.get('--principal') } : {}),
        ...(seen.get('--schema') !== undefined ? { schema: seen.get('--schema') } : {}),
    };
}

/**
 * Race `connect` against a soft deadline. On timeout, the connect promise's
 * resolved connection (if any) is closed so it doesn't leak.
 */
async function _connectWithDeadline(
    endpoint: ResolvedEndpoint,
    deadlineMs: number,
): Promise<Awaited<ReturnType<typeof connect>> | undefined> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            resolve(undefined);
        }, deadlineMs);
    });
    try {
        const connectPromise = connect(endpoint).catch(() => undefined);
        const conn = await Promise.race([connectPromise, timeout]);
        if (timedOut) {
            // The connect may still resolve after we've moved on — make sure
            // we close it so the socket doesn't keep the process alive.
            void connectPromise.then((late) => late?.close());
            return undefined;
        }
        return conn ?? undefined;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Reject `p` with a timeout error after `deadlineMs`, without leaking the timer. */
async function _withDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline exceeded')), deadlineMs);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function _endpointCacheKey(
    endpoint: ResolvedEndpoint,
    staticSchema: StaticHubSchema | undefined,
): string {
    const endpointKey = endpoint.kind === 'socket'
        ? `socket:${endpoint.path}`
        : endpoint.kind === 'ws'
            ? `ws:${endpoint.url}`
            : endpoint.kind === 'ws-no-init'
                ? `ws-no-init:${endpoint.url}`
                : `${endpoint.kind}:?`;
    return staticSchema === undefined
        ? endpointKey
        : `${endpointKey}|schema:${JSON.stringify(staticSchema)}`;
}
