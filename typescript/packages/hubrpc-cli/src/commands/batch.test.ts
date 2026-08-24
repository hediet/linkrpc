import { describe, expect, it, vi } from "vitest";
import { parseBatchArgs, executeBatch, type BatchExecutor } from "./batch";

describe("parseBatchArgs", () => {
    it("scopes params and validation flags to each operation", () => {
        expect(parseBatchArgs([
            "--call", "example.one::first",
            "--params", '{"base":true}',
            "--param", "value=1",
            "--no-validate",
            "--notify", "example.two::second",
            "--param", "value=2",
            "--call", "example.three::third",
        ])).toEqual({
            continueOnError: false,
            operations: [
                {
                    kind: "call",
                    methodRef: "example.one::first",
                    paramsArg: '{"base":true}',
                    paramOverrides: ["value=1"],
                    noValidate: true,
                },
                {
                    kind: "notify",
                    methodRef: "example.two::second",
                    paramOverrides: ["value=2"],
                    noValidate: false,
                },
                {
                    kind: "call",
                    methodRef: "example.three::third",
                    paramOverrides: [],
                    noValidate: false,
                },
            ],
        });
    });

    it("accepts the batch-level continue-on-error flag", () => {
        expect(parseBatchArgs([
            "--continue-on-error",
            "--call", "example.one::first",
        ]).continueOnError).toBe(true);
    });

    it.each([
        { args: [], message: "at least one --call or --notify" },
        { args: ["--params", "{}"], message: "--params must follow" },
        { args: ["--call"], message: "--call requires a method" },
        { args: ["--call", "one", "--params"], message: "--params requires a value" },
        { args: ["--call", "one", "--params", "{}", "--params", "{}"], message: "only once" },
        { args: ["--call", "one", "--wat"], message: "Unknown batch option" },
    ])("rejects malformed arguments: $message", ({ args, message }) => {
        expect(() => parseBatchArgs(args)).toThrow(message);
    });
});

describe("executeBatch", () => {
    it("executes calls and notifications sequentially", async () => {
        const order: string[] = [];
        const executor: BatchExecutor = {
            call: vi.fn(async (options) => {
                order.push(`start:${options.methodRef}`);
                await Promise.resolve();
                order.push(`end:${options.methodRef}`);
                return JSON.stringify({ method: options.methodRef });
            }),
            notify: vi.fn(async (options) => {
                order.push(`notify:${options.methodRef}`);
                return "(notification sent)";
            }),
        };

        const results = await executeBatch(parseBatchArgs([
            "--call", "example::one",
            "--notify", "example::two",
            "--call", "example::three",
        ]), executor);

        expect(order).toEqual([
            "start:example::one",
            "end:example::one",
            "notify:example::two",
            "start:example::three",
            "end:example::three",
        ]);
        expect(results).toEqual([
            {
                index: 0,
                kind: "call",
                method: "example::one",
                ok: true,
                result: { method: "example::one" },
            },
            {
                index: 1,
                kind: "notify",
                method: "example::two",
                ok: true,
            },
            {
                index: 2,
                kind: "call",
                method: "example::three",
                ok: true,
                result: { method: "example::three" },
            },
        ]);
    });

    it("fails fast by default", async () => {
        const executor: BatchExecutor = {
            call: vi.fn()
                .mockRejectedValueOnce(new Error("first failed"))
                .mockResolvedValueOnce("{}"),
            notify: vi.fn(),
        };

        await expect(executeBatch(parseBatchArgs([
            "--call", "example::one",
            "--call", "example::two",
        ]), executor)).rejects.toThrow("first failed");
        expect(executor.call).toHaveBeenCalledTimes(1);
    });

    it("records errors and continues when requested", async () => {
        const executor: BatchExecutor = {
            call: vi.fn()
                .mockRejectedValueOnce(new Error("first failed"))
                .mockResolvedValueOnce('{"ok":true}'),
            notify: vi.fn(),
        };

        const results = await executeBatch(parseBatchArgs([
            "--continue-on-error",
            "--call", "example::one",
            "--call", "example::two",
        ]), executor);

        expect(results).toEqual([
            {
                index: 0,
                kind: "call",
                method: "example::one",
                ok: false,
                error: "first failed",
            },
            {
                index: 1,
                kind: "call",
                method: "example::two",
                ok: true,
                result: { ok: true },
            },
        ]);
    });

    it("labels stream chunks with their operation", async () => {
        const chunks: unknown[] = [];
        const executor: BatchExecutor = {
            call: vi.fn(async (options) => {
                options.onStreamChunk?.({ progress: 1 });
                return "{}";
            }),
            notify: vi.fn(),
        };

        await executeBatch(parseBatchArgs([
            "--call", "example::one",
        ]), executor, {
            onStreamChunk: (event) => chunks.push(event),
        });

        expect(chunks).toEqual([{
            index: 0,
            method: "example::one",
            payload: { progress: 1 },
        }]);
    });
});
