import React from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { observableValue } from "@vscode/observables";
import { useObservable } from "./useObservable";
import { UiModel } from "./UiModel";
import { FieldRow } from "./FieldRow";
import { classifyField, cycleEnum, defaultValueFor } from "./schemaInspect";
import { useScroll } from "./scroll";
import type { MethodSchema } from "@hediet/linkrpc";

export interface AppProps {
    readonly model: UiModel;
}

// Fixed-height regions framing the scrollable columns. Heights are explicit
// (not flex) so the windowing math below knows exactly how many rows each list
// may render — Ink/Yoga gives no usable measurement before paint.
const IDENTITY_HEADER_H = 1;
const FOOTER_H = 1;
const RESULT_H = 8;
/** Column chrome that is not list rows: top border + bottom border + title. */
const COLUMN_CHROME_H = 3;

/** Re-render on terminal resize so the height math tracks the live row count. */
function useTerminalRows(): number {
    const { stdout } = useStdout();
    const [rows, setRows] = React.useState(stdout.rows ?? 30);
    React.useEffect(() => {
        const onResize = () => setRows(stdout.rows ?? 30);
        stdout.on("resize", onResize);
        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout]);
    return rows;
}

/**
 * Miller-column TUI: three columns left → right (services, methods, form)
 * plus a result pane at the bottom. ←/→ moves focus between columns, ↑/↓
 * moves the cursor inside the focused column. Each cursor move in columns
 * 0 / 1 immediately previews into the column to its right.
 */
export const App: React.FC<AppProps> = ({ model }) => {
    const focusedColumn = useObservable(model.focusedColumn);
    const editing = useObservable(model.formEditing);
    const discoveryWarnings = useObservable(model.discoveryWarnings);
    const termRows = useTerminalRows();
    const { exit } = useApp();

    useInput((input, key) => {
        // While editing a field, the text input owns input — don't intercept
        // ← / → for column nav (those move the text cursor).
        if (editing) return;
        if (input === "q") {
            exit();
            return;
        }
        if (key.leftArrow && focusedColumn > 0) {
            model.focusColumn((focusedColumn - 1) as 0 | 1 | 2);
            return;
        }
        if (key.rightArrow && focusedColumn < 2) {
            model.focusColumn((focusedColumn + 1) as 0 | 1 | 2);
            return;
        }
    });

    // Body (the three columns) gets whatever rows are left after the fixed
    // header, result pane and footer. `bodyHeight` is the column height; the
    // list area inside a column is that minus the column chrome.
    const headerHeight = IDENTITY_HEADER_H + discoveryWarnings.length;
    const bodyHeight = Math.max(COLUMN_CHROME_H + 1, termRows - headerHeight - RESULT_H - FOOTER_H);
    const listHeight = Math.max(1, bodyHeight - COLUMN_CHROME_H);

    return (
        <Box flexDirection="column" height={termRows}>
            <Header model={model} warnings={discoveryWarnings} />
            <Box height={bodyHeight}>
                <ServicesColumn model={model} focused={focusedColumn === 0} height={bodyHeight} listHeight={listHeight} />
                <MethodsColumn model={model} focused={focusedColumn === 1} height={bodyHeight} listHeight={listHeight} />
                <FormColumn model={model} focused={focusedColumn === 2} height={bodyHeight} listHeight={listHeight} />
            </Box>
            <ResultPane model={model} />
            <Box>
                <Text dimColor>
                    {"\u2190/\u2192: switch column | \u2191/\u2193: move | enter: edit / submit | esc: cancel edit | q: quit"}
                </Text>
            </Box>
        </Box>
    );
};

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
            <Box>
                <Text dimColor>identity: </Text>
                <Text>{identity ?? "(resolving…)"}</Text>
            </Box>
            {warnings.map((warning) => (
                <Text key={warning} color="yellow" wrap="truncate-end">! {warning}</Text>
            ))}
        </Box>
    );
};

// -- col 0: services --

const ServicesColumn: React.FC<{ model: UiModel; focused: boolean; height: number; listHeight: number }> = ({ model, focused, height, listHeight }) => {
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
        <Column title="Services" focused={focused} width="25%" height={height}>
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

const MethodsColumn: React.FC<{ model: UiModel; focused: boolean; height: number; listHeight: number }> = ({ model, focused, height, listHeight }) => {
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
        <Column title="Methods" focused={focused} width="25%" height={height}>
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

const MethodForm: React.FC<{ model: UiModel; method: MethodSchema; focused: boolean; listHeight: number }> = ({ model, method, focused, listHeight }) => {
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
            <Text bold>{(method.result === undefined ? "notify  " : "request ") + selection?.methodName}</Text>
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
    width?: string;
    flexGrow?: number;
    height?: number;
}> = ({ title, focused, children, width, flexGrow, height }) => {
    return (
        <Box
            flexDirection="column"
            width={width}
            flexGrow={flexGrow}
            height={height}
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

const ResultPane: React.FC<{ model: UiModel }> = ({ model }) => {
    const promise = useObservable(model.lastCall);
    const result = useObservable(promise ? promise.promiseResult : NO_RESULT);
    const chunks = useObservable(model.streamChunks);

    return (
        <Box flexDirection="column" height={RESULT_H} overflow="hidden" borderStyle="single" paddingX={1}>
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
