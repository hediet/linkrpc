import { describe, expect, it } from "vitest";
import type { ParkedTask, SandboxLog, TaskOutcome } from "./sandbox";
import { TaskRegistry } from "./taskRegistry";

interface FakeTask {
    task: ParkedTask;
    settle(outcome: TaskOutcome): void;
    readonly cancelled: boolean;
}

function makeFakeTask(inFlight: string[] = []): FakeTask {
    let resolveDone!: (o: TaskOutcome) => void;
    const done = new Promise<TaskOutcome>((r) => { resolveDone = r; });
    const logs: SandboxLog[] = [];
    let settled = false;
    let cancelled = false;
    const settle = (o: TaskOutcome): void => {
        if (settled) return;
        settled = true;
        resolveDone(o);
    };
    const task: ParkedTask = {
        inFlight: () => [...inFlight],
        logs,
        done,
        cancel: async () => {
            cancelled = true;
            settle({ status: "cancelled", logs: [] });
            return done;
        },
    };
    return {
        task,
        settle,
        get cancelled() { return cancelled; },
    };
}

describe("TaskRegistry", () => {
    it("lists a registered live task", () => {
        const reg = new TaskRegistry();
        const t = makeFakeTask([`con.call("svc::iface::m")`]);
        const id = reg.register("wss://A", "do thing", t.task);
        const list = reg.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            taskId: id,
            debugName: "do thing",
            endpoint: "wss://A",
            inFlight: [`con.call("svc::iface::m")`],
        });
    });

    it("supersedes (cancels) the single live task", async () => {
        const reg = new TaskRegistry();
        const t1 = makeFakeTask();
        const id1 = reg.register("wss://A", "tail logs", t1.task);

        const superseded = await reg.cancelLive();
        expect(superseded).toMatchObject({ taskId: id1, debugName: "tail logs", outcome: "cancelled" });
        expect(t1.cancelled).toBe(true);

        // A new task can now take the slot.
        const t2 = makeFakeTask();
        reg.register("wss://A", "read settings", t2.task);
        expect(reg.list().map((t) => t.debugName)).toEqual(["read settings"]);
    });

    it("supersedes across connections (global invariant)", async () => {
        const reg = new TaskRegistry();
        const t1 = makeFakeTask();
        const id1 = reg.register("wss://A", "watch A", t1.task);

        // Registering on a different connection supersedes the live task.
        const superseded = await reg.cancelLive();
        expect(superseded).toMatchObject({ taskId: id1, debugName: "watch A", outcome: "cancelled" });
        expect(t1.cancelled).toBe(true);

        const t2 = makeFakeTask();
        reg.register("wss://B", "watch B", t2.task);
        expect(reg.list().map((t) => t.debugName)).toEqual(["watch B"]);
    });

    it("awaitTask returns running until settled, then the result", async () => {
        const reg = new TaskRegistry();
        const t = makeFakeTask([`con.call("a::b::c")`]);
        const id = reg.register("wss://A", "slow", t.task);

        const running = await reg.awaitTask(id, 10);
        expect(running).toMatchObject({ status: "running", taskId: id, inFlight: [`con.call("a::b::c")`] });

        t.settle({ status: "completed", result: 7, logs: [] });
        const done = await reg.awaitTask(id, 1000);
        expect(done).toMatchObject({ status: "completed", taskId: id, result: 7 });
    });

    it("invokes onComplete with the result and clears the live slot", async () => {
        const reg = new TaskRegistry();
        const t = makeFakeTask();
        const results: unknown[] = [];
        reg.register("wss://A", "calc", t.task, (r) => results.push(r));

        t.settle({ status: "completed", result: { ok: true }, logs: [] });
        // Allow the done.then bookkeeping to run.
        await new Promise((r) => setImmediate(r));

        expect(results).toEqual([{ ok: true }]);
        expect(reg.list()).toHaveLength(0);
    });

    it("cancel(taskId) settles the task as cancelled", async () => {
        const reg = new TaskRegistry();
        const t = makeFakeTask();
        const id = reg.register("wss://A", "x", t.task);
        const res = await reg.cancel(id);
        expect(res).toMatchObject({ status: "cancelled", taskId: id });
        expect(t.cancelled).toBe(true);
    });

    it("reports unknown task ids", async () => {
        const reg = new TaskRegistry();
        expect(await reg.awaitTask("nope", 1)).toEqual({ status: "unknown", taskId: "nope" });
        expect(await reg.cancel("nope")).toEqual({ status: "unknown", taskId: "nope" });
    });
});
