import { fetchDefaults, fetchSchema, type CliChannel } from "@hediet/linkrpc-client";
import { HubDirectoryExplorer } from "@hediet/linkrpc/hub/common";
import { interfaceTarget, matchesInterface, matchesTarget, targetId, type ViewContribution, type ViewInterface, type ViewOpenContext, type ViewTarget } from "./types";

export interface ViewDiscoveryOptions {
    readonly maxDepth?: number;
    readonly timeoutMs?: number;
}

export interface ViewSelectionOptions extends ViewDiscoveryOptions {
    readonly target?: string;
    readonly interface?: string;
    readonly service?: string;
}

export async function discoverViewTargets(channel: CliChannel, view: ViewContribution, options: ViewDiscoveryOptions = {}) {
    const explorer = new HubDirectoryExplorer(channel, options);
    const warnings: string[] = [];
    try {
        await explorer.explore();
        const snapshot = explorer.graphSnapshot.result;
        warnings.push(...snapshot.inaccessible.map(item => `${item.serviceId || "<root>"}: ${item.reason}`));
        const listings: ViewInterface[] = [...snapshot.listings];
        try {
            const defaults = await deadline(fetchDefaults(channel), options.timeoutMs ?? 5_000);
            if (defaults.interfaceId !== undefined) {
                const existing = listings.find(item => item.serviceId === "" && item.interfaceId === defaults.interfaceId);
                listings.unshift({
                    serviceId: "", interfaceId: defaults.interfaceId, hash: defaults.hash ?? existing?.hash,
                    discoveredFrom: "", isDefault: true, tags: existing?.tags,
                });
            }
        } catch (error) {
            warnings.push(`Default service: ${message(error)}`);
        }
        // Absent tags mean no advertised labels. Discovery never scans schemas;
        // opening separately validates the selected implementation's contract.
        const interfacesById = new Map<string, ViewTarget>();
        for (const listing of listings) {
            const target = interfaceTarget(listing);
            const previous = interfacesById.get(target.id);
            interfacesById.set(target.id, previous === undefined ? target
                : { ...previous, interfaces: [...previous.interfaces, listing] });
        }
        const targets: ViewTarget[] = [...interfacesById.values()];
        const services = new Map<string, ViewInterface[]>();
        for (const listing of listings) {
            const id = targetId("service", listing);
            const values = services.get(id) ?? [];
            // Prefer default routing for the main interface of the root service.
            if (!values.some(value => value.interfaceId === listing.interfaceId && value.hash === listing.hash)) values.push(listing);
            services.set(id, values);
        }
        for (const [id, interfaces] of services) {
            const first = interfaces[0]!;
            targets.push({ id, kind: "service", serviceId: first.serviceId, discoveredFrom: first.discoveredFrom, interfaces });
        }
        return { targets: targets.filter(target => matchesTarget(target, view)).sort((a, b) => a.id.localeCompare(b.id)), warnings };
    } finally {
        explorer.dispose();
    }
}

export async function resolveViewTarget(channel: CliChannel, view: ViewContribution, id: string, options: ViewDiscoveryOptions = {}): Promise<ViewOpenContext> {
    const { targets } = await discoverViewTargets(channel, view, options);
    const target = targets.find(value => value.id === id);
    if (!target) throw new Error(`Unknown or unavailable ${view.id} target "${id}". Run view targets ${view.id} again.`);
    return loadViewTarget(channel, target, options.timeoutMs, view);
}

/** Selection and opening share a connection, including spawned ephemeral endpoints. */
export async function resolveViewSelection(channel: CliChannel, view: ViewContribution, options: ViewSelectionOptions): Promise<ViewOpenContext> {
    if (options.target !== undefined) {
        const context = await resolveViewTarget(channel, view, options.target, options);
        if (options.service !== undefined && context.target.serviceId !== options.service) {
            throw new Error("--target does not match --service");
        }
        if (options.interface !== undefined && !context.target.interfaces.some(value => value.interfaceId === options.interface)) {
            throw new Error("--target does not match --interface");
        }
        return context;
    }
    if (options.interface === undefined && options.service === undefined) {
        throw new Error("Specify --target, or an exact --interface / --service selector");
    }
    const discovery = await discoverViewTargets(channel, view, options);
    const candidates = discovery.targets.filter(target =>
        target.kind === (options.interface === undefined ? "service" : "interface")
        && (options.interface === undefined || target.interfaceId === options.interface)
        && (options.service === undefined || target.serviceId === options.service));
    // Defaults can also appear as qualified directory entries. They represent
    // the same implementation, not an ambiguity between two endpoint routes.
    const matches = candidates.filter(target => target.kind !== "interface"
        || target.interfaces.some(value => value.isDefault)
        || !candidates.some(other => other.serviceId === target.serviceId
            && other.discoveredFrom === target.discoveredFrom
            && other.interfaceId === target.interfaceId
            && other.interfaces.every(value => target.interfaces.some(candidate => candidate.hash === value.hash))
            && target.interfaces.every(value => other.interfaces.some(candidate => candidate.hash === value.hash))
            && other.interfaces.some(value => value.isDefault)));
    if (matches.length !== 1) {
        const detail = matches.length === 0 ? "No matching target" : `Target selection is ambiguous (${matches.length} targets)`;
        throw new Error(`${detail}; use --service to narrow the selection or --target from view targets ${view.id}`);
    }
    return loadViewTarget(channel, matches[0]!, options.timeoutMs, view);
}

export async function loadViewTarget(channel: CliChannel, target: ViewTarget, timeoutMs = 5_000, view?: ViewContribution): Promise<ViewOpenContext> {
    const candidates = view === undefined || target.kind === "interface" ? target.interfaces
        : target.interfaces.filter(listing => view.conditions.some(condition =>
            condition.kind === "service" && matchesInterface(listing, condition.implements)));
    for (const listing of candidates) {
        if (candidates.some(other => other.interfaceId === listing.interfaceId && other.hash !== listing.hash)) {
            throw new Error(`Target "${target.id}" is ambiguous: interface "${listing.interfaceId}" advertises multiple schema hashes`);
        }
    }
    return {
        channel, target,
        interfaces: await Promise.all(candidates.map(async listing => {
            // Use the freshly advertised hash, not a hash embedded in a saved
            // target ID. Different services can implement different revisions.
            const schema = await deadline(fetchSchema(channel, listing.interfaceId, listing.hash, listing.discoveredFrom || undefined), timeoutMs);
            if (schema.id !== listing.interfaceId || (listing.hash !== undefined && schema.hash !== listing.hash)) {
                throw new Error(`Schema for "${listing.interfaceId}" does not match its current directory advertisement; rediscover the target`);
            }
            return { ...listing, hash: schema.hash, schema };
        })),
    };
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Reflection timed out after ${timeoutMs}ms`)), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
