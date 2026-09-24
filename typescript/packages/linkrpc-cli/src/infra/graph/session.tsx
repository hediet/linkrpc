import React from "react";
import { Box, Text } from "ink";
import { autorun, derived, observableValue } from "@vscode/observables";
import { stdout } from "node:process";
import type { ViewCommand, ViewKeyEvent, ViewOpenContext, ViewSession } from "../../views/types";
import { runViewTui } from "../../views/runViewTui";
import { inspectGraphCommand, type GraphTarget } from "./inspectGraph";
import type { GraphExplorerModel } from "./inspectGraphView";
import { anchorGraphScrollTop, clampGraphScroll, createGraphFrame, graphChromeRows, graphFrameText, type GraphFrameRow } from "./graphFrame";

interface State {
    readonly cursor: number;
    readonly params: string;
    readonly editing: boolean;
    readonly active: boolean;
    readonly model?: GraphExplorerModel;
    readonly version?: number;
    readonly error?: string;
    readonly revision: number;
    readonly viewportRows?: number;
    readonly showObjectIds?: boolean;
    readonly viewportColumns?: number;
    readonly scrollTop?: number;
    readonly busy?: boolean;
    readonly refreshing?: boolean;
}

/** A tab owns one watch. Disposing invalidates callbacks before cancelling I/O. */
export class GraphSession implements ViewSession {
    readonly state = observableValue<State>(this, { cursor: 0, params: "{}", editing: false, active: false, revision: 0 });
    readonly element = <GraphPanel session={this} />;
    private generation = 0;
    private stop: (() => void) | undefined;
    private disposed = false;
    private action = Promise.resolve();
    private readonly pending = new Set<Promise<void>>();
    private started = false;

    constructor(
        private readonly context: ViewOpenContext,
        readonly roots: readonly GraphTarget[],
        private options: Readonly<Record<string, unknown>> = {},
    ) {}
    get capturesInput(): boolean { return this.state.get().editing; }
    setViewport(rows: number, columns = this.state.get().viewportColumns ?? stdout.columns ?? 80): void {
        const state = this.state.get();
        if (state.viewportRows !== rows || state.viewportColumns !== columns) this.update({
            viewportRows: rows, viewportColumns: columns,
            scrollTop: clampGraphScroll(state.model?.lines.length ?? this.roots.length, state.model?.selectedIndex ?? state.cursor,
                state.scrollTop ?? 0, Math.max(0, rows - graphChromeRows), false),
        });
    }
    captureState(): unknown {
        const state = this.state.get();
        return { root: this.roots[state.cursor]?.root, interfaceId: this.roots[state.cursor]?.interfaceId,
            params: state.params, started: this.started, showObjectIds: state.showObjectIds };
    }
    restoreState(value: unknown): void {
        const state = value as { root?: string; interfaceId?: string; params?: string; started?: boolean; showObjectIds?: boolean } | undefined;
        if (!state) return;
        const cursor = this.roots.findIndex(root => root.root === state.root && root.interfaceId === state.interfaceId);
        if (cursor < 0) return;
        this.update({ cursor, params: state.params ?? "{}", showObjectIds: state.showObjectIds });
        if (state.started) this.start(this.options);
    }

    readonly commands = derived(this, (reader): readonly ViewCommand[] => {
        const state = this.state.read(reader);
        const graph = state.active || state.model !== undefined;
        if (this.disposed) return [];
        const command = (id: string, title: string, keys: readonly string[], execute: () => void, enabled = true): ViewCommand => ({
            id: `graph.${id}`, title, keybindings: keys.map(key => ({ key })), enabled, execute,
            context: state.editing ? "Editing parameters" : graph ? "Graph" : "Roots",
        });
        if (state.editing) return [
            command("finishParams", "Finish parameters", ["return", "escape"], () => this.update({ editing: false })),
            command("deleteParam", "Delete character", ["backspace", "delete"],
                () => this.update({ params: this.state.get().params.slice(0, -1) }), state.params.length > 0),
        ];
        const model = state.model;
        const index = graph ? model?.selectedIndex ?? 0 : state.cursor;
        const count = graph ? model?.lines.length ?? 0 : this.roots.length;
        const move = (delta: number) => {
            if (!graph) this.selectRoot(Math.max(0, Math.min(this.roots.length - 1, this.state.get().cursor + delta)));
            else this.enqueue(model => model.move(delta));
        };
        const select = (last: boolean) => {
            if (!graph) this.selectRoot(last ? this.roots.length - 1 : 0);
            else this.enqueue(model => model.select(last ? model.lines.length - 1 : 0));
        };
        const page = Math.max(1, (state.viewportRows ?? 24) - graphChromeRows);
        const selected = model?.lines[model.selectedIndex];
        return [
            command("up", "Previous", ["up", "k"], () => move(-1), index > 0),
            command("down", "Next", ["down", "j"], () => move(1), index + 1 < count),
            command("pageUp", "Page up", ["pageup"], () => move(-page), index > 0),
            command("pageDown", "Page down", ["pagedown"], () => move(page), index + 1 < count),
            command("first", "First", ["home", "g"], () => select(false), index > 0),
            command("last", "Last", ["end", "G"], () => select(true), index + 1 < count),
            ...graph ? [
                command("collapse", "Collapse / parent", ["left", "h", "backspace"],
                    () => this.enqueue(model => model.collapseSelected()), !!selected && (selected.expanded || selected.depth > 0)),
                command("expand", "Expand / follow", ["right", "return", "l", " "],
                    () => this.enqueue(model => model.expandSelected()), !state.busy && !!selected && (selected.expandable || selected.targetKey !== undefined)),
                command("ids", state.showObjectIds ? "Hide object IDs" : "Show object IDs", ["i"],
                    () => this.update({ showObjectIds: !this.state.get().showObjectIds }), !!model),
                command("roots", "Roots", ["r"], () => {
                    this.started = false; this.cancel(); this.update({ active: false, model: undefined, error: undefined, scrollTop: 0, version: undefined });
                }),
            ] : [
                command("attach", "Open root", ["return"], () => this.start(this.options), count > 0),
            ],
            command("params", "Edit parameters", ["p"], () => {
                this.started = false; this.cancel(); this.update({ editing: true, active: false, model: undefined, version: undefined, scrollTop: 0 });
            }, this.roots.length > 0),
        ];
    });

    private selectRoot(cursor: number): void {
        const state = this.state.get();
        this.update({ cursor, scrollTop: clampGraphScroll(this.roots.length, cursor, state.scrollTop ?? 0,
            Math.max(0, (state.viewportRows ?? 24) - graphChromeRows)) });
    }

    handleTextInput(event: ViewKeyEvent): boolean {
        if (this.disposed || !this.capturesInput) return false;
        if (event.ctrl || event.meta || !event.input || /[\x00-\x1f\x7f]/.test(event.input)) return false;
        this.update({ params: this.state.get().params + event.input });
        return true;
    }

    private enqueue(execute: (model: GraphExplorerModel) => void | Promise<void>): void {
        const state = this.state.get();
        const model = state.model;
        if (!model) return;
        const generation = this.generation;
        this.action = this.action.then(async () => {
            if (this.disposed || generation !== this.generation) return;
            this.update({ busy: true, error: undefined });
            await execute(model);
            if (!this.disposed && generation === this.generation) this.update({
                busy: false, scrollTop: clampGraphScroll(model.lines.length, model.selectedIndex, this.state.get().scrollTop ?? 0,
                    Math.max(0, (this.state.get().viewportRows ?? 24) - graphChromeRows)),
            });
        }).catch(error => {
            if (!this.disposed && generation === this.generation) this.update({ busy: false, error: String(error) });
        });
    }

    start(options: Readonly<Record<string, unknown>> = this.options): void {
        if (this.disposed) return;
        this.options = options;
        this.cancel();
        const generation = this.generation;
        const state = this.state.get();
        const root = this.roots[state.cursor];
        if (!root) { this.update({ error: "No compatible graph roots" }); return; }
        let params: unknown;
        try { params = JSON.parse(state.params); }
        catch { this.update({ error: "Root parameters must be valid JSON" }); return; }
        const stop = new Promise<void>(resolve => { this.stop = resolve; });
        this.started = true;
        this.update({ active: true, model: undefined, error: undefined, version: undefined, scrollTop: 0, busy: false, refreshing: false });
        const completion = inspectGraphCommand(this.context.channel, {
            targets: [root], root: root.root, params, stop, watch: true, depth: 0, interactive: false,
            maxObjects: options.maxObjects as number | undefined,
            maxBytes: options.maxBytes as number | undefined,
            maxRounds: options.maxRounds as number | undefined,
            timeoutMs: options.timeoutMs as number | undefined,
            logTiming: options.logTiming === true,
            onUpdating: async () => {
                if (this.disposed || generation !== this.generation) return;
                this.update({ refreshing: true });
                await this.action;
            },
            onModel: async (model, version) => {
                while (!this.disposed && generation === this.generation) {
                    const action = this.action;
                    await action;
                    if (this.disposed || generation !== this.generation) return;
                    await model.restoreExpanded(undefined, this.state.get().model);
                    if (action !== this.action) continue;
                    if (!this.disposed && generation === this.generation) {
                        const previous = this.state.get();
                        const top = previous.model ? anchorGraphScrollTop(previous.model.lines, model.lines, previous.scrollTop ?? 0) : 0;
                        this.update({ model, version, refreshing: false,
                            scrollTop: clampGraphScroll(model.lines.length, model.selectedIndex, top,
                                Math.max(0, (previous.viewportRows ?? 24) - graphChromeRows), false) });
                    }
                    return;
                }
            },
        }).then(() => {
            if (!this.disposed && generation === this.generation) this.update({ active: false, refreshing: false });
        }, error => {
            if (!this.disposed && generation === this.generation) this.update({ active: false, refreshing: false, error: String(error) });
        });
        this.pending.add(completion);
        void completion.then(() => this.pending.delete(completion), () => this.pending.delete(completion));
    }

    update(value: Partial<State>): void {
        if (this.disposed) return;
        const previous = this.state.get();
        this.state.set({ ...previous, ...value, revision: previous.revision + 1 }, undefined);
    }
    private cancel(): void { this.generation++; this.stop?.(); this.stop = undefined; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancel();
        this.state.set({ ...this.state.get(), revision: this.state.get().revision + 1 }, undefined);
    }
    async disposeAsync(): Promise<void> {
        this.dispose();
        await Promise.allSettled([...this.pending, this.action]);
    }
}

export class GraphPanel extends React.Component<{ readonly session: GraphSession }, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    componentDidMount(): void {
        this.subscription = autorun(reader => {
            const value = this.props.session.state.read(reader);
            this.setState({ revision: value.revision });
        });
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const session = this.props.session;
        const state = session.state.get();
        const model = state.model;
        const height = Math.max(1, state.viewportRows ?? stdout.rows ?? 24);
        const width = Math.max(1, state.viewportColumns ?? stdout.columns ?? 80);
        const root = session.roots[state.cursor];
        const graph = state.active || model !== undefined;
        const status = state.error ?? (state.refreshing ? "Refreshing root…"
            : state.busy ? "Loading object…" : undefined);
        const frame = createGraphFrame(model, {
            title: root ? `${root.serviceId || "local"} / ${root.interfaceId} / ${root.root}` : "No compatible roots",
            params: `params: ${state.params}${state.editing ? "█" : ""}`,
            rows: height, columns: width, scrollTop: state.scrollTop ?? 0,
            revealSelection: false, version: state.version, showObjectIds: state.showObjectIds, status,
            error: state.error !== undefined,
            phase: !graph ? state.editing ? "EDIT PARAMETERS" : "SELECT ROOT"
                : !state.active ? `STOPPED${state.version === undefined ? "" : `  v${state.version}`}` : undefined,
        });
        let rows: readonly GraphFrameRow[] = frame.rows;
        if (!graph) {
            const capacity = Math.max(0, height - graphChromeRows);
            const top = state.scrollTop ?? 0;
            rows = ([
                ...rows.slice(0, 3),
                ...Array.from({ length: capacity }, (_, offset): GraphFrameRow => {
                    const item = session.roots[top + offset];
                    return { text: item ? ` ${item.serviceId || "local"} / ${item.interfaceId} / ${item.root}` : "",
                        style: item && top + offset === state.cursor ? "selected" : "value" };
                }),
                { text: ` ${"─".repeat(Math.max(0, width - 2))}`, style: "muted" },
                { text: state.error ?? ` schema: ${JSON.stringify(root?.paramsArgument.schema ?? {})}`, style: state.error ? "error" : "muted" },
                { text: ` ${root ? state.cursor + 1 : 0}/${session.roots.length} roots`, style: "reference" },
            ] satisfies readonly GraphFrameRow[]).slice(0, height);
        }
        return <Box flexDirection="column" width={width} height={height} flexShrink={0} overflow="hidden">
            {rows.map((row, index) => <Text key={index} wrap="truncate-end"
                bold={row.style === "header" || row.style === "selected"}
                dimColor={row.style === "muted"}
                color={row.style === "selected" ? "black" : row.style === "error" ? "red"
                    : row.style === "header" || row.style === "reference" ? "cyan" : "white"}
                backgroundColor={row.style === "selected" ? "cyan" : undefined}>
                {graphFrameText(row.text, width, row.style === "selected") || " "}
            </Text>)}
        </Box>;
    }
}

export async function runGraphTui(context: ViewOpenContext, roots: readonly GraphTarget[], options: Readonly<Record<string, unknown>>): Promise<void> {
    const session = new GraphSession(context, roots, options);
    const cursor = roots.findIndex(root => (options.root === undefined || root.root === options.root)
        && (options.interface === undefined || root.interfaceId === options.interface));
    if (cursor < 0) throw new Error("No matching graph root");
    session.update({ cursor, params: String(options.params ?? "{}") });
    const running = runViewTui(session);
    if (roots.length === 1 || options.root !== undefined) session.start(options);
    await running;
}
