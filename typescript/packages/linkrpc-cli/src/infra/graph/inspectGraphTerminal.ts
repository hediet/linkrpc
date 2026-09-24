import { emitKeypressEvents, type Key } from "node:readline";
import { stdin, stdout } from "node:process";
import { autorun, observableValue } from "@vscode/observables";
import { safeTerminalText } from "../../ui/terminalText";
import type { GraphTreeLine } from "./inspectGraphModel";
import type { GraphExplorerModel } from "./inspectGraphView";
import type { GraphTimings } from "./inspectGraphTiming";
import { anchorGraphScrollTop, formatGraphTreeRows } from "./graphFrame";
export { anchorGraphScrollTop } from "./graphFrame";

export class GraphTerminal {
    private readonly _view = observableValue<{ model: GraphExplorerModel; version: number } | undefined>(this, undefined);
    private readonly _busy = observableValue(this, false);
    private readonly _updating = observableValue(this, false);
    private readonly _error = observableValue<string | undefined>(this, undefined);
    private readonly _revision = observableValue(this, 0);
    private readonly _scrollTop = observableValue(this, 0);
    private readonly _showObjectIds = observableValue(this, false);
    private _renderedLines: readonly GraphTreeLine[] = [];
    private _renderedModel: GraphExplorerModel | undefined;
    private _revealSelection = true;
    private readonly _raw = stdin.isRaw;
    private readonly _wasFlowing = stdin.readableFlowing === true;
    private readonly _rendering: { dispose(): void };
    private _action: Promise<void> = Promise.resolve();
    private _disposed = false;
    private readonly _resolve: () => void;
    private readonly _reject: (error: unknown) => void;
    public readonly result: Promise<void>;

    public constructor(
        private readonly _title: string,
        private readonly _params: string,
        private readonly _repaint: (text: string) => void = text => { stdout.write(text); },
        private readonly _timings?: GraphTimings,
    ) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        this.result = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        this._resolve = resolve;
        this._reject = reject;
        stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
        emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("keypress", this._onKey);
        stdout.on("resize", this._invalidate);
        this._rendering = autorun(reader => {
            const view = this._view.read(reader);
            const busy = this._busy.read(reader);
            const updating = this._updating.read(reader);
            const error = this._error.read(reader);
            const showObjectIds = this._showObjectIds.read(reader);
            this._revision.read(reader);
            const model = view?.model;
            const lines = model?.lines ?? [];
            const scrollTop = model !== this._renderedModel
                ? anchorGraphScrollTop(this._renderedLines, lines, this._scrollTop.get())
                : this._scrollTop.get();
            const render = () => renderGraphScreen(model, {
                title: this._title,
                params: this._params,
                version: view?.version,
                columns: stdout.columns || 80,
                rows: stdout.rows || 24,
                scrollTop,
                revealSelection: this._revealSelection,
                showObjectIds,
                status: error ?? (updating ? "Refreshing root..." : busy ? "Loading object..." : undefined),
                error: error !== undefined,
            });
            const frame = this._timings?.measureSync("screen", render, { version: view?.version ?? 0 }) ?? render();
            this._scrollTop.set(frame.scrollTop, undefined);
            this._renderedLines = lines;
            this._renderedModel = model;
            this._repaint(frame.text);
        });
    }

    public async beginUpdate(): Promise<void> {
        this._updating.set(true, undefined);
        await this._action;
    }

    public async finishUpdate(model: GraphExplorerModel, version: number, signal?: AbortSignal): Promise<void> {
        while (!this._disposed) {
            await this._action;
            signal?.throwIfAborted();
            const source = this._view.get()?.model;
            const paths = source?.expandedPaths;
            await model.restoreExpanded(signal, source);
            signal?.throwIfAborted();
            if (this._busy.get() || source?.expandedPaths !== paths) continue;
            if (source !== undefined) {
                const selected = source.selectedKey;
                model.select(Math.max(0, model.lines.findIndex(line => line.key === selected)));
            }
            this.update(model, version);
            return;
        }
    }

    public update(model: GraphExplorerModel, version: number): void {
        if (this._disposed) return;
        this._revealSelection = this._view.get() === undefined;
        this._view.set({ model, version }, undefined);
        this._updating.set(false, undefined);
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._rendering.dispose();
        stdin.off("keypress", this._onKey);
        stdout.off("resize", this._invalidate);
        stdin.setRawMode(this._raw ?? false);
        if (!this._wasFlowing) stdin.pause();
        stdout.write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l");
        this._resolve();
    }

    private readonly _invalidate = (): void => {
        this._revision.set(this._revision.get() + 1, undefined);
    };

    private readonly _onKey = (text: string, key: Key): void => {
        if (text === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
            this.dispose();
            return;
        }
        if (this._disposed) return;
        if (text === "i" && !key.ctrl && !key.meta) {
            this._showObjectIds.set(!this._showObjectIds.get(), undefined);
            return;
        }
        const expands = key.name === "right" || key.name === "return" || text === "l" || text === " ";
        if (this._busy.get() && expands) return;
        const action = this._handleKey(text, key).catch(error => {
            this._reject(error);
            this.dispose();
        });
        if (expands) this._action = action;
    };

    private async _handleKey(text: string, key: Key): Promise<void> {
        const model = this._view.get()?.model;
        if (model === undefined) return;
        this._revealSelection = true;
        this._error.set(undefined, undefined);
        const page = Math.max(1, (stdout.rows || 24) - 7);
        if (key.name === "down" || text === "j") model.move(1);
        else if (key.name === "up" || text === "k") model.move(-1);
        else if (key.name === "pagedown") model.move(page);
        else if (key.name === "pageup") model.move(-page);
        else if (key.name === "home" || text === "g") model.select(0);
        else if (key.name === "end" || text === "G") model.select(model.lines.length - 1);
        else if (key.name === "left" || text === "h") model.collapseSelected();
        else if (key.name === "right" || key.name === "return" || text === "l" || text === " ") {
            this._busy.set(true, undefined);
            try {
                await model.expandSelected();
            } catch (error) {
                this._error.set(error instanceof Error ? error.message : String(error), undefined);
            } finally {
                this._busy.set(false, undefined);
            }
        }
        this._invalidate();
    }
}

export interface GraphScreenOptions {
    readonly title: string;
    readonly params: string;
    readonly version?: number;
    readonly columns: number;
    readonly rows: number;
    readonly scrollTop: number;
    readonly revealSelection?: boolean;
    readonly showObjectIds?: boolean;
    readonly status?: string;
    readonly error?: boolean;
}

export function renderGraphScreen(
    model: GraphExplorerModel | undefined,
    options: GraphScreenOptions,
): { readonly text: string; readonly scrollTop: number } {
    const width = Math.max(1, options.columns - 1);
    const height = Math.max(1, options.rows);
    const capacity = Math.max(1, height - 7);
    const lines = model?.lines ?? [];
    const selected = model?.selectedIndex ?? 0;
    const scrollTop = Math.max(0, Math.min(
        options.revealSelection === false ? options.scrollTop
            : selected < options.scrollTop ? selected
            : selected >= options.scrollTop + capacity ? selected - capacity + 1 : options.scrollTop,
        Math.max(0, lines.length - capacity),
    ));
    const frame: string[] = [];
    const row = (text: string, style = "\x1b[37m"): void => {
        frame.push(`${style}${clip(text, width)}\x1b[K\x1b[0m`);
    };
    row(` GRAPH EXPLORER    ${options.version === undefined ? "CONNECTING" : `LIVE  v${options.version}`}`, "\x1b[1;36m");
    row(` ${options.title}  ${options.params}`, "\x1b[90m");
    row(" " + "\u2500".repeat(Math.max(0, width - 2)), "\x1b[90m");
    const labels = formatGraphTreeRows(lines, options.showObjectIds === true);
    for (let offset = 0; offset < capacity; offset++) {
        const index = scrollTop + offset;
        row(index < lines.length ? " " + labels[index] : "",
            index === selected && lines.length > 0 ? "\x1b[1;30;46m"
                : lines[index]?.ref === undefined ? "\x1b[37m" : "\x1b[36m");
    }
    row(" " + "\u2500".repeat(Math.max(0, width - 2)), "\x1b[90m");
    row(` ${options.status ?? (model === undefined ? "Waiting for first root..." : model.selectedKey)}`,
        options.error ? "\x1b[31m" : "\x1b[90m");
    row(` ${lines.length === 0 ? 0 : selected + 1}/${lines.length}  ${model?.cachedObjects ?? 0} cached objects`
        + `    \u2191\u2193 move  \u2192/Enter open  \u2190 close  i IDs:${options.showObjectIds ? "on" : "off"}  q quit`, "\x1b[36m");
    return {
        text: frame.slice(0, height).map((line, index) => `\x1b[${index + 1};1H${line}`).join("") + "\x1b[J",
        scrollTop,
    };
}

function clip(text: string, width: number): string {
    const characters = [...safeTerminalText(text)];
    return characters.length <= width ? characters.join("")
        : characters.slice(0, Math.max(0, width - 1)).join("") + "\u2026";
}
