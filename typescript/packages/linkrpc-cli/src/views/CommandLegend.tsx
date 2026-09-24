import React from "react";
import { Box, Text } from "ink";
import { autorun } from "@vscode/observables";
import type { ViewSession } from "./types";
import { availableViewCommands, formatCommandLegend, hostCommands, type ViewHostActions } from "./commands";
import { safeTerminalText } from "../ui/terminalText";

const noop = () => {};

/** The legend and keyboard dispatcher use the same availability and reservation policy. */
export class CommandLegend extends React.Component<{
    readonly session: ViewSession;
    readonly tabbed?: boolean;
    readonly active?: boolean;
    readonly columns?: number;
    readonly maxRows?: number;
}, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    componentDidMount(): void { this.subscribe(); }
    componentDidUpdate(previous: Readonly<{ session: ViewSession; tabbed?: boolean; active?: boolean }>): void {
        if (previous.session !== this.props.session) this.subscribe();
    }
    private subscribe(): void {
        this.subscription?.dispose();
        this.subscription = autorun(reader => {
            this.props.session.commands.read(reader);
            this.setState(previous => ({ revision: previous.revision + 1 }));
        });
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const { session, tabbed, active = true, columns = 80, maxRows } = this.props;
        const lines = viewLegendLines(session, { tabbed, active, columns, maxRows });
        return <Box flexDirection="column" flexShrink={0} height={lines.length}>
            {lines.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line}</Text>)}
        </Box>;
    }
}

export function viewLegendLines(session: ViewSession, options: {
    readonly tabbed?: boolean; readonly active?: boolean; readonly columns: number; readonly maxRows?: number;
}): readonly string[] {
    const { tabbed, active = true, columns, maxRows = Infinity } = options;
    const actions: ViewHostActions = tabbed
        ? { quit: noop, nextTab: noop, toggleScope: noop, back: noop } : { quit: noop };
    const host = hostCommands(actions, active && session.capturesInput);
    const commands = [...host, ...active ? availableViewCommands(session.commands.get(), host) : []];
    const words = safeTerminalText(formatCommandLegend(commands)).split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        if (line && [...`${line} ${word}`].length > columns) { lines.push(line); line = ""; }
        line += (line ? " " : "") + word;
    }
    if (line) lines.push(line);
    const visible = lines.slice(0, Math.max(1, maxRows));
    if (lines.length > visible.length && visible.length > 0) {
        visible[visible.length - 1] = [...visible[visible.length - 1]!].slice(0, Math.max(0, columns - 2)).join("").trimEnd() + " …";
    }
    return visible;
}
