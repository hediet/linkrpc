import { createHash } from "crypto";
import {
    ContentBlockSchema,
    type CallToolResult,
    type ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";

export const MCP_PRESENTATION_TAG = "__hubrpcMcpPresentationV1";

export type ResultPresentationMode = "auto" | "raw";

interface PresentationState {
    readonly content: ContentBlock[];
    isError?: boolean;
    meta?: Record<string, unknown>;
}

interface AutomaticContent {
    readonly block: ContentBlock;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

interface PresentationTag {
    readonly kind: "raw" | "result" | "content";
    readonly value?: unknown;
    readonly content?: unknown;
    readonly structuredContent?: unknown;
    readonly isError?: unknown;
    readonly _meta?: unknown;
}

/**
 * Convert a JSON tool-result envelope into MCP-native content while preserving a
 * JSON text fallback for clients that only consume text.
 */
export function presentToolResult(
    envelope: Readonly<Record<string, unknown>>,
    mode: ResultPresentationMode = "auto",
): CallToolResult {
    if (mode === "raw") {
        const rawEnvelope = stripPresentationTags(envelope);
        const resultOptions = findExplicitResultOptions(envelope);
        return {
            content: [{ type: "text", text: JSON.stringify(rawEnvelope, null, 2) }],
            structuredContent: rawEnvelope as Record<string, unknown>,
            ...resultOptions,
        };
    }

    const state: PresentationState = { content: [] };
    const structuredContent = presentValue(envelope, "$", state) as Record<string, unknown>;
    return {
        content: [
            { type: "text", text: JSON.stringify(structuredContent, null, 2) },
            ...state.content,
        ],
        structuredContent,
        ...(state.isError !== undefined ? { isError: state.isError } : {}),
        ...(state.meta ? { _meta: state.meta } : {}),
    };
}

/** Remove presentation-only wrappers before persisting a script result. */
export function scriptResultValue(value: unknown): unknown {
    return stripPresentationTags(value);
}

function presentValue(value: unknown, path: string, state: PresentationState): unknown {
    const tag = getPresentationTag(value);
    if (tag?.kind === "raw") {
        return stripPresentationTags(tag.value);
    }
    if (tag?.kind === "result") {
        if (tag.isError !== undefined) {
            if (typeof tag.isError !== "boolean") {
                throw new Error(`Invalid MCP result isError at ${path}: expected boolean`);
            }
            state.isError = tag.isError;
        }
        if (tag._meta !== undefined) {
            if (!isRecord(tag._meta)) {
                throw new Error(`Invalid MCP result _meta at ${path}: expected object`);
            }
            state.meta = tag._meta;
        }
        const selected = Object.hasOwn(tag, "structuredContent")
            ? tag.structuredContent
            : Object.hasOwn(tag, "value")
                ? tag.value
                : null;
        const presented = presentValue(selected, path, state);
        const content = Array.isArray(tag.content) ? tag.content : [];
        for (let i = 0; i < content.length; i++) {
            addExplicitContent(content[i], `${path}.content[${i}]`, state);
        }
        return presented;
    }
    if (tag?.kind === "content") {
        const block = parseExplicitContent(tag.content, path);
        state.content.push(block);
        return describeContent(block, path);
    }

    const explicitContent = ContentBlockSchema.safeParse(value);
    if (explicitContent.success) {
        state.content.push(explicitContent.data);
        return describeContentWithMetadata(
            explicitContent.data,
            contentBlockMetadata(value as Record<string, unknown>, explicitContent.data),
            path,
            state,
        );
    }

    const automaticContent = detectAutomaticContent(value);
    if (automaticContent) {
        state.content.push(automaticContent.block);
        return describeContentWithMetadata(
            automaticContent.block,
            automaticContent.metadata,
            path,
            state,
        );
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => presentValue(item, `${path}[${index}]`, state));
    }
    if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = presentValue(item, `${path}.${key}`, state);
        }
        return result;
    }
    return value;
}

function addExplicitContent(value: unknown, path: string, state: PresentationState): void {
    const tag = getPresentationTag(value);
    state.content.push(parseExplicitContent(tag?.kind === "content" ? tag.content : value, path));
}

function parseExplicitContent(value: unknown, path: string): ContentBlock {
    const parsed = ContentBlockSchema.safeParse(value);
    if (parsed.success) {
        return parsed.data;
    }
    throw new Error(`Invalid MCP content block at ${path}: ${parsed.error.message}`);
}

function detectAutomaticContent(value: unknown): AutomaticContent | undefined {
    if (typeof value === "string") {
        const dataUrl = parseDataUrl(value);
        if (dataUrl) {
            return { block: blockForBinary(dataUrl.data, dataUrl.mimeType) };
        }
        const base64 = normalizeBase64(value);
        if (!base64) {
            return undefined;
        }
        const mimeType = sniffMimeType(base64);
        return mimeType ? { block: blockForBinary(base64, mimeType) } : undefined;
    }

    if (!isRecord(value) || typeof value.mimeType !== "string") {
        return undefined;
    }

    if (typeof value.text === "string") {
        return {
            block: {
                type: "resource",
                resource: {
                    uri: typeof value.uri === "string"
                        ? value.uri
                        : contentUrn(value.mimeType, value.text),
                    mimeType: value.mimeType,
                    text: value.text,
                },
            },
            metadata: contentMetadata(value),
        };
    }

    const encoded = [value.data, value.base64, value.blob]
        .find((candidate): candidate is string => typeof candidate === "string");
    if (!encoded) {
        return undefined;
    }
    const dataUrl = parseDataUrl(encoded);
    const data = dataUrl?.data ?? normalizeBase64(encoded);
    if (!data) {
        return undefined;
    }
    const block = blockForBinary(
        data,
        dataUrl?.mimeType ?? value.mimeType,
        typeof value.uri === "string" ? value.uri : undefined,
    );
    return { block, metadata: contentMetadata(value) };
}

function blockForBinary(data: string, mimeType: string, uri?: string): ContentBlock {
    if (mimeType.startsWith("image/")) {
        return { type: "image", data, mimeType };
    }
    if (mimeType.startsWith("audio/")) {
        return { type: "audio", data, mimeType };
    }
    return {
        type: "resource",
        resource: {
            uri: uri ?? contentUrn(mimeType, data),
            mimeType,
            blob: data,
        },
    };
}

function describeContent(content: ContentBlock, path: string): unknown {
    switch (content.type) {
        case "text":
            return content.text;
        case "image":
        case "audio":
            return {
                $content: {
                    type: content.type,
                    mimeType: content.mimeType,
                    bytes: base64ByteLength(content.data),
                    path,
                },
            };
        case "resource_link":
            return {
                $content: {
                    type: content.type,
                    uri: content.uri,
                    name: content.name,
                    ...(content.mimeType ? { mimeType: content.mimeType } : {}),
                    ...(content.size !== undefined ? { size: content.size } : {}),
                    path,
                },
            };
        case "resource": {
            const resource = content.resource;
            return {
                $content: {
                    type: content.type,
                    uri: resource.uri,
                    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
                    ...("blob" in resource
                        ? { bytes: base64ByteLength(resource.blob) }
                        : { characters: resource.text.length }),
                    path,
                },
            };
        }
    }
}

function describeContentWithMetadata(
    content: ContentBlock,
    metadata: Readonly<Record<string, unknown>> | undefined,
    path: string,
    state: PresentationState,
): unknown {
    const description = describeContent(content, path);
    if (!metadata || Object.keys(metadata).length === 0) {
        return description;
    }
    const presentedMetadata = presentValue(metadata, path, state) as Record<string, unknown>;
    if (isRecord(description)) {
        return { ...presentedMetadata, ...description };
    }
    return {
        ...presentedMetadata,
        $content: {
            type: content.type,
            characters: typeof description === "string" ? description.length : undefined,
            path,
        },
    };
}

function stripPresentationTags(value: unknown): unknown {
    const tag = getPresentationTag(value);
    if (tag?.kind === "raw") {
        return stripPresentationTags(tag.value);
    }
    if (tag?.kind === "result") {
        if (Object.hasOwn(tag, "value")) {
            return stripPresentationTags(tag.value);
        }
        if (Object.hasOwn(tag, "structuredContent")) {
            return stripPresentationTags(tag.structuredContent);
        }
        return null;
    }
    if (tag?.kind === "content") {
        return stripPresentationTags(tag.content);
    }
    if (Array.isArray(value)) {
        return value.map(stripPresentationTags);
    }
    if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = stripPresentationTags(item);
        }
        return result;
    }
    return value;
}

function findExplicitResultOptions(value: unknown): Pick<CallToolResult, "isError" | "_meta"> {
    const tag = getPresentationTag(value);
    if (tag?.kind === "raw") {
        return {};
    }
    if (tag?.kind === "result") {
        return {
            ...(typeof tag.isError === "boolean" ? { isError: tag.isError } : {}),
            ...(isRecord(tag._meta) ? { _meta: tag._meta } : {}),
        };
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const options = findExplicitResultOptions(item);
            if (options.isError !== undefined || options._meta !== undefined) {
                return options;
            }
        }
    } else if (isRecord(value)) {
        for (const item of Object.values(value)) {
            const options = findExplicitResultOptions(item);
            if (options.isError !== undefined || options._meta !== undefined) {
                return options;
            }
        }
    }
    return {};
}

function getPresentationTag(value: unknown): PresentationTag | undefined {
    if (!isRecord(value) || Object.keys(value).length !== 1) {
        return undefined;
    }
    const candidate = value[MCP_PRESENTATION_TAG];
    if (
        !isRecord(candidate)
        || (candidate.kind !== "raw" && candidate.kind !== "result" && candidate.kind !== "content")
    ) {
        return undefined;
    }
    return candidate as unknown as PresentationTag;
}

function parseDataUrl(value: string): { readonly data: string; readonly mimeType: string } | undefined {
    if (!value.startsWith("data:")) {
        return undefined;
    }
    const comma = value.indexOf(",");
    if (comma < 5) {
        return undefined;
    }
    const metadata = value.slice(5, comma);
    const parts = metadata.split(";");
    const mimeType = parts[0] || "text/plain";
    const payload = value.slice(comma + 1);
    if (parts.includes("base64")) {
        const data = normalizeBase64(payload);
        return data ? { data, mimeType } : undefined;
    }
    try {
        return {
            data: Buffer.from(decodeURIComponent(payload), "utf8").toString("base64"),
            mimeType,
        };
    } catch {
        return undefined;
    }
}

function normalizeBase64(value: string): string | undefined {
    const compact = value.replace(/\s/g, "");
    if (compact.length < 8 || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
        return undefined;
    }
    const withoutPadding = compact.replace(/=+$/, "");
    const padding = (4 - (withoutPadding.length % 4)) % 4;
    return withoutPadding + "=".repeat(padding);
}

function sniffMimeType(base64: string): string | undefined {
    const bytes = Buffer.from(base64.slice(0, 256), "base64");
    const ascii = bytes.toString("ascii");
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
    if (ascii.startsWith("BM")) return "image/bmp";
    if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
    if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
    if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString("utf8"))) return "image/svg+xml";
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return "audio/wav";
    if (ascii.startsWith("ID3") || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2])) return "audio/mpeg";
    if (ascii.startsWith("OggS")) return "audio/ogg";
    if (ascii.startsWith("fLaC")) return "audio/flac";
    if (startsWith(bytes, [0xff, 0xf1]) || startsWith(bytes, [0xff, 0xf9])) return "audio/aac";
    if (ascii.startsWith("MThd")) return "audio/midi";
    if (ascii.startsWith("%PDF-")) return "application/pdf";
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
    if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
    return undefined;
}

function startsWith(value: Buffer, prefix: readonly number[]): boolean {
    return prefix.every((byte, index) => value[index] === byte);
}

function base64ByteLength(value: string): number {
    const normalized = normalizeBase64(value);
    if (!normalized) {
        return 0;
    }
    const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
    return (normalized.length / 4) * 3 - padding;
}

function contentUrn(mimeType: string, value: string): string {
    const digest = createHash("sha256").update(mimeType).update("\0").update(value).digest("base64url");
    return `urn:hubrpc-mcp:content:${digest}`;
}

function contentMetadata(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!["data", "base64", "blob", "text", "mimeType", "uri"].includes(key)) {
            metadata[key] = item;
        }
    }
    return metadata;
}

function contentBlockMetadata(
    value: Readonly<Record<string, unknown>>,
    content: ContentBlock,
): Record<string, unknown> {
    const standardKeys = content.type === "text"
        ? ["type", "text", "annotations", "_meta"]
        : content.type === "image" || content.type === "audio"
            ? ["type", "data", "mimeType", "annotations", "_meta"]
            : content.type === "resource"
                ? ["type", "resource", "annotations", "_meta"]
                : [
                    "type",
                    "uri",
                    "name",
                    "title",
                    "description",
                    "mimeType",
                    "size",
                    "annotations",
                    "_meta",
                    "icons",
                ];
    const metadata: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!standardKeys.includes(key)) {
            metadata[key] = item;
        }
    }
    return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
