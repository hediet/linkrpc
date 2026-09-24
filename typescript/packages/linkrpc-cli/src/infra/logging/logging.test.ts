import { describe, expect, it, vi } from "vitest";
import { loggingInterface } from "@hediet/linkrpc-infra";
import type { CliChannel } from "@hediet/linkrpc-client";
import type { ViewOpenContext } from "../../views/types";
import { loggingView, formatLogFrame } from "./contribution";
import { frame, logOptions, readLogSnapshot, resolveLoggingTargets, watchLog } from "./model";
import { LoggingSession } from "./session";

const document = {
    schemaVersion: 1 as const, service: "example", startedAt: "2026-01-01T00:00:00Z", state: {},
    entries: [
        { timestamp: "2026-01-01T00:00:01Z", level: "debug" as const, message: "invisible" },
        { timestamp: "2026-01-01T00:00:02Z", level: "warn" as const, message: "\u001b[31m danger", attributes: { id: 7 } },
    ],
};
const listing = {
    serviceId: "", interfaceId: "linkrpc.logging", discoveredFrom: "", isDefault: true,
    schema: loggingInterface.toSchema(),
};
const context = { target: {
    id: "service::", kind: "service" as const, serviceId: "", discoveredFrom: "", interfaces: [listing],
}, interfaces: [listing], channel: {} as CliChannel } satisfies ViewOpenContext;

describe("logging view", () => {
    it("discovers by interface ID without tags and checks the actual contract", () => {
        expect(loggingView.conditions).toContainEqual({ kind: "service", implements: { interfaceId: "linkrpc.logging" } });
        expect(resolveLoggingTargets(context)[0]?.route("watchLog")).toBe("watchLog");
        const wireSchema = JSON.parse(JSON.stringify(listing.schema));
        expect(resolveLoggingTargets({ ...context, interfaces: [{ ...listing, schema: wireSchema }] })[0]?.route("watchLog"))
            .toBe("watchLog");
        const qualified = { ...listing, isDefault: false, serviceId: "nested" };
        expect(resolveLoggingTargets({ ...context, interfaces: [qualified] })[0]?.route("watchLog"))
            .toBe("nested::linkrpc.logging::watchLog");
        expect(() => resolveLoggingTargets({ ...context, interfaces: [{
            ...listing, schema: { ...listing.schema, methods: { ...listing.schema.methods, watchLog: { params: {} } } },
        }] })).toThrow(/canonical logging contract/);
    });

    it("reads a snapshot without calling setLogLevel; filters and escapes terminal text", async () => {
        const sendRequest = vi.fn(async () => ({ revision: 3, document }));
        const channel = { sendRequest } as unknown as CliChannel;
        const result = await readLogSnapshot(channel, resolveLoggingTargets(context)[0]!, logOptions({ level: "info", tail: 1 }));
        expect(sendRequest).toHaveBeenCalledWith("getLogSnapshot", {}, { interfaceHash: listing.schema.hash });
        expect(result.entries.map(entry => entry.level)).toEqual(["warn"]);
        expect(formatLogFrame(result, false)).toContain("\\u{001b}");
        expect(JSON.parse(formatLogFrame(result, true)).entries[0].message).toContain("\u001b");
        expect(() => logOptions({ tail: 0 })).toThrow(/tail/);
    });

    it("watches snapshots and patches, resyncs revision gaps and cancels on stop", async () => {
        let onMessage!: (payload: unknown) => void;
        let finish!: (value: unknown) => void;
        const result = new Promise<unknown>(resolve => { finish = resolve; });
        const cancel = vi.fn(() => finish({}));
        const dispose = vi.fn();
        const sendRequest = vi.fn(async () => ({ revision: 5, document }));
        const channel = {
            sendRequest, sendRequestWithStream: vi.fn((_method, _params, opts) => {
                onMessage = opts.onStreamMessage;
                return { result, cancel, dispose };
            }),
        } as unknown as CliChannel;
        let stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        const values: { revision: number; ready: unknown }[] = [];
        const watching = watchLog(channel, resolveLoggingTargets(context)[0]!, logOptions({}), value =>
            values.push({ revision: value.revision, ready: value.document.state.ready }), stopped);
        onMessage({ type: "snapshot", revision: 1, document });
        onMessage({ type: "patch", revision: 2, edits: [{ op: "set", path: "/state/ready", value: true }] });
        onMessage({ type: "patch", revision: 6, edits: [{ op: "set", path: "/state/ready", value: false }] });
        await vi.waitFor(() => expect(values).toEqual([
            { revision: 1, ready: undefined }, { revision: 2, ready: true },
            { revision: 5, ready: undefined }, { revision: 6, ready: false },
        ]));
        stop();
        await watching;
        expect(cancel).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(sendRequest).toHaveBeenCalledOnce();
    });

    it("bounds displayed entries by level and tail", () => {
        expect(frame(1, document, logOptions({ level: "warn", tail: 1 })).entries).toHaveLength(1);
        const nested = { ...document, entries: [{ ...document.entries[0]!, entries: [
            { timestamp: "2026-01-01T00:00:02Z", level: "error" as const, message: "nested failure" },
        ] }] };
        expect(frame(2, nested, logOptions({ level: "warn", tail: 1 })).entries.map(entry => entry.message))
            .toEqual(["nested failure"]);
    });

    it("rejects oversized snapshots and cancels a watch without an initial snapshot", async () => {
        const channel = { sendRequest: vi.fn(async () => ({ revision: 1, document: {
            ...document, entries: [{ ...document.entries[0], message: "x".repeat(1024) }],
        } })),
            sendRequestWithStream: vi.fn(() => ({
                result: new Promise(() => {}), cancel: vi.fn(), dispose: vi.fn(),
            })),
        } as unknown as CliChannel;
        const target = resolveLoggingTargets(context)[0]!;
        await expect(readLogSnapshot(channel, target, logOptions({ maxBytes: 1024 }))).rejects.toThrow(/max-bytes/);
        await expect(watchLog(channel, target, logOptions({ timeoutMs: 10 }), () => {}, new Promise(() => {})))
            .rejects.toThrow(/no snapshot/);
        expect(channel.sendRequestWithStream).toHaveBeenCalledOnce();
    });

    it("TUI commands pause, resume, clear locally, and drain its watch on disposal", async () => {
        let onMessage!: (payload: unknown) => void;
        let resolve!: () => void;
        const result = new Promise<unknown>(done => { resolve = () => done({}); });
        const cancel = vi.fn(() => resolve());
        const channel = { sendRequest: vi.fn(), sendRequestWithStream: vi.fn((_method, _params, opts) => {
            onMessage = opts.onStreamMessage;
            return { result, cancel, dispose: vi.fn() };
        }) } as unknown as CliChannel;
        const session = new LoggingSession({ ...context, channel }, resolveLoggingTargets(context)[0]!, logOptions({}));
        const command = (id: string) => session.commands.get().find(item => item.id === `logging.${id}`)!.execute();
        onMessage({ type: "snapshot", revision: 1, document });
        await vi.waitFor(() => expect(session.state.get().frame?.revision).toBe(1));
        command("pause");
        onMessage({ type: "snapshot", revision: 2, document });
        await vi.waitFor(() => expect(session.state.get().paused).toBe(true));
        expect(session.state.get().frame?.revision).toBe(1);
        command("pause");
        await vi.waitFor(() => expect(session.state.get().frame?.revision).toBe(2));
        command("clear");
        expect(session.displayedEntries).toEqual([]);
        command("filter");
        expect(session.state.get().level).toBe("debug");
        expect(channel.sendRequestWithStream).toHaveBeenCalledOnce();
        expect(channel.sendRequest).not.toHaveBeenCalled();
        onMessage({ type: "patch", revision: 3, edits: [
            { op: "set", path: "/entries", value: [
                document.entries[1], { timestamp: "2026-01-01T00:00:04Z", level: "error", message: "rolling arrival" },
            ] },
        ] });
        await vi.waitFor(() => expect(session.state.get().frame?.revision).toBe(3));
        expect(session.displayedEntries.map(entry => entry.message)).toEqual(["rolling arrival"]);
        onMessage({ type: "patch", revision: 4, edits: [
            { op: "set", path: "/state/ready", value: true },
        ] });
        await vi.waitFor(() => expect(session.state.get().frame?.revision).toBe(4));
        expect(session.displayedEntries.map(entry => entry.message)).toEqual(["rolling arrival"]);
        command("clear");
        expect(session.displayedEntries).toEqual([]);
        onMessage({ type: "patch", revision: 5, edits: [
            { op: "set", path: "/entries", value: [{
                ...document.entries[1], entries: [{
                    timestamp: "2026-01-01T00:00:05Z", level: "error", message: "nested new",
                }],
            }] },
        ] });
        await vi.waitFor(() => expect(session.state.get().frame?.revision).toBe(5));
        expect(session.displayedEntries.map(entry => entry.message)).toContain("nested new");
        command("clear");
        onMessage({ type: "snapshot", revision: 0, document });
        await vi.waitFor(() => expect(session.state.get().frame?.revision).toBe(0));
        expect(session.displayedEntries).toHaveLength(2);
        session.dispose();
        await session.disposeAsync();
        expect(cancel).toHaveBeenCalledOnce();
    });
});
