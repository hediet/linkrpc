import type { JsonValue } from "@hediet/linkrpc";
import { isGraphRef } from "@hediet/linkrpc-infra/graph";
import { observableValue } from "@vscode/observables";
import {
    GraphLoader,
    createGraphTree,
    formatGraphRef,
    graphRefKey,
    graphRefsInValue,
    type GraphRef,
    type GraphTreeLine,
} from "./inspectGraphModel";
import type { GraphTimings } from "./inspectGraphTiming";

export interface GraphViewOptions {
    readonly depth?: number;
}

export class GraphExplorerModel {
    private readonly _expanded = observableValue<ReadonlySet<string>>(this, new Set());
    private readonly _expandedPaths = observableValue<ReadonlySet<string>>(this, new Set(["$"]));
    private readonly _selectedKey = observableValue(this, "$");
    private _cachedTree: {
        readonly size: number;
        readonly expanded: ReadonlySet<string>;
        readonly lines: readonly GraphTreeLine[];
    } | undefined;

    public constructor(
        public readonly root: GraphRef,
        private readonly _loader: GraphLoader,
        private readonly _maxDepth = Number.POSITIVE_INFINITY,
        state?: {
            readonly selectedKey?: string;
            readonly expanded?: ReadonlySet<string>;
            readonly expandedPaths?: ReadonlySet<string>;
        },
        private readonly _timings?: GraphTimings,
    ) {
        const expanded = new Set(state?.expanded);
        if (state?.expandedPaths === undefined || state.expandedPaths.has("$")) expanded.add(graphRefKey(root));
        else expanded.delete(graphRefKey(root));
        this._expanded.set(expanded, undefined);
        this._expandedPaths.set(new Set(state?.expandedPaths ?? ["$"]), undefined);
        this._selectedKey.set(state?.selectedKey ?? "$", undefined);
    }

    public get lines(): readonly GraphTreeLine[] {
        const size = this._loader.cache.size;
        const expanded = this._expanded.get();
        if (this._cachedTree?.size !== size || this._cachedTree.expanded !== expanded) {
            const build = () => createGraphTree(this.root, this._loader.cache, expanded, this._maxDepth);
            this._cachedTree = { size, expanded, lines: this._timings?.measureSync("tree", build) ?? build() };
        }
        return this._cachedTree.lines;
    }

    public get selectedIndex(): number {
        const exact = this.lines.findIndex((line) => line.key === this._selectedKey.get());
        return exact === -1 ? 0 : exact;
    }

    public get selectedKey(): string {
        return this.lines[this.selectedIndex]?.key ?? "$";
    }

    public get expandedKeys(): ReadonlySet<string> {
        return this._expanded.get();
    }

    public get expandedPaths(): ReadonlySet<string> {
        return this._expandedPaths.get();
    }

    public get cachedObjects(): number {
        return this._loader.cache.size;
    }

    public async prefetchExpanded(root: GraphRef): Promise<void> {
        const paths = this.lines.flatMap(line =>
            line.expandable && line.expanded && line.selector !== undefined ? [line.selector] : []);
        if (paths.length > 0) await this._loader.load([{ ref: root, paths }]);
    }

    public async restoreExpanded(signal?: AbortSignal, source?: GraphExplorerModel): Promise<void> {
        let paths: ReadonlySet<string>;
        do {
            paths = source?.expandedPaths ?? this.expandedPaths;
            if (source !== undefined) {
                this._expanded.set(new Set(source.expandedKeys), undefined);
                this._expandedPaths.set(paths, undefined);
            }
            const pending = new Set(paths);
            while (pending.size > 0) {
                signal?.throwIfAborted();
                const available = this.lines.filter(line => pending.has(line.key) && line.ref !== undefined && line.expandable);
                if (available.length === 0) break;
                const needs = available.flatMap(line => line.ref !== undefined && !this._loader.cache.has(line.ref)
                    ? [{ ref: line.ref, paths: ["/"] }] : []);
                if (needs.length > 0) await this._loader.load(needs);
                signal?.throwIfAborted();
                const expanded = new Set(this._expanded.get());
                for (const line of available) {
                    pending.delete(line.key);
                    if (line.ref !== undefined) expanded.add(graphRefKey(line.ref));
                }
                this._expanded.set(expanded, undefined);
                if (source !== undefined && source.expandedPaths !== paths) break;
            }
            await this._loadVisibleObjects();
            signal?.throwIfAborted();
        } while (source !== undefined && source.expandedPaths !== paths);
        if (source !== undefined) this._selectedKey.set(source.selectedKey, undefined);
    }

    private async _loadVisibleObjects(): Promise<void> {
        // Fetch the displayed references, not their descendants. Collapsed rows
        // can then show titles without recursively opening the graph.
        const needs = this.lines.flatMap(line => line.ref !== undefined
            ? [{ ref: line.ref, paths: ["/"] }] : []);
        await this._loader.load(needs);
    }

    public select(index: number): void {
        const line = this.lines[index];
        if (line === undefined) throw new Error(`No graph line ${index + 1}`);
        this._selectedKey.set(line.key, undefined);
    }

    public move(delta: number): void {
        const lines = this.lines;
        if (lines.length === 0) return;
        const index = Math.max(0, Math.min(lines.length - 1, this.selectedIndex + delta));
        this._selectedKey.set(lines[index].key, undefined);
    }

    public async expandSelected(): Promise<void> {
        const line = this.lines[this.selectedIndex];
        if (line?.targetKey !== undefined) {
            this._selectedKey.set(line.targetKey, undefined);
            return;
        }
        if (line?.ref === undefined || !line.expandable) return;
        if (line.expanded && (this.lines[this.selectedIndex + 1]?.depth ?? -1) > line.depth) {
            this.move(1);
            return;
        }
        await this._expand(line);
    }

    private async _expand(line: GraphTreeLine): Promise<void> {
        if (line.ref === undefined) return;
        if (!this._loader.cache.has(line.ref)) {
            await this._loader.load([{ ref: line.ref, paths: ["/"] }]);
        }
        const key = graphRefKey(line.ref);
        const canonical = this.lines.find(item => item.ref !== undefined
            && graphRefKey(item.ref) === key && item.expandable)?.key ?? line.key;
        this._expanded.set(new Set([...this._expanded.get(), key]), undefined);
        this._expandedPaths.set(new Set([...this._expandedPaths.get(), canonical]), undefined);
        if (this._selectedKey.get() === line.key) this._selectedKey.set(canonical, undefined);
        await this._loadVisibleObjects();
    }

    public collapseSelected(): void {
        const lines = this.lines;
        const line = lines[this.selectedIndex];
        if (line?.ref !== undefined && line.expandable && line.expanded) {
            const refKey = graphRefKey(line.ref);
            const aliases = new Set(lines.filter(item => item.ref !== undefined
                && graphRefKey(item.ref) === refKey).map(item => item.key));
            this._expanded.set(new Set([...this._expanded.get()].filter(key => key !== refKey)), undefined);
            this._expandedPaths.set(new Set([...this._expandedPaths.get()].filter(path => !aliases.has(path))), undefined);
            return;
        }
        for (let index = this.selectedIndex - 1; index >= 0; index--) {
            if (lines[index].depth < (line?.depth ?? 0)) {
                this.select(index);
                return;
            }
        }
    }
}

export async function loadGraphDepth(
    root: GraphRef,
    loader: GraphLoader,
    depth: number,
): Promise<void> {
    if (!Number.isInteger(depth) || depth < 0) {
        throw new Error("depth must be a non-negative integer");
    }
    let frontier = [root];
    const visited = new Set<string>();
    for (let level = 0; level <= depth && frontier.length > 0; level++) {
        const needs = frontier
            .filter((ref) => !loader.cache.has(ref))
            .map((ref) => ({ ref, paths: ["/"] }));
        if (needs.length > 0) await loader.load(needs);
        if (level === depth) break;
        const next = new Map<string, GraphRef>();
        for (const ref of frontier) {
            const key = graphRefKey(ref);
            if (visited.has(key)) continue;
            visited.add(key);
            const object = loader.cache.get(ref);
            if (object === undefined) {
                throw new Error(`Graph object ${formatGraphRef(ref)} is missing or expired`);
            }
            for (const child of graphRefsInValue(object.value)) {
                if (!visited.has(graphRefKey(child))) next.set(graphRefKey(child), child);
            }
        }
        frontier = [...next.values()];
    }
}

export function renderGraphTree(
    model: GraphExplorerModel,
    options: { readonly selected?: boolean } = {},
): string {
    const selectedIndex = model.selectedIndex;
    return model.lines.map((line, index) => {
        const cursor = options.selected === true
            ? (index === selectedIndex ? "> " : "  ")
            : "";
        return `${cursor}${"  ".repeat(line.depth)}${line.text}`;
    }).join("\n");
}

export function renderGraphJson(root: GraphRef, loader: GraphLoader): string {
    return JSON.stringify(materializeGraphValue(root, loader, new Set()), null, 2);
}

function materializeGraphValue(
    ref: GraphRef,
    loader: GraphLoader,
    ancestors: ReadonlySet<string>,
): JsonValue {
    const key = graphRefKey(ref);
    if (ancestors.has(key)) return { $ref: formatGraphRef(ref), $cycle: true };
    const object = loader.cache.get(ref);
    if (object === undefined) return { $ref: formatGraphRef(ref), $missing: true };
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(key);
    return replaceRefs(object.value, loader, nextAncestors);
}

function replaceRefs(
    value: JsonValue,
    loader: GraphLoader,
    ancestors: ReadonlySet<string>,
): JsonValue {
    if (isGraphRef(value)) return materializeGraphValue(value, loader, ancestors);
    if (Array.isArray(value)) return value.map((item) => replaceRefs(item, loader, ancestors));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).flatMap(([key, child]) =>
                child === undefined ? [] : [[key, replaceRefs(child, loader, ancestors)]]),
        );
    }
    return value;
}
