import React from "react";
import { Box, measureElement, type DOMElement } from "ink";
import { autorun, observableValue } from "@vscode/observables";
import type { ViewSession } from "./types";
import { CommandLegend, viewLegendLines } from "./CommandLegend";

/** Gives content exactly the rows left after the command-driven legend. */
export class ViewFrame extends React.Component<{
    readonly session: ViewSession;
    readonly rows: number;
    readonly columns?: number;
    readonly maxColumns?: number;
    readonly tabbed?: boolean;
    readonly active?: boolean;
}, { revision: number }> {
    state = { revision: 0 };
    private subscription: { dispose(): void } | undefined;
    private readonly measuredColumns = observableValue(this, 1);
    private readonly root = React.createRef<DOMElement>();
    private mounted = false;
    private appliedViewport: { readonly session: ViewSession; readonly rows: number; readonly columns: number } | undefined;
    componentDidMount(): void { this.mounted = true; this.subscribe(); this.layout(); }
    componentDidUpdate(previous: Readonly<ViewFrame["props"]>): void {
        if (previous.session !== this.props.session) this.subscribe();
        this.layout();
    }
    componentWillUnmount(): void { this.mounted = false; this.subscription?.dispose(); }
    private subscribe(): void {
        this.subscription?.dispose();
        this.subscription = autorun(reader => {
            this.props.session.commands.read(reader);
            this.measuredColumns.read(reader);
            this.setState(previous => ({ revision: previous.revision + 1 }));
        });
    }
    private get columns(): number {
        return Math.min(this.props.columns ?? this.measuredColumns.get(), this.props.maxColumns ?? Infinity);
    }
    private get legendRows(): number {
        return viewLegendLines(this.props.session, { ...this.props, columns: this.columns,
            maxRows: this.props.tabbed ? Math.min(2, Math.max(1, this.props.rows - 7)) : Math.max(1, this.props.rows - 7) }).length;
    }
    private layout(): void {
        const rows = Math.max(1, this.props.rows - this.legendRows);
        const columns = this.columns;
        const previous = this.appliedViewport;
        if (previous?.session !== this.props.session || previous.rows !== rows || previous.columns !== columns) {
            this.props.session.setViewport?.(rows, columns);
            this.appliedViewport = { session: this.props.session, rows, columns };
            this.setState(value => ({ revision: value.revision + 1 }));
        }
        // Yoga dimensions become final after the commit, not during render/mount.
        queueMicrotask(() => {
            if (!this.mounted || this.props.columns !== undefined || !this.root.current) return;
            const width = Math.max(1, Math.floor(measureElement(this.root.current).width));
            if (width !== this.measuredColumns.get()) this.measuredColumns.set(width, undefined);
        });
    }
    render(): React.ReactNode {
        const { session, rows, tabbed, active } = this.props;
        const columns = this.columns;
        const legendRows = this.legendRows;
        const contentRows = Math.max(1, rows - legendRows);
        const ready = this.appliedViewport?.session === session
            && this.appliedViewport.rows === contentRows && this.appliedViewport.columns === columns;
        return <Box ref={this.root} flexDirection="column" width={this.props.columns ?? "100%"} minWidth={0}
            height={rows} flexShrink={0} overflow="hidden">
            <Box flexDirection="column" height={contentRows} flexShrink={0} overflow="hidden">
                {/* Ink 5 uses the innermost clip, so a stale oversized child can escape its parent's clip. */}
                <Box display={ready ? "flex" : "none"} flexDirection="column" height={contentRows} width={columns}>
                    {session.element}
                </Box>
            </Box>
            <CommandLegend session={session} columns={columns} maxRows={legendRows} tabbed={tabbed} active={active} />
        </Box>;
    }
}
