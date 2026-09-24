import React from "react";
import { Box, Text } from "ink";
import { autorun, derived, observableValue, type IObservable } from "@vscode/observables";
import type { ViewCommand, ViewSession } from "../views/types";
import type { SchemaState } from "./UiModel";
import { safeTerminalText } from "./terminalText";

/** Built-in read-only view; uses the same viewport and command contract as contributions. */
export class SchemaSession implements ViewSession {
    readonly element = <SchemaPanel session={this} />;
    readonly viewport = observableValue(this, { rows: 24, columns: 80, top: 0, left: 0, disposed: false });
    constructor(readonly schema: IObservable<SchemaState>) {}
    readonly lines = derived(this, reader => {
        const value = this.schema.read(reader);
        return (value.kind === "loaded" ? JSON.stringify(value.schema, null, 2)
            : value.kind === "error" ? String(value.error)
            : value.kind === "none" ? "Select an interface to inspect its schema." : "Loading schema…")
            .split("\n").map(safeTerminalText);
    });
    readonly commands = derived(this, (reader): readonly ViewCommand[] => {
        const viewport = this.viewport.read(reader);
        if (viewport.disposed) return [];
        const lines = this.lines.read(reader);
        const page = Math.max(1, viewport.rows - 2);
        const maxTop = Math.max(0, lines.length - page);
        const maxLeft = Math.max(0, lines.reduce((width, line) => Math.max(width, [...line].length), 0) - viewport.columns);
        const top = Math.min(viewport.top, maxTop), left = Math.min(viewport.left, maxLeft);
        const move = (vertical: number, horizontal = 0) => this.viewport.set({
            ...this.viewport.get(), top: Math.max(0, Math.min(maxTop, top + vertical)),
            left: Math.max(0, Math.min(maxLeft, left + horizontal)),
        }, undefined);
        const command = (id: string, title: string, keys: readonly string[], execute: () => void, enabled: boolean): ViewCommand =>
            ({ id: `schema.${id}`, title, keybindings: keys.map(key => ({ key })), execute, enabled, context: "Schema" });
        return [
            command("up", "Scroll up", ["up", "k"], () => move(-1), top > 0),
            command("down", "Scroll down", ["down", "j"], () => move(1), top < maxTop),
            command("pageUp", "Page up", ["pageup"], () => move(-page), top > 0),
            command("pageDown", "Page down", ["pagedown"], () => move(page), top < maxTop),
            command("first", "First line", ["home", "g"], () => move(-maxTop), top > 0),
            command("last", "Last line", ["end", "G"], () => move(maxTop), top < maxTop),
            command("left", "Scroll left", ["left", "h"], () => move(0, -20), left > 0),
            command("right", "Scroll right", ["right", "l"], () => move(0, 20), left < maxLeft),
        ];
    });
    setViewport(rows: number, columns = this.viewport.get().columns): void {
        const state = this.viewport.get();
        if (rows !== state.rows || columns !== state.columns) this.viewport.set({ ...state, rows, columns }, undefined);
    }
    captureState(): unknown { const { top, left } = this.viewport.get(); return { top, left }; }
    restoreState(value: unknown): void {
        const state = value as { top?: number; left?: number } | undefined;
        if (state) this.viewport.set({ ...this.viewport.get(), top: state.top ?? 0, left: state.left ?? 0 }, undefined);
    }
    dispose(): void { this.viewport.set({ ...this.viewport.get(), disposed: true }, undefined); }
}

class SchemaPanel extends React.Component<{ readonly session: SchemaSession }, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    componentDidMount(): void {
        this.subscription = autorun(reader => {
            this.props.session.viewport.read(reader);
            this.props.session.lines.read(reader);
            this.setState(previous => ({ revision: previous.revision + 1 }));
        });
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const { session } = this.props;
        const { rows, columns, top } = session.viewport.get();
        const lines = session.lines.get();
        const left = Math.min(session.viewport.get().left,
            Math.max(0, lines.reduce((width, line) => Math.max(width, [...line].length), 0) - columns));
        const capacity = Math.max(1, rows - 2);
        const start = Math.min(top, Math.max(0, lines.length - capacity));
        const schema = session.schema.get();
        return <Box flexDirection="column" width={columns} height={rows} flexShrink={0} overflow="hidden">
            {rows > 1 && <Box height={1} flexShrink={0} overflow="hidden">
                <Text bold color="cyan" wrap="truncate-end">{schema.kind === "loaded" ? `SCHEMA ${safeTerminalText(schema.schema.id)}` : "SCHEMA"}</Text>
            </Box>}
            {Array.from({ length: capacity }, (_, offset) => <Box key={offset} height={1} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">{[...(lines[start + offset] ?? "")].slice(left).join("") || " "}</Text>
            </Box>)}
            {rows > 2 && <Box height={1} flexShrink={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">{`Lines ${start + 1}–${Math.min(lines.length, start + capacity)}/${lines.length} · column ${left + 1}`}</Text>
            </Box>}
        </Box>;
    }
}
