import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { FieldDesc, UiModel } from "./UiModel";
import {
    classifyField,
    describeSchema,
    parseTypedValue,
    type FieldClassification,
} from "./schemaInspect";

export interface FieldRowProps {
    readonly model: UiModel;
    readonly field: FieldDesc;
    readonly value: unknown;
    readonly focused: boolean;
    readonly editing: boolean;
    readonly error: string | undefined;
}

const NAME_W = 12;
const VALUE_W = 24;

/**
 * One row of the method form. To keep ink/yoga happy across resizes, the
 * non-editing path renders the whole row as a single `<Text>` with nested
 * colored spans, instead of multiple Boxes that try to share the column's
 * width. Boxes-around-Text in row direction tend to collapse to the
 * narrowest measurement on the first paint — single-Text rows lay out
 * predictably.
 *
 * The editing path swaps the value column for a `TextInput`; the surrounding
 * row stays a Box because TextInput is a component, not a string.
 */
export const FieldRow: React.FC<FieldRowProps> = ({ model, field, value, focused, editing, error }) => {
    const cls = classifyField(field.schema);
    const cursor = focused ? "› " : "  ";
    const namePadded = pad(field.name, NAME_W);
    const optionalMark = field.required ? "" : "?";
    const typeLabel = describeSchema(field.schema);

    return (
        <Box flexDirection="column" flexShrink={0}>
            {editing ? (
                <Box flexDirection="row" flexShrink={0}>
                    <Text color={focused ? "cyan" : undefined}>{cursor}</Text>
                    <Text bold>{namePadded}</Text>
                    <Text dimColor>{optionalMark === "" ? "" : optionalMark + " "}</Text>
                    <Box flexGrow={1} flexShrink={1}>
                        <TextEditor model={model} field={field} value={value} cls={cls} />
                    </Box>
                    <Text dimColor>  {typeLabel}</Text>
                </Box>
            ) : (
                <Text>
                    <Text color={focused ? "cyan" : undefined}>{cursor}</Text>
                    <Text bold>{namePadded}</Text>
                    <Text dimColor>{optionalMark + "  "}</Text>
                    <Text color="yellow">{pad(formatValue(value, cls), VALUE_W)}</Text>
                    <Text dimColor>  {typeLabel}</Text>
                </Text>
            )}
            {error ? (
                <Box marginLeft={NAME_W + 2} flexShrink={0}>
                    <Text color="red">! {error}</Text>
                </Box>
            ) : null}
        </Box>
    );
};

const TextEditor: React.FC<{
    model: UiModel;
    field: FieldDesc;
    value: unknown;
    cls: FieldClassification;
}> = ({ model, field, value, cls }) => {
    const initial = textForEditing(value, cls.kind);
    const [draft, setDraft] = React.useState(initial);
    React.useEffect(() => { setDraft(initial); }, [initial]);

    return (
        <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={(submitted) => {
                const parsed = parseTypedValue(submitted, cls.kind);
                if (parsed.ok) {
                    model.setField(field.name, parsed.value);
                    model.formEditing.set(false, undefined);
                }
                // Invalid input: stay in edit mode. The error row already
                // shows the schema-derived complaint via `formErrors`.
            }}
            focus={true}
        />
    );
};

function textForEditing(value: unknown, kind: FieldClassification["kind"]): string {
    if (value === undefined) return "";
    if (kind === "string") return typeof value === "string" ? value : JSON.stringify(value);
    if (kind === "json") return JSON.stringify(value);
    return String(value);
}

function formatValue(value: unknown, cls: FieldClassification): string {
    if (value === undefined) return "(unset)";
    switch (cls.kind) {
        case "boolean": return value ? "[x]" : "[ ]";
        case "enum": return `< ${stringifyEnum(value)} >`;
        case "string": return typeof value === "string" ? value : JSON.stringify(value);
        case "json": {
            const text = JSON.stringify(value);
            return text.length > 40 ? text.slice(0, 37) + "..." : text;
        }
        default: return JSON.stringify(value);
    }
}

function stringifyEnum(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
}

/** Pad to `width` with spaces, or truncate with `…` if too long. */
function pad(text: string, width: number): string {
    if (text.length === width) return text;
    if (text.length < width) return text + " ".repeat(width - text.length);
    return text.slice(0, width - 1) + "…";
}
