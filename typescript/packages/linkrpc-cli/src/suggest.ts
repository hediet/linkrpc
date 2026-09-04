/**
 * "Did you mean…" suggestions for failed `hub call` / `hub notify` invocations.
 *
 * Drives off a static snapshot of the hub (`HubSnapshot`) so the formatter is
 * pure-functional and exhaustively testable with literal strings. A snapshot
 * is built by walking the bus once (`HubSnapshot.load`) on the error path.
 *
 * The matrix is resolved left-to-right (serviceId, interfaceId, method): the
 * first token that doesn't resolve dictates the suggestion scope, and we never
 * propose replacements for positions to its left.
 */
import { MethodRefWithOptHash } from './methodRef';
import {
    fetchSchema,
    walkHub,
    type CliChannel,
} from '@hediet/linkrpc-client';

// ---------------------------------------------------------------------------
// HubSnapshot
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
    /** Empty string = root. */
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly methods: readonly string[];
}

const _SYSTEM_PREFIX = 'hubrpc.';

function _isSystemInterface(id: string): boolean {
    return id.startsWith(_SYSTEM_PREFIX);
}

function _isUserInterface(id: string): boolean {
    return !_isSystemInterface(id);
}

/**
 * Indexed view of the bus's directory + per-interface methods. Constructed
 * directly from a list of entries (tests) or by walking a live channel
 * (`HubSnapshot.load`). Read-only after construction.
 */
export class HubSnapshot {
    private readonly _byService = new Map<string, Map<string, SnapshotEntry>>();
    private readonly _byInterface = new Map<string, string[]>();
    private readonly _byMethodName = new Map<string, { serviceId: string; interfaceId: string; }[]>();

    constructor(public readonly entries: readonly SnapshotEntry[]) {
        for (const e of entries) {
            let byIface = this._byService.get(e.serviceId);
            if (!byIface) {
                byIface = new Map();
                this._byService.set(e.serviceId, byIface);
            }
            byIface.set(e.interfaceId, e);

            const hosts = this._byInterface.get(e.interfaceId) ?? [];
            if (!hosts.includes(e.serviceId)) hosts.push(e.serviceId);
            this._byInterface.set(e.interfaceId, hosts);

            for (const m of e.methods) {
                const locs = this._byMethodName.get(m) ?? [];
                locs.push({ serviceId: e.serviceId, interfaceId: e.interfaceId });
                this._byMethodName.set(m, locs);
            }
        }
    }

    /** All serviceIds present on the bus, in encounter order ("" = root). */
    services(): readonly string[] {
        return [...this._byService.keys()];
    }

    /** All distinct interface ids (system + user), in encounter order. */
    interfaces(): readonly string[] {
        return [...this._byInterface.keys()];
    }

    interfacesOnService(serviceId: string): readonly string[] {
        const m = this._byService.get(serviceId);
        return m ? [...m.keys()] : [];
    }

    servicesHostingInterface(interfaceId: string): readonly string[] {
        return this._byInterface.get(interfaceId) ?? [];
    }

    methodsOn(serviceId: string, interfaceId: string): readonly string[] {
        return this._byService.get(serviceId)?.get(interfaceId)?.methods ?? [];
    }

    locationsOfMethod(name: string): readonly { serviceId: string; interfaceId: string; }[] {
        return this._byMethodName.get(name) ?? [];
    }

    /**
     * Walk the live bus once and fetch the schema for every (service, interface)
     * pair in parallel. Failures on individual schema fetches are absorbed —
     * the affected entry just ends up with `methods: []`, so it still
     * participates in service/interface-level suggestions.
     */
    static async load(channel: CliChannel): Promise<HubSnapshot> {
        const listings = await walkHub(channel);
        const entries = await Promise.all(listings.map(async (l): Promise<SnapshotEntry> => {
            try {
                const schema = await fetchSchema(
                    channel,
                    l.interfaceId,
                    l.hash,
                    l.serviceId || undefined,
                );
                return {
                    serviceId: l.serviceId,
                    interfaceId: l.interfaceId,
                    hash: l.hash,
                    methods: Object.keys(schema.methods),
                };
            } catch {
                return {
                    serviceId: l.serviceId,
                    interfaceId: l.interfaceId,
                    hash: l.hash,
                    methods: [],
                };
            }
        }));
        return new HubSnapshot(entries);
    }
}

// ---------------------------------------------------------------------------
// formatSuggestion (entry point)
// ---------------------------------------------------------------------------

export interface SuggestionInput {
    readonly ref: MethodRefWithOptHash;
    readonly snapshot: HubSnapshot;
    /** Verb embedded in copy-paste lines (`hub call` vs `hub notify`). */
    readonly verb: 'call' | 'notify';
    /** CLI binary name; defaults to `hub`. */
    readonly tool?: string;
}

interface _Ctx {
    ref: MethodRefWithOptHash;
    snapshot: HubSnapshot;
    verb: 'call' | 'notify';
    tool: string;
}

/**
 * Compose a multi-line "Did you mean…" message tailored to the failed ref.
 * The returned string has no trailing newline and no `linkrpc:` prefix (the
 * outer error path adds those).
 */
export function formatSuggestion(input: SuggestionInput): string {
    const ctx: _Ctx = {
        ref: input.ref,
        snapshot: input.snapshot,
        verb: input.verb,
        tool: input.tool ?? 'hub',
    };
    if (ctx.ref.serviceId !== undefined && ctx.ref.interfaceId !== undefined) {
        return _suggestForm3(ctx);
    }
    if (ctx.ref.interfaceId !== undefined) {
        return _suggestForm2(ctx);
    }
    return _suggestForm1(ctx);
}

function _qualify(ctx: _Ctx, s: string, i: string, m: string): string {
    return `${ctx.tool} ${ctx.verb} ${s}::${i}::${m}`;
}

// ---------------------------------------------------------------------------
// Form 1: `<method>` (bare token, no preset)
// ---------------------------------------------------------------------------

function _suggestForm1(ctx: _Ctx): string {
    const { ref, snapshot } = ctx;
    const token = ref.methodName;

    // A1: token is itself a serviceId
    if (token !== '' && snapshot.services().includes(token)) {
        const samples = _sampleCallsForService(ctx, token, 3);
        const lines = [`"${token}" is a serviceId, not a method.`];
        lines.push('  See its interfaces:');
        lines.push(`    ${ctx.tool} ls --service ${token}`);
        if (samples.length > 0) {
            lines.push('  Or call one:');
            for (const s of samples) lines.push(`    ${s}`);
        }
        return lines.join('\n');
    }

    // A2: token is an interfaceId
    if (snapshot.interfaces().includes(token) && _isUserInterface(token)) {
        const hosts = snapshot.servicesHostingInterface(token).filter((s) => s !== '');
        const samples = _sampleCallsForInterface(ctx, token, 3);
        const lines = [
            `"${token}" is an interface, not a method. It's hosted on services: ${hosts.join(', ')}.`,
        ];
        if (samples.length > 0) {
            lines.push('  Try a call:');
            for (const s of samples) lines.push(`    ${s}`);
        }
        return lines.join('\n');
    }

    // A3/A4: token is exactly a method name on one or more interfaces
    const locs = snapshot
        .locationsOfMethod(token)
        .filter((l) => _isUserInterface(l.interfaceId));
    if (locs.length > 0) {
        const lines = [`"${token}" is not callable without an interface (no preset is set).`];
        lines.push('  Did you mean:');
        for (const l of locs.slice(0, 5)) {
            lines.push(`    ${_qualify(ctx, l.serviceId, l.interfaceId, token)}`);
        }
        return lines.join('\n');
    }

    // A5/A6/A7: fuzzy fallback
    return _suggestForm1Fuzzy(ctx);
}

function _suggestForm1Fuzzy(ctx: _Ctx): string {
    const { snapshot } = ctx;
    const token = ctx.ref.methodName;

    const methodHits = _rankAllMethods(snapshot, token, 3);
    const ifaceHits = _rankAllInterfaces(snapshot, token, 3);
    const svcHits = _rankServices(snapshot, token, 3);

    const lines = [`"${token}" matches no known service, interface, or method.`];
    if (methodHits.length > 0) {
        lines.push('  Closest methods:');
        for (const h of methodHits) {
            lines.push(`    ${_qualify(ctx, h.serviceId, h.interfaceId, h.name)}`);
        }
    }
    if (ifaceHits.length > 0) {
        lines.push('  Closest interfaces:');
        for (const id of ifaceHits) {
            const sampleSvc = snapshot
                .servicesHostingInterface(id)
                .find((s) => s !== '') ?? snapshot.servicesHostingInterface(id)[0];
            lines.push(`    ${id}  (try ${ctx.tool} ${ctx.verb} ${sampleSvc ?? ''}::${id}::<method>)`);
        }
    }
    if (svcHits.length > 0) {
        lines.push('  Closest services:');
        for (const s of svcHits) {
            lines.push(`    ${s}  (try ${ctx.tool} ls --service ${s})`);
        }
    }
    if (methodHits.length === 0 && ifaceHits.length === 0 && svcHits.length === 0) {
        lines.push(`  Tip: run \`${ctx.tool} ls\` to see what's available.`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Form 2: `<interface>::<method>`
// ---------------------------------------------------------------------------

function _suggestForm2(ctx: _Ctx): string {
    const { ref, snapshot } = ctx;
    const iface = ref.interfaceId!;
    const method = ref.methodName;
    const hostsOfIface = snapshot.servicesHostingInterface(iface);

    if (hostsOfIface.length === 0) {
        // Interface unknown.
        // B3: first token is actually a serviceId
        if (iface !== '' && snapshot.services().includes(iface)) {
            // B3a: the second token is an exact method name on that service
            // (e.g. `azure-cli::runCommand` → fully-qualified suggestion).
            const locs = snapshot
                .locationsOfMethod(method)
                .filter((l) => l.serviceId === iface && _isUserInterface(l.interfaceId));
            if (locs.length > 0) {
                const lines = [
                    `Interface "${method}" not found on service "${iface}", `
                    + `but "${method}" is a method name there.`,
                ];
                lines.push('  Did you mean:');
                for (const l of locs.slice(0, 3)) {
                    lines.push(`    ${_qualify(ctx, l.serviceId, l.interfaceId, method)}`);
                }
                return lines.join('\n');
            }

            // B3b: prefix or full enumeration — list interfaces on the service.
            // Typing `vscode::vscode.` is navigation, not a typo; show what's
            // available rather than guessing methods.
            return _formatInterfaceListOnService(ctx, iface, method);
        }

        // B2: fuzzy interfaces, boost ones where `method` exists
        const candidates = _rankInterfacesWithMethodBoost(snapshot, iface, method, 3);
        const lines = [`Interface "${iface}" not found.`];
        if (candidates.length > 0) {
            lines.push('  Did you mean:');
            for (const c of candidates) {
                lines.push(`    ${_qualify(ctx, c.serviceId, c.interfaceId, c.methodToTry)}`);
            }
        } else {
            lines.push(`  Tip: run \`${ctx.tool} ls\` to see what's available.`);
        }
        return lines.join('\n');
    }

    // Interface valid on >=1 service. Method missing on all of them.
    // B1/B4: fuzzy methods across hosts
    const fuzzy = _rankMethodsOnInterface(snapshot, iface, method, 3);
    if (fuzzy.length > 0) {
        const where = hostsOfIface.length === 1 ? ` (service: ${hostsOfIface[0]})` : '';
        const lines = [`Method "${method}" not found on interface "${iface}"${where}.`];
        lines.push('  Did you mean:');
        for (const f of fuzzy) {
            lines.push(`    ${_qualify(ctx, f.serviceId, iface, f.methodName)}`);
        }
        return lines.join('\n');
    }

    // B5: enumerate everything available under this interface
    const lines = [`Method "${method}" not found on interface "${iface}".`];
    lines.push('  Available methods:');
    let count = 0;
    for (const s of hostsOfIface) {
        for (const m of snapshot.methodsOn(s, iface)) {
            if (count >= 12) break;
            lines.push(`    ${_qualify(ctx, s, iface, m)}`);
            count++;
        }
        if (count >= 12) break;
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Form 3: `<svc>::<iface>::<method>`
// ---------------------------------------------------------------------------

function _suggestForm3(ctx: _Ctx): string {
    const { ref, snapshot } = ctx;
    const svc = ref.serviceId!;
    const iface = ref.interfaceId!;
    const method = ref.methodName;

    // C4/C7: service unknown
    if (!snapshot.services().includes(svc)) {
        const hits = _rankServices(snapshot, svc, 3, (cand) => {
            const ifaces = snapshot.interfacesOnService(cand);
            if (ifaces.includes(iface) && snapshot.methodsOn(cand, iface).includes(method)) {
                return 200;
            }
            if (ifaces.includes(iface)) return 100;
            return 0;
        });
        const lines = [`Service "${svc}" not found.`];
        if (hits.length > 0) {
            lines.push('  Did you mean:');
            for (const h of hits) {
                const ifacesOnH = snapshot.interfacesOnService(h);
                if (ifacesOnH.includes(iface) && snapshot.methodsOn(h, iface).includes(method)) {
                    lines.push(`    ${_qualify(ctx, h, iface, method)}`);
                } else {
                    lines.push(`    ${h}  (try ${ctx.tool} ls --service ${h})`);
                }
            }
        } else {
            lines.push(`  Tip: run \`${ctx.tool} ls\` to see what's available.`);
        }
        return lines.join('\n');
    }

    // Service valid; check interface.
    const ifacesOnSvc = snapshot.interfacesOnService(svc);
    if (!ifacesOnSvc.includes(iface)) {
        // C2a: navigation-style input — `iface` is a prefix of one or more
        // interfaces on this service (e.g. `vscode::vscode.::login`). List the
        // matches, using `method` as the sample call when it exists on a
        // match, else the first method of each.
        const prefixMatches = _prefixMatchesOnService(snapshot, svc, iface);
        if (prefixMatches.length > 0) {
            const lines = [
                `Interface "${iface}" not found on service "${svc}". `
                + `Interfaces starting with "${iface}":`,
            ];
            for (const id of prefixMatches.slice(0, 10)) {
                const sampleMethod = snapshot.methodsOn(svc, id).includes(method)
                    ? method
                    : (snapshot.methodsOn(svc, id)[0] ?? '<method>');
                lines.push(`    ${_qualify(ctx, svc, id, sampleMethod)}`);
            }
            const otherHosts = snapshot
                .servicesHostingInterface(iface)
                .filter((s) => s !== svc && s !== '');
            if (otherHosts.length > 0) {
                lines.push(`  Note: "${iface}" also exists on service "${otherHosts[0]}".`);
            }
            return lines.join('\n');
        }

        // C2/C3
        const lines = [`Interface "${iface}" not found on service "${svc}".`];

        // C2: fuzzy interfaces on THIS service, boost those hosting `method`
        const hits = _rankInterfacesOnService(snapshot, svc, iface, method, 3);
        if (hits.length > 0) {
            lines.push('  Did you mean:');
            for (const h of hits) {
                const methodOk = snapshot.methodsOn(svc, h).includes(method);
                lines.push(`    ${_qualify(ctx, svc, h, methodOk ? method : '<method>')}`);
            }
        }

        // C3: footnote — interface exists on another service?
        const otherHosts = snapshot
            .servicesHostingInterface(iface)
            .filter((s) => s !== svc && s !== '');
        const userIfacesOnSvc = ifacesOnSvc.filter(_isUserInterface);
        if (otherHosts.length > 0) {
            if (hits.length === 0 && userIfacesOnSvc.length > 0) {
                lines.push(`  Interfaces on "${svc}": ${userIfacesOnSvc.join(', ')}`);
            }
            const otherSvc = otherHosts[0];
            const sampleMethod = snapshot.methodsOn(otherSvc, iface).includes(method)
                ? method
                : (snapshot.methodsOn(otherSvc, iface)[0] ?? '<method>');
            lines.push(`  Note: "${iface}" exists on service "${otherSvc}". Did you mean:`);
            lines.push(`    ${_qualify(ctx, otherSvc, iface, sampleMethod)}`);
        } else if (hits.length === 0) {
            if (userIfacesOnSvc.length > 0) {
                lines.push(`  Interfaces on "${svc}": ${userIfacesOnSvc.join(', ')}`);
            } else {
                lines.push(`  Tip: run \`${ctx.tool} ls --service ${svc}\``);
            }
        }
        return lines.join('\n');
    }

    // C1: svc + iface valid; method missing
    const methods = snapshot.methodsOn(svc, iface);
    const hits = _rankNames(methods, method, 3);
    const lines = [`Method "${method}" not found on ${svc}::${iface}.`];
    if (hits.length > 0) {
        lines.push('  Did you mean:');
        for (const h of hits) {
            lines.push(`    ${_qualify(ctx, svc, iface, h)}`);
        }
    } else if (methods.length > 0) {
        lines.push('  Available methods:');
        for (const m of methods.slice(0, 12)) {
            lines.push(`    ${_qualify(ctx, svc, iface, m)}`);
        }
    } else {
        lines.push(`  Tip: this interface has no methods declared.`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ranking / fuzzy primitives
// ---------------------------------------------------------------------------

function _threshold(s: string): number {
    return Math.max(1, Math.ceil(s.length / 3));
}

/** Levenshtein distance between two short strings. O(m*n) time, O(n) space. */
function _lev(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
            prev = tmp;
        }
    }
    return dp[n];
}

interface _Ranked<T> { item: T; dist: number; boost: number; }

function _rank<T>(
    items: readonly T[],
    key: (t: T) => string,
    query: string,
    limit: number,
    boost?: (t: T) => number,
): T[] {
    const lower = query.toLowerCase();
    const thr = _threshold(query);
    const ranked: _Ranked<T>[] = [];
    for (const it of items) {
        const k = key(it);
        const d = _lev(k.toLowerCase(), lower);
        if (d > thr) continue;
        ranked.push({ item: it, dist: d, boost: boost ? boost(it) : 0 });
    }
    ranked.sort((a, b) =>
        (a.dist - b.dist)
        || (b.boost - a.boost)
        || key(a.item).localeCompare(key(b.item))
    );
    return ranked.slice(0, limit).map((r) => r.item);
}

function _rankNames(
    names: readonly string[],
    query: string,
    limit: number,
    boost?: (n: string) => number,
): string[] {
    return _rank(names, (n) => n, query, limit, boost);
}

function _rankServices(
    snapshot: HubSnapshot,
    query: string,
    limit: number,
    boost?: (s: string) => number,
): string[] {
    return _rankNames(snapshot.services().filter((s) => s !== ''), query, limit, boost);
}

function _rankAllInterfaces(snapshot: HubSnapshot, query: string, limit: number): string[] {
    return _rankNames(snapshot.interfaces().filter(_isUserInterface), query, limit);
}

function _rankAllMethods(
    snapshot: HubSnapshot,
    query: string,
    limit: number,
): readonly { name: string; serviceId: string; interfaceId: string; }[] {
    const all: { name: string; serviceId: string; interfaceId: string; }[] = [];
    for (const e of snapshot.entries) {
        if (!_isUserInterface(e.interfaceId)) continue;
        for (const m of e.methods) {
            all.push({ name: m, serviceId: e.serviceId, interfaceId: e.interfaceId });
        }
    }
    return _rank(all, (x) => x.name, query, limit);
}

function _rankMethodsOnInterface(
    snapshot: HubSnapshot,
    interfaceId: string,
    query: string,
    limit: number,
): readonly { methodName: string; serviceId: string; }[] {
    const all: { methodName: string; serviceId: string; }[] = [];
    for (const s of snapshot.servicesHostingInterface(interfaceId)) {
        for (const m of snapshot.methodsOn(s, interfaceId)) {
            all.push({ methodName: m, serviceId: s });
        }
    }
    return _rank(all, (x) => x.methodName, query, limit);
}

function _rankInterfacesWithMethodBoost(
    snapshot: HubSnapshot,
    query: string,
    methodName: string,
    limit: number,
): readonly { interfaceId: string; serviceId: string; methodToTry: string; }[] {
    const ifaces = snapshot.interfaces().filter(_isUserInterface);
    const ranked = _rankNames(ifaces, query, limit, (id) => {
        for (const s of snapshot.servicesHostingInterface(id)) {
            if (snapshot.methodsOn(s, id).includes(methodName)) return 100;
        }
        return 0;
    });
    return ranked.map((id) => {
        const hosts = snapshot.servicesHostingInterface(id);
        const withMethod = hosts.find(
            (s) => s !== '' && snapshot.methodsOn(s, id).includes(methodName),
        );
        const fallback = hosts.find((s) => s !== '') ?? hosts[0] ?? '';
        const svc = withMethod ?? fallback;
        const m = snapshot.methodsOn(svc, id).includes(methodName)
            ? methodName
            : (snapshot.methodsOn(svc, id)[0] ?? '<method>');
        return { interfaceId: id, serviceId: svc, methodToTry: m };
    });
}

function _rankInterfacesOnService(
    snapshot: HubSnapshot,
    serviceId: string,
    query: string,
    methodName: string,
    limit: number,
): string[] {
    const ifaces = snapshot.interfacesOnService(serviceId).filter(_isUserInterface);
    return _rankNames(ifaces, query, limit, (id) =>
        snapshot.methodsOn(serviceId, id).includes(methodName) ? 100 : 0
    );
}

// ---------------------------------------------------------------------------
// Sample call generators
// ---------------------------------------------------------------------------

/**
 * Interface ids on `serviceId` whose name starts with `prefix`
 * (case-insensitive). System interfaces (`linkrpc.*`) are excluded — they're
 * noise for navigation. Returns `[]` for an empty `prefix` so the caller can
 * distinguish "no prefix typed" from "prefix had matches".
 */
function _prefixMatchesOnService(
    snapshot: HubSnapshot,
    serviceId: string,
    prefix: string,
): string[] {
    if (prefix === '') return [];
    const lower = prefix.toLowerCase();
    return snapshot
        .interfacesOnService(serviceId)
        .filter((id) => _isUserInterface(id) && id.toLowerCase().startsWith(lower));
}

/**
 * Render an interface-list response for `serviceId`. When `prefix` is a real
 * prefix of one or more interfaces, only those are shown; otherwise all user
 * interfaces on the service are listed. Sample method per row defaults to the
 * first declared method.
 */
function _formatInterfaceListOnService(
    ctx: _Ctx,
    serviceId: string,
    prefix: string,
): string {
    const allUserIfaces = ctx.snapshot
        .interfacesOnService(serviceId)
        .filter(_isUserInterface);
    const prefixMatches = _prefixMatchesOnService(ctx.snapshot, serviceId, prefix);
    const matches = prefixMatches.length > 0 ? prefixMatches : allUserIfaces;

    const header = prefixMatches.length > 0
        ? `Interfaces on "${serviceId}" starting with "${prefix}":`
        : (prefix !== ''
            ? `Interface "${prefix}" not found on service "${serviceId}". `
            + `Interfaces on "${serviceId}":`
            : `Interfaces on "${serviceId}":`);

    const lines = [header];
    if (matches.length === 0) {
        lines.push(`  Tip: run \`${ctx.tool} ls --service ${serviceId}\``);
        return lines.join('\n');
    }
    for (const id of matches.slice(0, 10)) {
        const sampleMethod = ctx.snapshot.methodsOn(serviceId, id)[0] ?? '<method>';
        lines.push(`    ${_qualify(ctx, serviceId, id, sampleMethod)}`);
    }
    return lines.join('\n');
}

function _sampleCallsForService(ctx: _Ctx, serviceId: string, limit: number): string[] {
    const { snapshot } = ctx;
    const out: string[] = [];
    for (const iface of snapshot.interfacesOnService(serviceId)) {
        if (!_isUserInterface(iface)) continue;
        for (const m of snapshot.methodsOn(serviceId, iface)) {
            out.push(_qualify(ctx, serviceId, iface, m));
            if (out.length >= limit) return out;
        }
    }
    return out;
}

function _sampleCallsForInterface(ctx: _Ctx, interfaceId: string, limit: number): string[] {
    const { snapshot } = ctx;
    const out: string[] = [];
    for (const s of snapshot.servicesHostingInterface(interfaceId)) {
        if (s === '') continue;
        for (const m of snapshot.methodsOn(s, interfaceId)) {
            out.push(_qualify(ctx, s, interfaceId, m));
            if (out.length >= limit) return out;
        }
    }
    return out;
}
