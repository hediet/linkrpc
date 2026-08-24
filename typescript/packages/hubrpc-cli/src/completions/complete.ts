/**
 * Top-level completion orchestrator. Takes a command line + cursor position,
 * resolves what's being completed, and returns the candidate list. The
 * resolver is the only thing that needs to be wire-aware (subcommand /
 * positional / flag / flag-value); everything past that is either a static
 * filter against the {@link CommandTree} or a query against a
 * {@link DirectorySource}.
 */
import {
    distinctInterfaceIds,
    distinctServiceIds,
    interfacesOnService,
    type DirectorySource,
} from './directorySource';
import { parseLine } from './parse';
import { resolveSlot, type ResolvedContext, type Slot } from './resolve';
import { COMMAND_TREE, type CommandTree, type SlotType } from './tree';

export interface Completion {
    /** Text to replace the current word with. */
    readonly text: string;
    /** Tooltip / second-line detail (e.g. method signature). */
    readonly tooltip?: string;
}

export interface CompleteOptions {
    readonly line: string;
    readonly point: number;
    readonly tree?: CommandTree;
    /**
     * Source of dynamic candidates. Omit to skip dynamic lookups entirely
     * (only static completions returned) — useful when no hub is configured.
     */
    readonly directory?: DirectorySource;
}

const SHELLS: readonly string[] = ['powershell', 'bash', 'zsh', 'fish'];

/**
 * Resolve completion candidates for the cursor at `point` in `line`.
 *
 * The slot kinds returned by {@link resolveSlot} map to:
 *   - `subcommand` / `flag-name` / static-typed `flag-value` / static-typed
 *     `positional` → filter against the {@link CommandTree}
 *   - `flag-value` / `positional` with a dynamic slot type → call into
 *     `directory` (skipped when `directory` is `undefined`)
 *   - `flag-name` under `call`/`notify` with a methodRef typed → adds
 *     `--p:<name>` shortcuts for the live params
 *   - `none` → empty
 *
 * Candidates are always prefix-filtered so the caller (PowerShell) can
 * enumerate the result as-is. The output is sorted and de-duplicated.
 */
export async function complete(opts: CompleteOptions): Promise<Completion[]> {
    const tree = opts.tree ?? COMMAND_TREE;
    const parsed = parseLine(opts.line, opts.point);
    const ctx = resolveSlot(parsed, tree);
    const prefix = parsed.currentWordPrefix;

    const stat = _staticCandidates(ctx.slot, prefix, tree);
    const dyn = opts.directory
        ? await _dynamicCandidates(ctx, prefix, opts.directory)
        : [];

    const seen = new Set<string>();
    const merged: Completion[] = [];
    for (const c of [...stat, ...dyn]) {
        if (seen.has(c.text)) continue;
        seen.add(c.text);
        merged.push(c);
    }
    return merged.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

function _staticCandidates(slot: Slot, prefix: string, tree: CommandTree): Completion[] {
    if (slot.kind === 'subcommand') {
        return tree.subcommands
            .filter((s) => !s.hidden && s.name.startsWith(prefix))
            .map((s) => ({ text: s.name, tooltip: s.description }));
    }
    if (slot.kind === 'flag-name') {
        const flags = [...(slot.subcommand?.options ?? []), ...tree.globalOptions];
        const eq = prefix.indexOf('=');
        const lookupPrefix = eq >= 0 ? prefix.slice(0, eq) : prefix;
        return flags
            .filter((f) => f.name.startsWith(lookupPrefix))
            .map((f) => ({ text: f.name, tooltip: f.description }));
    }
    if (slot.kind === 'flag-value' || slot.kind === 'positional') {
        const type: SlotType = slot.kind === 'flag-value' ? (slot.flag.valueType ?? 'free') : slot.type;
        if (type === 'shell') {
            return SHELLS.filter((s) => s.startsWith(prefix)).map((s) => ({ text: s }));
        }
    }
    return [];
}

async function _dynamicCandidates(
    ctx: ResolvedContext,
    prefix: string,
    dir: DirectorySource,
): Promise<Completion[]> {
    const slot = ctx.slot;

    // `--p:<name>` shortcut: only meaningful under `call` / `notify`, and
    // only when the user has already typed the methodRef positional.
    // Triggers on flag-name slots (user typed `-...`) AND on the
    // post-positional gap (slot `none`) so an empty TAB after the methodRef
    // still surfaces the param flags.
    const inFlagOrEmptySlot = slot.kind === 'flag-name'
        || (slot.kind === 'none' && (prefix === '' || prefix.startsWith('-')));
    if (inFlagOrEmptySlot
        && (ctx.subcommand?.name === 'call' || ctx.subcommand?.name === 'notify')
        && ctx.seenPositionals.length >= 1) {
        const methodRef = ctx.seenPositionals[0];
        const ref = _parseMethodRefForCompletion(methodRef);
        if (ref !== undefined && ref.interfaceId !== undefined) {
            const names = await _safeParams(dir, ref.serviceId, ref.interfaceId, ref.methodName);
            return names
                .map((n) => `--p:${n}`)
                .filter((c) => c.startsWith(prefix))
                .map((c) => ({ text: c, tooltip: `method param: ${c.slice('--p:'.length)}` }));
        }
    }

    let type: SlotType | undefined;
    if (slot.kind === 'flag-value') type = slot.flag.valueType;
    else if (slot.kind === 'positional') type = slot.type;
    if (!type) return [];

    if (type === 'serviceId') {
        const entries = await dir.entries();
        return distinctServiceIds(entries)
            .filter((s) => s.startsWith(prefix))
            .map((s) => ({ text: s }));
    }
    if (type === 'interfaceId' || type === 'interfaceRef') {
        const entries = await dir.entries();
        return distinctInterfaceIds(entries)
            .filter((i) => i.startsWith(prefix))
            .map((i) => ({ text: i }));
    }
    if (type === 'methodRef') {
        return _completeMethodRef(prefix, dir);
    }
    return [];
}

/**
 * Complete a `[serviceId::][interfaceId::]methodName[@hash]` reference. The
 * three forms are disambiguated by how many `::` the prefix contains so far.
 * Each TAB-cycle is a complete word (no trailing `::`) — the user adds the
 * next separator themselves to drill in. That keeps PowerShell's TAB-cycle
 * advancing through peer candidates instead of re-stalling on a separator.
 *
 *   0 sep:  `vscode.window`        → serviceIds + root-hosted interfaceIds
 *                                     (NOT service-bound interfaces, since
 *                                     calling them bare won't route)
 *   1 sep:  `azure-cli::Runner`    → if `azure-cli` is a serviceId, suggest
 *                                     `azure-cli::<iface>`; if it's also a
 *                                     root interfaceId, suggest its methods
 *                                     (form-2). Skip form-2 entirely when
 *                                     `azure-cli` isn't root-hosted — fetching
 *                                     a schema for any typed string would
 *                                     spam the hub on every keystroke.
 *   2 sep:  `azure-cli::Runner::g` → method names on (serviceId, interfaceId)
 */
async function _completeMethodRef(prefix: string, dir: DirectorySource): Promise<Completion[]> {
    const parts = prefix.split('::');
    const seps = parts.length - 1;
    const entries = await dir.entries();
    const sids = distinctServiceIds(entries);
    const rootInterfaceIds = new Set(
        entries.filter((e) => e.serviceId === '').map((e) => e.interfaceId),
    );

    if (seps === 0) {
        const out: Completion[] = [];
        for (const sid of sids) {
            if (sid.startsWith(prefix)) out.push({ text: sid, tooltip: `service ${sid}` });
        }
        for (const iid of [...rootInterfaceIds].sort()) {
            if (iid.startsWith(prefix)) out.push({ text: iid, tooltip: `interface ${iid}` });
        }
        return out;
    }

    if (seps === 1) {
        const [first] = parts;
        const out: Completion[] = [];

        if (sids.includes(first)) {
            for (const iid of interfacesOnService(entries, first)) {
                const c = `${first}::${iid}`;
                if (c.startsWith(prefix)) out.push({ text: c, tooltip: `${first} :: ${iid}` });
            }
        }
        // Form-2 (`<interfaceId>::<method>`) only makes sense when `first`
        // is actually a root-reachable interface — fetching schemas for
        // arbitrary typed strings would hit the hub on every TAB.
        if (rootInterfaceIds.has(first)) {
            const formTwoMethods = await _safeMethods(dir, undefined, first);
            for (const m of formTwoMethods) {
                const c = `${first}::${m}`;
                if (c.startsWith(prefix)) out.push({ text: c, tooltip: `${first} :: ${m}` });
            }
        }
        return out;
    }

    if (seps === 2) {
        const [sid, iid] = parts;
        const methods = await _safeMethods(dir, sid, iid);
        return methods
            .map((m) => `${sid}::${iid}::${m}`)
            .filter((c) => c.startsWith(prefix))
            .map((c) => ({ text: c }));
    }

    return [];
}

async function _safeMethods(
    dir: DirectorySource,
    serviceId: string | undefined,
    interfaceId: string,
): Promise<readonly string[]> {
    try {
        return await dir.methodsOnInterface(serviceId, interfaceId);
    } catch {
        return [];
    }
}

async function _safeParams(
    dir: DirectorySource,
    serviceId: string | undefined,
    interfaceId: string,
    methodName: string,
): Promise<readonly string[]> {
    try {
        return await dir.paramNamesForMethod(serviceId, interfaceId, methodName);
    } catch {
        return [];
    }
}

/**
 * Parse `[serviceId::][interfaceId::]methodName[@hash]` enough to look up
 * the method's params. Returns `undefined` for unrecognized shapes so the
 * orchestrator can skip the dynamic call. Independent of
 * `MethodRefWithOptHash` to keep the completions module dependency-free.
 */
function _parseMethodRefForCompletion(
    raw: string,
): { serviceId: string | undefined; interfaceId: string | undefined; methodName: string } | undefined {
    if (raw.length === 0) return undefined;
    // Strip optional `@<hash>` suffix.
    const at = raw.lastIndexOf('@');
    const core = at >= 0 && !raw.slice(at + 1).includes('::') ? raw.slice(0, at) : raw;
    const parts = core.split('::');
    if (parts.some((p) => p.length === 0)) return undefined;
    if (parts.length === 1) return { serviceId: undefined, interfaceId: undefined, methodName: parts[0] };
    if (parts.length === 2) return { serviceId: undefined, interfaceId: parts[0], methodName: parts[1] };
    if (parts.length === 3) return { serviceId: parts[0], interfaceId: parts[1], methodName: parts[2] };
    return undefined;
}
