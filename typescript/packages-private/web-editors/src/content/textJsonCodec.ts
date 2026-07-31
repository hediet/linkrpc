import type { ContentType } from "../protocol";
import type { JsonValue } from "./contentModel";

/**
 * Options for encoding text as JSON content.
 *
 * `indentation` is forwarded to `JSON.stringify`. The encoded value may
 * contain a `$web-editor.format-json` hint that overrides this.
 */
export interface JsonFormatOptions {
    indentation?: number | "\t" | undefined;
}

/**
 * Encode a host-side text document into the value the editor sees.
 *
 *   - `text`: identity.
 *   - `json`: `JSON.parse(text)`. Throws on parse error.
 */
export function encodeForEditor(text: string, contentType: ContentType): JsonValue {
    if (contentType === "text") return text;
    if (text === "") return null;
    return JSON.parse(text);
}

/**
 * Decode the editor-side value back into the text the host stores.
 *
 *   - `text`: must be a string; returned as-is.
 *   - `json`: stringified. Honors `$web-editor.format-json` on the value
 *     (number | "\t") and otherwise the passed-in options.
 */
export function decodeFromEditor(
    value: JsonValue,
    contentType: ContentType,
    options: JsonFormatOptions = {},
): string {
    if (contentType === "text") {
        if (typeof value !== "string") {
            throw new Error(`decodeFromEditor: expected string for text content, got ${typeof value}`);
        }
        return value;
    }

    let indentation = options.indentation;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const hint = (value as Record<string, unknown>)["$web-editor.format-json"];
        if (typeof hint === "number" || hint === "\t") {
            indentation = hint;
        } else if (hint !== undefined) {
            indentation = 4;
        }
    }
    return JSON.stringify(value, undefined, indentation);
}
