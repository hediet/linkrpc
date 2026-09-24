import React from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import { autorun, observableValue } from "@vscode/observables";
import { useObservable } from "./useObservable";
import { UiModel } from "./UiModel";
import { FieldRow } from "./FieldRow";
import { classifyField, cycleEnum, defaultValueFor } from "./schemaInspect";
import { useScroll } from "./scroll";
import type { MethodSchema } from "@hediet/linkrpc";
import { ViewArea, ViewFooter } from "./ViewArea";
import { dispatchHostKey, matchesKey } from "../views/commands";
import { TerminalKeyInput } from "../views/TerminalKeyInput";
import type { ViewKeyEvent } from "../views/types";

export interface AppProps {
    readonly model: UiModel;
}

// Fixed-height regions framing the scrollable columns. Heights are explicit
// (not flex) so the windowing math below knows exactly how many rows each list
// may render — Ink/Yoga gives no usable measurement before paint.
/** Column chrome that is not list rows: top border + bottom border + title. */
const COLUMN_CHROME_H = 3;

export function uiLayout(columns: number, rows: number, focusedColumn: number, warningCount = 0) {
    const width = Math.max(1, Math.floor(columns));
    const height = Math.max(1, Math.floor(rows));
    const compact = width < 60;
    const headerRows = height > 2 ? 1 + Math.min(warningCount, Math.max(0, height - 10)) : 0;
    const footerRows = height > 1 ? 1 : 0;
    const bodyRows = Math.max(1, height - headerRows - footerRows);
    const sidebarWidth = compact ? focusedColumn === 0 ? width : 0
        : Math.min(28, Math.max(18, Math.floor(width * .22)));
    const mainWidth = width - sidebarWidth;
    const viewHeaderRows = Math.min(bodyRows - 1, height < 20 ? 1 : 2);
    const contentRows = bodyRows - viewHeaderRows;
    const resultRows = Math.min(Math.max(0, contentRows - 1), Math.max(3, Math.min(6, Math.floor(contentRows / 3))));
    const methodRows = contentRows - resultRows;
    const splitMethods = mainWidth >= 65;
    const methodWidth = splitMethods ? Math.min(30, Math.max(22, Math.floor(mainWidth * .35))) : mainWidth;
    return { width, height, compact, headerRows, footerRows, bodyRows, sidebarWidth, mainWidth,
        viewHeaderRows, contentRows, resultRows, methodRows, splitMethods, methodWidth };
}

/**
 * Miller-column TUI: three columns left → right (services, methods, form)
 * plus a result pane at the bottom. ←/→ moves focus between columns, ↑/↓
 * moves the cursor inside the focused column. Each cursor move in columns
 * 0 / 1 immediately previews into the column to its right.
 */
export const App: React.FC<AppProps> = ({ model }) => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    // Keep Ink's raw-mode lease while contributed tabs unmount the method/form
    // input handlers. TerminalKeyInput dispatches the complete readline key set.
    useInput(() => {});
    return <AppLayout model={model} exit={exit} stdout={stdout} />;
};

class AppLayout extends React.Component<AppProps & {
    readonly exit: () => void;
    readonly stdout: NodeJS.WriteStream;
}, { revision: number }> {
    state = { revision: 0 };
    private readonly measuredColumns = observableValue<number | undefined>(this, undefined);
    private readonly root = React.createRef<DOMElement>();
    private mounted = false;
    private subscription: { dispose(): void } | undefined;
    private readonly invalidate = () => this.setState(previous => ({ revision: previous.revision + 1 }));
    componentDidMount(): void {
        this.mounted = true;
        // Update explicit pane bounds before Ink's synchronous resize repaint.
        this.props.stdout.prependListener("resize", this.invalidate);
        this.subscription = autorun(reader => {
            const { model } = this.props;
            model.focusedColumn.read(reader);
            model.formEditing.read(reader);
            model.discoveryWarnings.read(reader);
            model.views.tab.read(reader);
            this.measuredColumns.read(reader);
            this.invalidate();
        });
        this.measure();
    }
    componentDidUpdate(): void { this.measure(); }
    private measure(): void {
        queueMicrotask(() => {
            if (!this.mounted || !this.root.current) return;
            const width = Math.max(1, Math.floor(measureElement(this.root.current).width));
            if (width !== this.measuredColumns.get()) this.measuredColumns.set(width, undefined);
        });
    }
    componentWillUnmount(): void {
        this.mounted = false;
        this.subscription?.dispose();
        this.props.stdout.off("resize", this.invalidate);
    }
    private readonly onKey = (event: ViewKeyEvent) => {
        const { model, exit } = this.props;
        const focusedColumn = model.focusedColumn.get();
        // While editing a field, the text input owns input — don't intercept
        // ← / → for column nav (those move the text cursor).
        if (model.formEditing.get()) {
            if (matchesKey({ key: "c", ctrl: true }, event)) exit();
            return;
        }
        const inView = model.views.tab.get() !== "methods" && focusedColumn > 0;
        if (dispatchHostKey(inView ? model.views.session.get() : undefined, event, {
            quit: exit,
            nextTab: () => model.views.cycleTab(),
            toggleScope: () => model.views.toggleKind(),
            back: inView ? () => model.focusColumn(0) : undefined,
        })) return;
        if (inView) return;
        if (event.name === "left" && focusedColumn > 0) {
            model.focusColumn((focusedColumn - 1) as 0 | 1 | 2);
            return;
        }
        if (event.name === "right" && focusedColumn < 2) {
            model.focusColumn((focusedColumn + 1) as 0 | 1 | 2);
            return;
        }
    };

    render(): React.ReactNode {
            const { model, stdout } = this.props;
            const focusedColumn = model.focusedColumn.get();
            const warnings = model.discoveryWarnings.get();
            const columns = Math.min(this.measuredColumns.get() ?? 1, stdout.columns ?? 80);
            const layout = uiLayout(columns, stdout.rows ?? 30, focusedColumn, warnings.length);
            return <Box ref={this.root} flexDirection="column" width="100%" minWidth={0} height={layout.height} overflow="hidden">
                <TerminalKeyInput onKey={this.onKey} />
                {layout.headerRows > 0 && <Box height={layout.headerRows} flexShrink={0} overflow="hidden">
                    <Header model={model} warnings={warnings.slice(0, layout.headerRows - 1)} />
                </Box>}
                <Box width={layout.width} height={layout.bodyRows} flexShrink={0} overflow="hidden">
                    {layout.sidebarWidth > 0 && <ServicesColumn model={model} focused={focusedColumn === 0}
                        width={layout.sidebarWidth} height={layout.bodyRows} listHeight={Math.max(1, layout.bodyRows - COLUMN_CHROME_H)} />}
                    {layout.mainWidth > 0 && <Box width={layout.mainWidth} height={layout.bodyRows} flexShrink={0} overflow="hidden">
                        <ViewArea model={model} height={layout.bodyRows} columns={layout.mainWidth} chromeRows={layout.viewHeaderRows}>
                            <Box flexDirection="column" height={layout.contentRows} width={layout.mainWidth} flexShrink={0} overflow="hidden">
                                <Box height={layout.methodRows} width={layout.mainWidth} flexShrink={0} overflow="hidden">
                                    {(layout.splitMethods || focusedColumn !== 2) && <MethodsColumn model={model}
                                        focused={focusedColumn === 1} width={layout.methodWidth} height={layout.methodRows}
                                        listHeight={Math.max(1, layout.methodRows - COLUMN_CHROME_H)} />}
                                    {(layout.splitMethods || focusedColumn === 2) && <FormColumn model={model}
                                        focused={focusedColumn === 2} height={layout.methodRows}
                                        listHeight={Math.max(1, layout.methodRows - COLUMN_CHROME_H)} />}
                                </Box>
                                {layout.resultRows > 0 && <ResultPane model={model} height={layout.resultRows} />}
                            </Box>
                        </ViewArea>
                    </Box>}
                </Box>
                {layout.footerRows > 0 && <Box height={layout.footerRows} flexShrink={0} overflow="hidden">
                    <ViewFooter model={model} />
                </Box>}
            </Box>;
    }
}

/** "▲ N more" / "▼ N more" indicator row, shown only when items are hidden. */
const ScrollIndicator: React.FC<{ direction: "up" | "down"; count: number }> = ({ direction, count }) => {
    if (count <= 0) return null;
    const arrow = direction === "up" ? "\u25b2" : "\u25bc";
    return <Text dimColor>{`  ${arrow} ${count} more`}</Text>;
};

// -- header: signing identity --

const Header: React.FC<{ model: UiModel; warnings: readonly string[] }> = ({ model, warnings }) => {
    const identity = useObservable(model.identity);
    return (
        <Box flexDirection="column">
            <Box height={1} flexShrink={0}>
                <Text dimColor>identity: </Text>
                <Text wrap="truncate-end">{identity ?? "(resolving…)"}</Text>
            </Box>
            {warnings.map((warning) => (
                <Text key={warning} color="yellow" wrap="truncate-end">! {warning}</Text>
            ))}
        </Box>
    );
};

// -- col 0: services --

const ServicesColumn: React.FC<{ model: UiModel; focused: boolean; width: number; height: number; listHeight: number }> = ({ model, focused, width, height, listHeight }) => {
    const result = useObservable(model.servicesPromise.promiseResult);
    const selection = useObservable(model.selection);

    useInput(
        (_input, key) => {
            if (key.upArrow) model.moveServiceCursor(-1);
            else if (key.downArrow) model.moveServiceCursor(1);
            else if (key.return) model.focusColumn(1);
        },
        { isActive: focused },
    );

    const services = !result || result.error ? [] : (result.data ?? []);
    const cursorIdx = selection
        ? services.findIndex((s) =>
            s.serviceId === selection.serviceId
            && s.interfaceId === selection.interfaceId
            && (s.isDefault === true) === (selection.isDefault === true))
        : -1;
    const win = useScroll(services.length, Math.max(0, cursorIdx), listHeight);

    return (
        <Column title="Services" focused={focused} width={width} height={height}>
            {!result ? (
                <Text dimColor>Loading…</Text>
            ) : result.error ? (
                <Text color="red">Error: {String(result.error)}</Text>
            ) : services.length === 0 ? (
                <Text dimColor>(no services)</Text>
            ) : (
                <>
                    <ScrollIndicator direction="up" count={win.above} />
                    {services.slice(win.start, win.end).map((s) => {
                        const isCursor = !!selection
                            && selection.serviceId === s.serviceId
                            && selection.interfaceId === s.interfaceId
                            && (selection.isDefault === true) === (s.isDefault === true);
                        return (
                            <Text
                                key={`${s.isDefault === true ? "default" : s.serviceId}/${s.interfaceId}`}
                                color={isCursor ? (focused ? "cyan" : "white") : undefined}
                                wrap="truncate-end"
                            >
                                {(isCursor ? "\u203a " : "  ")
                                    + (s.isDefault === true ? "default " : s.serviceId ? `${s.serviceId} ` : "")}
                                <Text dimColor>{s.interfaceId}</Text>
                            </Text>
                        );
                    })}
                    <ScrollIndicator direction="down" count={win.below} />
                </>
            )}
        </Column>
    );
};

// -- col 1: methods --

const MethodsColumn: React.FC<{ model: UiModel; focused: boolean; width: number; height: number; listHeight: number }> = ({ model, focused, width, height, listHeight }) => {
    const selection = useObservable(model.selection);
    const schemaState = useObservable(model.currentSchemaState);
    const methods = useObservable(model.currentMethods);

    useInput(
        (_input, key) => {
            if (key.upArrow) model.moveMethodCursor(-1);
            else if (key.downArrow) model.moveMethodCursor(1);
            else if (key.return) model.focusColumn(2);
        },
        { isActive: focused },
    );

    const cursorIdx = selection?.methodName !== undefined
        ? methods.findIndex((m) => m.name === selection.methodName)
        : -1;
    const win = useScroll(methods.length, Math.max(0, cursorIdx), listHeight);

    return (
        <Column title="Methods" focused={focused} width={width} height={height}>
            {!selection ? (
                <Text dimColor>(select a service)</Text>
            ) : schemaState.kind === "loading" ? (
                <Text dimColor>Loading…</Text>
            ) : schemaState.kind === "error" ? (
                <Text color="red">Error: {String(schemaState.error)}</Text>
            ) : methods.length === 0 ? (
                <Text dimColor>(no methods)</Text>
            ) : (
                <>
                    <ScrollIndicator direction="up" count={win.above} />
                    {methods.slice(win.start, win.end).map((m) => {
                        const isCursor = selection.methodName === m.name;
                        return (
                            <Text
                                key={m.name}
                                color={isCursor ? (focused ? "cyan" : "white") : undefined}
                                wrap="truncate-end"
                            >
                                {(isCursor ? "\u203a " : "  ")}
                                <Text dimColor>{m.result === undefined ? "notify " : "req    "}</Text>
                                {m.name}
                                {m.serverStream !== undefined ? <Text color="magenta">{" \u2193stream"}</Text> : null}
                            </Text>
                        );
                    })}
                    <ScrollIndicator direction="down" count={win.below} />
                </>
            )}
        </Column>
    );
};

// -- col 2: form --

const FormColumn: React.FC<{ model: UiModel; focused: boolean; height: number; listHeight: number }> = ({ model, focused, height, listHeight }) => {
    const selection = useObservable(model.selection);
    const schemaState = useObservable(model.currentSchemaState);

    return (
        <Column title="Form" focused={focused} flexGrow={1} height={height}>
            {!selection ? (
                <Text dimColor>(select a service first)</Text>
            ) : selection.methodName === undefined ? (
                <Text dimColor>(select a method first)</Text>
            ) : schemaState.kind === "loading" ? (
                <Text dimColor>Loading…</Text>
            ) : schemaState.kind === "loaded" && schemaState.method ? (
                <MethodForm model={model} method={schemaState.method} focused={focused} listHeight={listHeight} />
            ) : schemaState.kind === "error" ? (
                <Text color="red">Error: {String(schemaState.error)}</Text>
            ) : (
                <Text color="red">Method "{selection.methodName}" not in schema</Text>
            )}
        </Column>
    );
};

const MethodForm: React.FC<{ model: UiModel; method: MethodSchema & { readonly name: string }; focused: boolean; listHeight: number }> = ({ model, method, focused, listHeight }) => {
    const fields = useObservable(model.currentFields);
    const formValues = useObservable(model.formValues);
    const errors = useObservable(model.formErrors);
    const canSubmit = useObservable(model.canSubmit);
    const cursor = useObservable(model.formCursor);
    const editing = useObservable(model.formEditing);

    const submitRowIdx = fields.length;
    const safeCursor = Math.max(0, Math.min(submitRowIdx, cursor));
    const focusedField = safeCursor < submitRowIdx ? fields[safeCursor] : undefined;

    // Rows the field list may occupy: the column's list area minus the method
    // header (name + optional summary + blank) and the submit affordance
    // (blank + submit line). Fields are windowed so a long parameter list never
    // overflows the column and corrupts the panes below.
    const headerLines = 1 + (method.summary ? 1 : 0) + 1;
    const submitLines = 2;
    const fieldsHeight = Math.max(1, listHeight - headerLines - submitLines);
    const win = useScroll(fields.length, Math.min(safeCursor, Math.max(0, fields.length - 1)), fieldsHeight);

    useInput(
        (input, key) => {
            if (key.upArrow) {
                model.formCursor.set(Math.max(0, safeCursor - 1), undefined);
                return;
            }
            if (key.downArrow) {
                model.formCursor.set(Math.min(submitRowIdx, safeCursor + 1), undefined);
                return;
            }
            if (focusedField) {
                const cls = classifyField(focusedField.schema);
                const current = formValues[focusedField.name];
                if (cls.kind === "boolean" && input === " ") {
                    model.setField(focusedField.name, !current);
                    return;
                }
                if (cls.kind === "enum") {
                    if (key.leftArrow || key.rightArrow) {
                        const dir: 1 | -1 = key.rightArrow ? 1 : -1;
                        const seed = current === undefined ? defaultValueFor(cls) : current;
                        model.setField(focusedField.name, cycleEnum(cls.enumValues ?? [], seed, dir));
                        return;
                    }
                }
                if (key.return) {
                    if (cls.kind === "boolean") {
                        model.setField(focusedField.name, !current);
                        return;
                    }
                    if (cls.kind === "enum") {
                        const seed = current === undefined ? defaultValueFor(cls) : current;
                        model.setField(focusedField.name, cycleEnum(cls.enumValues ?? [], seed, 1));
                        return;
                    }
                    if (current === undefined) {
                        model.setField(focusedField.name, defaultValueFor(cls));
                    }
                    model.formEditing.set(true, undefined);
                    return;
                }
                if (input === "x" && focusedField.required === false && current !== undefined) {
                    model.setField(focusedField.name, undefined);
                    return;
                }
            } else if (safeCursor === submitRowIdx && key.return) {
                if (canSubmit) model.submit();
                return;
            }
        },
        { isActive: focused && !editing },
    );

    useInput(
        (_input, key) => {
            if (key.escape) model.formEditing.set(false, undefined);
        },
        { isActive: focused && editing },
    );

    return (
        <Box flexDirection="column" flexShrink={0}>
            <Text bold>{(method.result === undefined ? "notify  " : "request ") + method.name}</Text>
            {method.summary ? <Text dimColor>{method.summary}</Text> : null}
            <Box marginTop={1} flexDirection="column" flexShrink={0}>
                {fields.length === 0 ? (
                    <Text dimColor>(no parameters)</Text>
                ) : (
                    <>
                        <ScrollIndicator direction="up" count={win.above} />
                        {fields.slice(win.start, win.end).map((f, i) => {
                            const idx = win.start + i;
                            return (
                                <FieldRow
                                    key={f.name}
                                    model={model}
                                    field={f}
                                    value={formValues[f.name]}
                                    focused={focused && safeCursor === idx}
                                    editing={editing && safeCursor === idx}
                                    error={errors.get(f.name)}
                                />
                            );
                        })}
                        <ScrollIndicator direction="down" count={win.below} />
                    </>
                )}
            </Box>
            <Box marginTop={1} flexShrink={0}>
                <Text color={canSubmit ? "green" : "gray"}>{submitLabel(focused && safeCursor === submitRowIdx, canSubmit)}</Text>
            </Box>
        </Box>
    );
};

function submitLabel(focused: boolean, canSubmit: boolean): string {
    const prefix = focused ? "\u203a " : "  ";
    const hint = canSubmit ? "" : " \u2014 fix errors first";
    return `${prefix}[Submit${hint}]`;
}

// -- shared column shell --

const Column: React.FC<{
    title: string;
    focused: boolean;
    children: React.ReactNode;
    width?: string | number;
    flexGrow?: number;
    height?: number;
}> = ({ title, focused, children, width, flexGrow, height }) => {
    return (
        <Box
            flexDirection="column"
            width={width}
            flexGrow={flexGrow}
            height={height}
            minWidth={0}
            overflow="hidden"
            borderStyle="single"
            borderColor={focused ? "cyan" : undefined}
            paddingX={1}
        >
            <Text bold>{title}</Text>
            {children}
        </Box>
    );
};

// -- result pane --

const ResultPane: React.FC<{ model: UiModel; height: number }> = ({ model, height }) => {
    const promise = useObservable(model.lastCall);
    const result = useObservable(promise ? promise.promiseResult : NO_RESULT);
    const chunks = useObservable(model.streamChunks);

    return (
        <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden" borderStyle="single" paddingX={1}>
            <Text bold>Result</Text>
            {chunks.length > 0 ? (
                <Box flexDirection="column">
                    {chunks.map((c, i) => (
                        <Text key={i} dimColor>{"\u2502 " + formatChunk(c)}</Text>
                    ))}
                </Box>
            ) : null}
            {!promise ? (
                <Text dimColor>(no calls yet)</Text>
            ) : !result ? (
                <Text dimColor>{chunks.length > 0 ? "Streaming…" : "Calling…"}</Text>
            ) : result.error ? (
                <Text color="red">Error: {formatError(result.error)}</Text>
            ) : (
                <Text>
                    {JSON.stringify(result.data?.result)}
                    {"  "}
                    <Text dimColor>{result.data?.latencyMs.toFixed(1)}ms</Text>
                </Text>
            )}
        </Box>
    );
};

const NO_RESULT = observableValue<undefined>("App.NO_RESULT", undefined);

function formatChunk(c: unknown): string {
    return typeof c === "string" ? c : JSON.stringify(c);
}

function formatError(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}
