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
import { resolveEndpoint, type ResolvedEndpoint } from '@hediet/linkrpc-client';
import { complete, type CompleteOptions, type Completion } from './complete';
import { withFileCache } from './cache';
import { ChannelDirectorySource, type DirectorySource } from './directorySource';
import { parseLine } from './parse';
import { resolveSlot, type Slot } from './resolve';
import { COMMAND_TREE, type SlotType } from './tree';

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
    const ctx = resolveSlot(parsed, COMMAND_TREE);
    const prefix = parsed.currentWordPrefix;

    let directory: DirectorySource | undefined = opts.directoryOverride;
    let closeConnection: (() => void) | undefined;
    if (!directory && !opts.skipConnect && _slotWantsDynamic(ctx.slot)) {
        const opened = await _openDirectoryFromLine(ctx.seenFlagValues, {
            endpointOverride: opts.endpointOverride,
            env: opts.env,
        });
        directory = opened?.source;
        closeConnection = opened?.close;
    }

    try {
        const completeOpts: CompleteOptions = {
            line: opts.line,
            point: opts.point,
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
    const epResult = resolveEndpoint({
        endpoint: opts.endpointOverride ?? seenFlagValues.get('--endpoint'),
        endpointCmd: seenFlagValues.get('--endpoint-cmd'),
        endpointCmdStdio: seenFlagValues.get('--endpoint-cmd-stdio'),
        endpointToken: seenFlagValues.get('--endpoint-token'),
        provisionIdentity: seenFlagValues.has('--provision-identity'),
        provisionIdentitySlot: seenFlagValues.get('--provision-identity-slot'),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    if (epResult.error || !epResult.endpoint) return undefined;
    const endpoint = epResult.endpoint;

    // Never spawn a child process during completion (cmd / cmd-stdio / cmd-env).
    if (endpoint.kind !== 'socket' && endpoint.kind !== 'ws') return undefined;

    const opened = await _connectWithDeadline(endpoint, 800);
    if (!opened) return undefined;
    try {
        const principalSpec = parsePrincipalSpec(seenFlagValues.get('--principal'));
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
    const live = new ChannelDirectorySource(opened.channel);
    const cached = withFileCache(live, _endpointCacheKey(endpoint));
    return { source: cached, close: () => opened.close() };
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

function _endpointCacheKey(endpoint: ResolvedEndpoint): string {
    if (endpoint.kind === 'socket') return `socket:${endpoint.path}`;
    if (endpoint.kind === 'ws') return `ws:${endpoint.url}`;
    return `${endpoint.kind}:?`;
}
