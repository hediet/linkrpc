import React from "react";
import { Box, Text } from "ink";
import { autorun, derived, observableValue } from "@vscode/observables";
import type { ViewCommand, ViewOpenContext, ViewSession } from "../../views/types";
import { safeTerminalText } from "../../ui/terminalText";
import { levels, watchLog, type LoggingTarget, type LogFrame, type LogOptions } from "./model";
import type { LogEntry } from "@hediet/linkrpc-infra";

interface State {
    readonly revision: number;
    readonly frame?: LogFrame;
    readonly cursor: number;
    readonly paused: boolean;
    readonly follow: boolean;
    readonly level: LogOptions["level"];
    readonly cleared: readonly LogEntry[];
    readonly rows: number;
    readonly error?: string;
}

export class LoggingSession implements ViewSession {
    readonly state = observableValue<State>(this, {
        revision: 0, cursor: 0, paused: false, follow: true, level: "trace", cleared: [], rows: 24,
    });
    readonly element = <LoggingPanel session={this} />;
    private stop!: () => void;
    private completion: Promise<void> | undefined;
    private disposed = false;
    private generation = 0;
    private latest?: LogFrame;
    constructor(private readonly context: ViewOpenContext, readonly target: LoggingTarget, private readonly options: LogOptions) {
        this.update({ level: options.level });
        this.start();
    }
    private update(patch: Partial<State>): void {
        if (this.disposed) return;
        const state = this.state.get();
        this.state.set({ ...state, ...patch, revision: state.revision + 1 }, undefined);
    }
    private start(): void {
        const generation = ++this.generation;
        const stop = new Promise<void>(resolve => { this.stop = resolve; });
        this.completion = watchLog(this.context.channel, this.target, { ...this.options, level: "trace" }, value => {
            if (this.disposed || generation !== this.generation) return;
            this.latest = value;
            const state = this.state.get();
            if (state.paused) return;
            this.showLatest();
        }, stop).then(() => {
            if (!this.disposed && generation === this.generation) this.update({ error: "Logging watch ended" });
        }, error => {
            if (!this.disposed && generation === this.generation) this.update({ error: String(error) });
        });
    }
    private showLatest(): void {
        if (!this.latest) return;
        const state = this.state.get();
        const cleared = state.frame && this.latest.revision < state.frame.revision
            ? [] : retainedCleared(state.cleared, this.latest.entries);
        const entries = visibleEntries({ ...state, frame: this.latest, cleared });
        this.update({ frame: this.latest, cleared, cursor: state.follow
            ? Math.max(0, entries.length - 1) : Math.min(state.cursor, Math.max(0, entries.length - 1)) });
    }
    get displayedEntries(): readonly LogEntry[] { return visibleEntries(this.state.get()); }
    setViewport(rows: number): void { if (this.state.get().rows !== rows) this.update({ rows }); }
    captureState(): unknown {
        const { level, follow, paused } = this.state.get();
        return { level, follow, paused };
    }
    restoreState(value: unknown): void {
        const state = value as Partial<Pick<State, "level" | "follow" | "paused">> | undefined;
        if (state) this.update({
            level: [...levels, "off"].includes(state.level as typeof levels[number]) ? state.level : this.state.get().level,
            follow: state.follow === false ? false : true, paused: state.paused === true,
        });
    }
    readonly commands = derived(this, (reader): readonly ViewCommand[] => {
        const state = this.state.read(reader);
        if (this.disposed) return [];
        const entries = visibleEntries(state);
        const command = (id: string, title: string, key: string, execute: () => void, enabled = true): ViewCommand =>
            ({ id: `logging.${id}`, title, context: "Logging", keybindings: [{ key }], execute, enabled });
        const move = (delta: number) => this.update({
            cursor: Math.max(0, Math.min(entries.length - 1, this.state.get().cursor + delta)),
            follow: false,
        });
        return [
            command("up", "Previous entry", "up", () => move(-1), state.cursor > 0),
            command("down", "Next entry", "down", () => move(1), state.cursor + 1 < entries.length),
            command("pageUp", "Page up", "pageup", () => move(-Math.max(1, state.rows - 4)), state.cursor > 0),
            command("pageDown", "Page down", "pagedown", () => move(Math.max(1, state.rows - 4)), state.cursor + 1 < entries.length),
            command("follow", state.follow ? "Stop following" : "Follow latest", "f",
                () => this.update({ follow: !state.follow, cursor: state.follow ? state.cursor : Math.max(0, entries.length - 1) })),
            command("pause", state.paused ? "Resume updates" : "Pause updates", "p", () => {
                this.update({ paused: !state.paused });
                if (state.paused) this.showLatest();
            }),
            command("clear", "Clear displayed entries (local)", "c",
                () => this.update({ cleared: state.frame?.entries ?? [], cursor: 0 })),
            command("filter", `Minimum level: ${state.level}`, "l", () => {
                const list = [...levels, "off"] as const;
                this.update({ level: list[(list.indexOf(state.level) + 1) % list.length]!, cursor: 0 });
            }),
        ];
    });
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation++;
        this.stop?.();
        this.state.set({ ...this.state.get(), revision: this.state.get().revision + 1 }, undefined);
    }
    async disposeAsync(): Promise<void> { this.dispose(); await this.completion; }
}

function visibleEntries(state: State): readonly LogEntry[] {
    return state.frame?.entries.slice(state.cleared.length).filter(entry =>
        state.level !== "off" && levels.indexOf(entry.level) >= levels.indexOf(state.level as typeof levels[number])) ?? [];
}

function retainedCleared(previous: readonly LogEntry[], current: readonly LogEntry[]): readonly LogEntry[] {
    if (previous.length === 0 || current.length === 0) return [];
    const oldKeys = previous.map(entry => JSON.stringify(entry));
    const newKeys = current.map(entry => JSON.stringify(entry));
    // The wire format has no entry identity. Ambiguous duplicate values must
    // reappear rather than accidentally hiding a newly appended identical log.
    if (new Set(oldKeys).size !== oldKeys.length || new Set(newKeys).size !== newKeys.length) return [];
    for (let count = Math.min(previous.length, current.length); count > 0; count--) {
        if (oldKeys.slice(-count).every((key, index) => key === newKeys[index])) return current.slice(0, count);
    }
    return [];
}

export class LoggingPanel extends React.Component<{ readonly session: LoggingSession }, { revision: number }> {
    state = { revision: 0 };
    private subscription?: { dispose(): void };
    componentDidMount(): void {
        this.subscription = autorun(reader => this.setState({ revision: this.props.session.state.read(reader).revision }));
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const state = this.props.session.state.get();
        const entries = this.props.session.displayedEntries;
        const rows = Math.max(1, state.rows - 4);
        const start = Math.max(0, Math.min(state.cursor, entries.length - 1) - rows + 1);
        return <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <Text bold>Logging {safeTerminalText(this.props.session.target.serviceId || "<root>")} revision {state.frame?.revision ?? "…"}</Text>
            <Text dimColor>level {state.level} · {state.paused ? "paused" : "live"} · {state.follow ? "follow" : "manual"} · {state.frame?.hidden ?? 0} earlier hidden · clear is local</Text>
            {state.error && <Text color="red">{safeTerminalText(state.error)}</Text>}
            {entries.slice(start, start + rows).map((entry, index) =>
                <Text key={`${start + index}:${entry.timestamp}`} color={start + index === state.cursor ? "cyan" : undefined} wrap="truncate-end">
                    {start + index === state.cursor ? "› " : "  "}
                    {safeTerminalText(`${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}`
                        + (entry.attributes ? ` ${JSON.stringify(entry.attributes)}` : "")
                        + (entry.error ? ` ${entry.error.name ?? "Error"}: ${entry.error.message}${entry.error.stack ? ` ${entry.error.stack}` : ""}` : ""))}
                </Text>)}
        </Box>;
    }
}
