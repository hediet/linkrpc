import React from "react";
import { Box, Text } from "ink";
import { autorun } from "@vscode/observables";
import type { UiModel } from "./UiModel";
import { safeTerminalText } from "./terminalText";
import { ViewFrame } from "../views/ViewFrame";
import { formatCommandLegend, hostCommands } from "../views/commands";

/** Class binding keeps contributed views hook-free. Models own their sessions. */
export class ViewArea extends React.Component<{
    readonly model: UiModel;
    readonly height: number;
    readonly chromeRows?: number;
    readonly columns?: number;
    readonly children: React.ReactNode;
}, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    componentDidMount(): void {
        this.subscription = autorun(reader => {
            const model = this.props.model;
            model.views.tab.read(reader);
            model.views.kind.read(reader);
            model.views.tabs.read(reader);
            model.views.session.read(reader);
            model.views.error.read(reader);
            model.focusedColumn.read(reader);
            model.currentSchemaState.read(reader);
            this.setState(previous => ({ revision: previous.revision + 1 }));
        });
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const model = this.props.model;
        const views = model.views;
        const selected = views.tab.get();
        const tabs = views.tabs.get();
        const current = tabs.find(tab => tab.id === selected);
        const chromeRows = this.props.chromeRows ?? 2;
        const contentRows = Math.max(1, this.props.height - chromeRows);
        return <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} height={this.props.height} overflow="hidden">
            {chromeRows > 0 && <Box height={1} flexShrink={0}><Text wrap="truncate-end">{views.kind.get()}: {tabs.map(tab => tab.id === selected ? `[${tab.title}]` : tab.title).join("  ")}</Text></Box>}
            {chromeRows > 1 && <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{safeTerminalText(current?.condition ?? "Unavailable for this target")}</Text></Box>}
            {selected === "methods" ? <Box height={contentRows} flexShrink={0} overflow="hidden">{this.props.children}</Box>
                : views.error.get() ? <Text color="red">{safeTerminalText(views.error.get()!)}</Text>
                : views.session.get() ? <ViewFrame session={views.session.get()!} rows={contentRows} maxColumns={this.props.columns}
                    tabbed active={model.focusedColumn.get() > 0} />
                    : <Text>{current ? "Loading view…" : "View unavailable; press tab"}</Text>}
        </Box>;
    }
}

export class ViewFooter extends React.Component<{ readonly model: UiModel }, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    componentDidMount(): void {
        this.subscription = autorun(reader => {
            this.props.model.views.tab.read(reader);
            this.props.model.views.session.read(reader);
            this.props.model.focusedColumn.read(reader);
            this.props.model.formEditing.read(reader);
            this.setState(previous => ({ revision: previous.revision + 1 }));
        });
    }
    componentWillUnmount(): void { this.subscription?.dispose(); }
    render(): React.ReactNode {
        const model = this.props.model;
        if (model.views.session.get()) return <Text dimColor>
            {model.focusedColumn.get() === 0 ? "Enter/→: focus view" : "View commands shown above"}
        </Text>;
        const noop = () => {};
        const commands = hostCommands({ quit: noop, nextTab: noop, toggleScope: noop,
            back: model.views.tab.get() !== "methods" ? noop : undefined }, model.formEditing.get());
        return <Text dimColor wrap="truncate-end">
            {(model.views.tab.get() === "methods" ? "←/→: switch column · ↑/↓: move · Enter: edit/submit · Esc: cancel edit · " : "")
                + formatCommandLegend(commands)}
        </Text>;
    }
}
