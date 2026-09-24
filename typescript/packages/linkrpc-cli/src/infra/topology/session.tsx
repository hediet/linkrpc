import React from "react";
import { Box, Text } from "ink";
import { autorun, derived, observableValue } from "@vscode/observables";
import type { ViewCommand, ViewOpenContext, ViewSession } from "../../views/types";
import { formatCommandLegend } from "../../views/commands";
import { safeTerminalText } from "../../ui/terminalText";
import { topologyDocument } from "./diagram";
import { TopologyObservation, type TopologyTarget } from "./model";

interface State {
    readonly lines: readonly string[];
    readonly rows: number;
    readonly columns: number;
    readonly top: number;
    readonly left: number;
    readonly snapshots: number;
    readonly nodes: number;
    readonly links: number;
    readonly help: boolean;
    readonly helpTop: number;
    readonly refreshing: boolean;
    readonly ended: boolean;
    readonly error?: string;
    readonly disposed: boolean;
}

export class TopologySession implements ViewSession {
    readonly element = <TopologyPanel session={this} />;
    readonly maxLegendRows = 2;
    readonly state = observableValue<State>(this, {
        lines: [], rows: 24, columns: 80, top: 0, left: 0, snapshots: 0, nodes: 0, links: 0,
        help: false, helpTop: 0, refreshing: false, ended: false, disposed: false,
    });
    private readonly observation: TopologyObservation;
    constructor(context: ViewOpenContext, readonly target: TopologyTarget, timeoutMs: number) {
        this.observation = new TopologyObservation(context, target, timeoutMs, {
            onGraph: graph => {
                const document = topologyDocument(graph);
                this.update({ lines: document.lines, snapshots: this.state.get().snapshots + 1,
                    nodes: graph.nodes.length, links: graph.links.length, error: undefined });
            },
            onError: error => this.update({ error: String(error) }),
            onEnd: () => this.update({ ended: true, error: this.state.get().error ?? "Topology invalidation watch ended" }),
        });
    }
    private update(patch: Partial<State>): void {
        const state = this.state.get();
        if (!state.disposed) this.state.set({ ...state, ...patch }, undefined);
    }
    setViewport(rows: number, columns = this.state.get().columns): void {
        const state = this.state.get();
        if (state.rows !== rows || state.columns !== columns) this.update({ rows, columns });
    }
    captureState(): unknown { const { top, left } = this.state.get(); return { top, left }; }
    restoreState(value: unknown): void {
        const state = value as { top?: number; left?: number } | undefined;
        if (state) this.update({ top: Math.max(0, Number(state.top) || 0), left: Math.max(0, Number(state.left) || 0) });
    }
    readonly commands = derived(this, (reader): readonly ViewCommand[] => {
        const state = this.state.read(reader);
        if (state.disposed) return [];
        const lines = this.content(state);
        const page = Math.max(1, state.rows - 2);
        const maxTop = Math.max(0, lines.length - page);
        const maxLeft = Math.max(0, lines.reduce((length, line) => Math.max(length, [...line].length), 0) - 1);
        const top = Math.min(state.help ? state.helpTop : state.top, maxTop);
        const left = state.help ? 0 : Math.min(state.left, maxLeft);
        const move = (vertical: number, horizontal = 0) => {
            const next = Math.max(0, Math.min(maxTop, top + vertical));
            this.update(state.help ? { helpTop: next } : { top: next, left: Math.max(0, Math.min(maxLeft, left + horizontal)) });
        };
        const command = (id: string, title: string, keys: readonly string[], execute: () => void, enabled = true): ViewCommand => ({
            id: `topology.${id}`, title, context: state.help ? "Topology commands" : "Topology",
            keybindings: keys.map(key => ({ key })), execute, enabled,
        });
        return [
            command("help", state.help ? "Close commands" : "Show commands", ["?"], () => this.update({ help: !state.help, helpTop: 0 })),
            command("refresh", "Refresh snapshot", ["r"], () => {
                this.update({ refreshing: true });
                void this.observation.refresh().finally(() => this.update({ refreshing: false }));
            }, !state.refreshing),
            command("up", "Scroll up", ["up", "k"], () => move(-1), top > 0),
            command("down", "Scroll down", ["down", "j"], () => move(1), top < maxTop),
            command("pageUp", "Page up", ["pageup"], () => move(-page), top > 0),
            command("pageDown", "Page down", ["pagedown"], () => move(page), top < maxTop),
            command("first", "First line", ["home", "g"], () => move(-maxTop), top > 0),
            command("last", "Last line", ["end", "G"], () => move(maxTop), top < maxTop),
            command("left", "Scroll left", ["left", "h"], () => move(0, -8), !state.help && left > 0),
            command("right", "Scroll right", ["right", "l"], () => move(0, 8), !state.help && left < maxLeft),
            command("pageLeft", "Page left", ["["], () => move(0, -state.columns), !state.help && left > 0),
            command("pageRight", "Page right", ["]"], () => move(0, state.columns), !state.help && left < maxLeft),
        ];
    });

    private content(state: State): readonly string[] {
        // A fixed count breaks the dependency cycle between help scrolling and the
        // command list; actual help text is generated from that list in render().
        if (state.help) return Array.from({ length: 13 }, () => "");
        return state.lines.length ? state.lines : [state.error ? `Fetch/watch failed: ${state.error}` : "Loading topology…"];
    }
    displayLines(): readonly string[] {
        const state = this.state.get();
        if (!state.help) return this.content(state);
        return ["TOPOLOGY COMMANDS (unavailable commands are marked)", ...this.commands.get().map(command =>
            formatCommandLegend([{ ...command, enabled: true }]) + (command.enabled === false ? " [unavailable]" : ""))];
    }
    dispose(): void {
        if (this.state.get().disposed) return;
        this.state.set({ ...this.state.get(), disposed: true }, undefined);
        this.observation.dispose();
    }
    async disposeAsync(): Promise<void> { this.dispose(); await this.observation.disposeAsync(); }
}

export class TopologyPanel extends React.Component<{ readonly session: TopologySession }, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    componentDidMount(): void {
        this.subscription = autorun(reader => {
            this.props.session.state.read(reader);
            this.setState(value => ({ revision: value.revision + 1 }));
        });
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const { session } = this.props;
        const state = session.state.get();
        const lines = session.displayLines();
        const capacity = Math.max(1, state.rows - 2);
        const top = Math.min(state.help ? state.helpTop : state.top, Math.max(0, lines.length - capacity));
        const maxLeft = Math.max(0, lines.reduce((length, line) => Math.max(length, [...line].length), 0) - 1);
        const left = state.help ? 0 : Math.min(state.left, maxLeft);
        const status = state.error ? `ERROR: ${state.error}` : state.refreshing ? "Refreshing…"
            : `Lines ${top + 1}–${Math.min(lines.length, top + capacity)}/${lines.length} · character ${left + 1} · ${state.nodes} nodes / ${state.links} links`;
        return <Box flexDirection="column" width={state.columns} height={state.rows} flexShrink={0} overflow="hidden">
            {state.rows > 1 && <Box height={1} flexShrink={0} overflow="hidden">
                <Text bold color={state.error ? "red" : "cyan"} wrap="truncate-end">
                    {safeTerminalText(`TOPOLOGY ${state.ended ? "STOPPED" : "LIVE"} — ${session.target.serviceId || "<root>"} · snapshot ${state.snapshots}`)}
                </Text>
            </Box>}
            {Array.from({ length: capacity }, (_, offset) => <Box key={offset} height={1} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">{[...safeTerminalText(lines[top + offset] ?? "")].slice(left).join("") || " "}</Text>
            </Box>)}
            {state.rows > 2 && <Box height={1} flexShrink={0} overflow="hidden">
                <Text dimColor={!state.error} color={state.error ? "red" : undefined} wrap="truncate-end">{safeTerminalText(status)}</Text>
            </Box>}
        </Box>;
    }
}
