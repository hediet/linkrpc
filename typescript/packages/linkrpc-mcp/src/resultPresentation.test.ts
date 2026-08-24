import { describe, expect, it } from "vitest";
import {
    MCP_PRESENTATION_TAG,
    presentToolResult,
    scriptResultValue,
} from "./resultPresentation";

const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]).toString("base64");

describe("presentToolResult", () => {
    it("keeps JSON results as text and structured content", () => {
        const envelope = { status: "completed", result: { answer: 42 } };

        const result = presentToolResult(envelope);

        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(envelope);
        expect(result.structuredContent).toEqual(envelope);
        expect(result.content).toHaveLength(1);
    });

    it("recognizes nested base64 images without mutating the source value", () => {
        const source = {
            screenshot: {
                data: png,
                mimeType: "image/png",
                label: "original",
            },
        };

        const result = presentToolResult({ status: "completed", result: source });

        expect(result.content[1]).toEqual({
            type: "image",
            data: png,
            mimeType: "image/png",
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain(png);
        expect(result.structuredContent).toMatchObject({
            result: {
                screenshot: {
                    $content: {
                        type: "image",
                        mimeType: "image/png",
                        bytes: 16,
                    },
                },
            },
        });
        expect(source.screenshot).toEqual({
            data: png,
            mimeType: "image/png",
            label: "original",
        });
    });

    it("recognizes bare media base64 by signature and data URLs by declared MIME type", () => {
        const wav = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE", "binary").toString("base64");

        const result = presentToolResult({
            image: png,
            audio: `data:audio/wav;base64,${wav}`,
        });

        expect(result.content.slice(1)).toEqual([
            { type: "image", data: png, mimeType: "image/png" },
            { type: "audio", data: wav, mimeType: "audio/wav" },
        ]);
    });

    it("embeds declared non-media binary and text values as resources", () => {
        const pdf = Buffer.from("%PDF-1.7\n").toString("base64");

        const result = presentToolResult({
            document: { blob: pdf, mimeType: "application/pdf" },
            note: { text: "hello", mimeType: "text/plain", uri: "memory://note" },
        });

        expect(result.content[1]).toMatchObject({
            type: "resource",
            resource: { mimeType: "application/pdf", blob: pdf },
        });
        expect(result.content[2]).toEqual({
            type: "resource",
            resource: { uri: "memory://note", mimeType: "text/plain", text: "hello" },
        });
    });

    it("passes every explicit MCP content-block kind through with a JSON fallback", () => {
        const blocks = [
            { type: "text", text: "hello" },
            { type: "image", data: png, mimeType: "image/png" },
            { type: "audio", data: "UklGRgAAAABXQVZF", mimeType: "audio/wav" },
            {
                type: "resource",
                resource: { uri: "memory://note", mimeType: "text/plain", text: "note" },
            },
            {
                type: "resource_link",
                uri: "file:///tmp/report.pdf",
                name: "report.pdf",
                mimeType: "application/pdf",
            },
        ];
        const wrapped = {
            [MCP_PRESENTATION_TAG]: {
                kind: "result",
                value: { ok: true },
                content: blocks,
                isError: true,
                _meta: { source: "test" },
            },
        };

        const result = presentToolResult({ status: "completed", result: wrapped });

        expect(result.content.slice(1)).toEqual(blocks);
        expect(result.structuredContent).toEqual({
            status: "completed",
            result: { ok: true },
        });
        expect(result.isError).toBe(true);
        expect(result._meta).toEqual({ source: "test" });
        expect(scriptResultValue(wrapped)).toEqual({ ok: true });
    });

    it("preserves unrelated fields on values that resemble MCP content blocks", () => {
        const result = presentToolResult({
            result: {
                type: "text",
                text: "Issue was closed",
                requestId: "abc-123",
                actor: "octocat",
            },
        });

        expect(result.content[1]).toEqual({ type: "text", text: "Issue was closed" });
        expect(result.structuredContent).toEqual({
            result: {
                requestId: "abc-123",
                actor: "octocat",
                $content: {
                    type: "text",
                    characters: 16,
                    path: "$.result",
                },
            },
        });
    });

    it("does not consume presentation-like objects that have sibling fields", () => {
        const value = {
            [MCP_PRESENTATION_TAG]: { kind: "raw", value: "hidden" },
            source: "hub",
        };

        const result = presentToolResult({ result: value });

        expect(result.structuredContent).toEqual({ result: value });
    });

    it("supports selective and whole-result raw opt-out", () => {
        const wrapped = {
            [MCP_PRESENTATION_TAG]: {
                kind: "raw",
                value: { data: png, mimeType: "image/png" },
            },
        };

        const selective = presentToolResult({ result: wrapped });
        const wholeResult = presentToolResult(
            { result: { data: png, mimeType: "image/png" } },
            "raw",
        );

        expect(selective.content).toHaveLength(1);
        expect(selective.structuredContent).toEqual({
            result: { data: png, mimeType: "image/png" },
        });
        expect(wholeResult.content).toHaveLength(1);
        expect(wholeResult.structuredContent).toEqual({
            result: { data: png, mimeType: "image/png" },
        });
        expect(scriptResultValue(wrapped)).toEqual({ data: png, mimeType: "image/png" });
    });

    it("rejects malformed explicit content instead of silently dropping it", () => {
        const wrapped = {
            [MCP_PRESENTATION_TAG]: {
                kind: "result",
                value: null,
                content: [{ type: "image", data: png }],
            },
        };

        expect(() => presentToolResult({ result: wrapped })).toThrow(
            /Invalid MCP content block/,
        );
    });
});
