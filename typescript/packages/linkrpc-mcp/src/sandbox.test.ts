import { describe, expect, it } from "vitest";
import { startSandbox, type SandboxHostApi } from "./sandbox";
import { MCP_PRESENTATION_TAG } from "./resultPresentation";

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitFor(cond: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!cond() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
    }
}

/** Host whose `call` stays pending until the test resolves the captured deferred. */
class FakeHost implements SandboxHostApi {
    public readonly calls: {
        method: string;
        d: Deferred<string>;
        stream: (payloadJson: string) => void;
        signal: AbortSignal;
    }[] = [];
    call(
        method: string,
        _paramsJson: string,
        _optsJson: string,
        onStreamMessage: (payloadJson: string) => void,
        signal: AbortSignal,
    ): Promise<string> {
        const d = deferred<string>();
        this.calls.push({ method, d, stream: onStreamMessage, signal });
        return d.promise;
    }
    async notify(): Promise<string> {
        return "";
    }
    async explore(): Promise<string> {
        return JSON.stringify({});
    }
    async requestAccess(): Promise<string> {
        return JSON.stringify({ status: "granted", capabilities: [], addedDurable: 0 });
    }
    async grants(): Promise<string> {
        return JSON.stringify({ count: 0, grants: [] });
    }
}

describe("startSandbox parking", () => {
    it("completes within the foreground budget", async () => {
        const host = new FakeHost();
        const p = startSandbox(
            `({ con }) => con.call("github", "repos", "list", {})`,
            host,
            undefined,
            { foregroundMs: 1000, maxLifetimeMs: 5000 },
        );
        // Resolve the in-flight call well before the foreground budget elapses.
        await waitFor(() => host.calls.length === 1);
        host.calls[0].d.resolve(JSON.stringify(["a", "b"]));

        const outcome = await p;
        expect(outcome).toMatchObject({ status: "completed", result: ["a", "b"] });
    });

    it("preserves generic host rejection properties in the guest", async () => {
        const host = new FakeHost();
        const outcomePromise = startSandbox(
            `async ({ con }) => {
                try {
                    await con.call("home-assistant", "listEntities", {});
                    return { caught: false };
                } catch (error) {
                    return {
                        caught: true,
                        isError: error instanceof Error,
                        keys: Reflect.ownKeys(error),
                        message: error.message,
                        code: error.code,
                        data: error.data,
                        hidden: error.hidden,
                        self: error.self,
                    };
                }
            }`,
            host,
            undefined,
            { foregroundMs: 1000, maxLifetimeMs: 5000 },
        );
        await waitFor(() => host.calls.length === 1);
        const rejection = new Error("Invalid params");
        Object.defineProperties(rejection, {
            code: { value: -32602 },
            data: { value: { issues: [{ path: ["options"], message: "Expected object" }] } },
            hidden: { value: "diagnostic" },
            self: { value: rejection },
        });
        host.calls[0].d.reject(rejection);

        const outcome = await outcomePromise;
        expect(outcome).toMatchObject({
            status: "completed",
            result: {
                caught: true,
                isError: true,
                keys: expect.arrayContaining([
                    "message",
                    "stack",
                    "code",
                    "data",
                    "hidden",
                    "self",
                ]),
                message: "Invalid params",
                code: -32602,
                data: { issues: [{ path: ["options"], message: "Expected object" }] },
                hidden: "diagnostic",
                self: "[Circular]",
            },
        });
    });

    it("returns inline when there is no I/O", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(`() => 1 + 2`, host, undefined, {
            foregroundMs: 1000,
            maxLifetimeMs: 5000,
        });
        expect(outcome).toMatchObject({ status: "completed", result: 3 });
    });

    it("exposes MCP presentation helpers without changing ordinary values", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `({ mcp }) => mcp.result({
                value: { original: "value" },
                content: [mcp.image("iVBORw0KGgo=", "image/png")],
                isError: true,
                _meta: { source: "sandbox" },
            })`,
            host,
            undefined,
            { foregroundMs: 1000, maxLifetimeMs: 5000 },
        );

        expect(outcome).toMatchObject({
            status: "completed",
            result: {
                [MCP_PRESENTATION_TAG]: {
                    kind: "result",
                    value: { original: "value" },
                    isError: true,
                    _meta: { source: "sandbox" },
                    content: [{
                        [MCP_PRESENTATION_TAG]: {
                            kind: "content",
                            content: {
                                type: "image",
                                data: "iVBORw0KGgo=",
                                mimeType: "image/png",
                            },
                        },
                    }],
                },
            },
        });
    });

    it("parks while awaiting I/O and names the in-flight RPC", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `({ con }) => con.call("github", "github.repos", "listForOrg", { org: "microsoft" })`,
            host,
            undefined,
            { foregroundMs: 30, maxLifetimeMs: 5000 },
        );

        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        expect(outcome.debugName).toBe(`con.call("github::github.repos::listForOrg")`);
        expect(outcome.task.inFlight()).toEqual([`con.call("github::github.repos::listForOrg")`]);

        // The RPC that actually reached the host carries the same method.
        expect(host.calls[0].method).toBe("github::github.repos::listForOrg");

        // Resolve the RPC; the parked task finishes in the background.
        host.calls[0].d.resolve(JSON.stringify(42));
        const final = await outcome.task.done;
        expect(final).toMatchObject({ status: "completed", result: 42 });
    });

    it("delivers stream messages while a call is parked", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `async ({ con }) => {
                const progress = [];
                const result = await con.call("jobs", "runner", "start", {}, {
                    onStreamMessage: message => {
                        progress.push(message);
                        console.log("progress", message);
                    },
                });
                return { progress, result };
            }`,
            host,
            undefined,
            { foregroundMs: 30, maxLifetimeMs: 5000 },
        );

        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        host.calls[0].stream(JSON.stringify({ step: 1 }));
        host.calls[0].stream(JSON.stringify({ step: 2 }));
        await waitFor(() => outcome.task.logs.length === 2);
        expect(outcome.task.logs.map((log) => log.text)).toEqual([
            `progress {"step":1}`,
            `progress {"step":2}`,
        ]);

        host.calls[0].d.resolve(JSON.stringify({ ok: true }));
        await expect(outcome.task.done).resolves.toMatchObject({
            status: "completed",
            result: {
                progress: [{ step: 1 }, { step: 2 }],
                result: { ok: true },
            },
        });
    });

    it("logs stream messages by default", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `({ con }) => con.call("jobs", "runner", "start", {})`,
            host,
            undefined,
            { foregroundMs: 30, maxLifetimeMs: 5000 },
        );

        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        host.calls[0].stream(JSON.stringify({ step: 1 }));
        await waitFor(() => outcome.task.logs.length === 1);
        expect(outcome.task.logs).toEqual([{
            level: "log",
            text: `stream jobs::runner::start {"step":1}`,
        }]);

        host.calls[0].d.resolve(JSON.stringify({ ok: true }));
        await expect(outcome.task.done).resolves.toMatchObject({
            status: "completed",
            result: { ok: true },
        });
    });

    it("uses an explicit label as the debug name when provided", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `({ con }) => con.call("a", "b", "c", {})`,
            host,
            undefined,
            { foregroundMs: 30, maxLifetimeMs: 5000, label: "ask user to confirm deploy" },
        );
        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        expect(outcome.debugName).toBe("ask user to confirm deploy");
        // The inferred in-flight info is still accurate alongside the label.
        expect(outcome.task.inFlight()).toEqual([`con.call("a::b::c")`]);
        await outcome.task.cancel();
    });

    it("kills a CPU-bound runaway instead of parking it", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(`() => { while (true) {} }`, host, undefined, {
            foregroundMs: 50,
            maxLifetimeMs: 5000,
        });
        expect(outcome.status).toBe("error");
        if (outcome.status === "error") expect(outcome.error).toMatch(/deadline/);
        expect(host.calls).toHaveLength(0);
    });
});

describe("startSandbox timers", () => {
    it("resolves a timeout within the foreground budget", async () => {
        const outcome = await startSandbox(
            `async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return "finished";
            }`,
            new FakeHost(),
            undefined,
            { foregroundMs: 1000, maxLifetimeMs: 5000 },
        );

        expect(outcome).toMatchObject({ status: "completed", result: "finished" });
    });

    it("keeps a timeout alive while the task is parked", async () => {
        const outcome = await startSandbox(
            `async () => {
                await new Promise(resolve => setTimeout(resolve, 80));
                return "finished";
            }`,
            new FakeHost(),
            undefined,
            { foregroundMs: 20, maxLifetimeMs: 5000 },
        );

        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        expect(outcome.debugName).toBe("setTimeout(80ms)");
        expect(outcome.task.inFlight()).toEqual(["setTimeout(80ms)"]);
        await expect(outcome.task.done).resolves.toMatchObject({
            status: "completed",
            result: "finished",
        });
    });

    it("runs and clears an interval", async () => {
        const outcome = await startSandbox(
            `async () => {
                let ticks = 0;
                await new Promise(resolve => {
                    const timer = setInterval(() => {
                        ticks++;
                        if (ticks === 3) {
                            clearInterval(timer);
                            resolve(undefined);
                        }
                    }, 10);
                });
                return ticks;
            }`,
            new FakeHost(),
            undefined,
            { foregroundMs: 1000, maxLifetimeMs: 5000 },
        );

        expect(outcome).toMatchObject({ status: "completed", result: 3 });
    });

    it("cancels pending timers with a parked task", async () => {
        const outcome = await startSandbox(
            `async () => {
                await new Promise(resolve => setTimeout(resolve, 10_000));
                return "unexpected";
            }`,
            new FakeHost(),
            undefined,
            { foregroundMs: 20, maxLifetimeMs: 5000 },
        );

        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        await expect(outcome.task.cancel()).resolves.toMatchObject({ status: "cancelled" });
        expect(outcome.task.inFlight()).toEqual([]);
    });
});

describe("startSandbox cancellation", () => {
    it("cancels a parked task with no handler as 'cancelled'", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `({ con }) => con.call("a", "b", "c", {})`,
            host,
            undefined,
            { foregroundMs: 30, maxLifetimeMs: 5000 },
        );
        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        const final = await outcome.task.cancel();
        expect(final.status).toBe("cancelled");
        expect(host.calls[0].signal.aborted).toBe(true);
    });

    it("lets the guest catch the abort and return a clean partial", async () => {
        const host = new FakeHost();
        const outcome = await startSandbox(
            `async ({ con }) => {
                try { await con.call("a", "b", "c", {}); return "got-result"; }
                catch { return "cancelled-cleanly"; }
            }`,
            host,
            undefined,
            { foregroundMs: 30, maxLifetimeMs: 5000 },
        );
        expect(outcome.status).toBe("parked");
        if (outcome.status !== "parked") return;
        const final = await outcome.task.cancel();
        expect(final).toMatchObject({ status: "completed", result: "cancelled-cleanly" });
    });
});
