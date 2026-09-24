import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { connect } from "./connect";

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
    }
}

describe("stdio command shutdown", () => {
    it("ends stdin so a server handling SIGTERM can finish without a live input pipe", async () => {
        const source = `
            import { serveOnStdio } from "@hediet/linkrpc/node";
            import { defineInterface, requestType } from "@hediet/linkrpc";
            import { z } from "zod";
            const connection = await serveOnStdio();
            connection.register(defineInterface({ id: "test.process" }, {
                pid: requestType(z.object({}), z.number()),
            }), { pid: () => process.pid });
            process.on("SIGTERM", () => connection.close());
            process.stdin.once("end", () => connection.close());
        `;
        const connection = await connect({
            kind: "cmd-stdio",
            command: { argv: [process.execPath, "--input-type=module", "-e", source] },
        });
        let pid: number | undefined;
        try {
            const response = await connection.channel.sendRequest("test.process::pid", {});
            if (typeof response !== "number") throw new Error("Expected a numeric child process ID");
            pid = response;
            connection.close();
            const deadline = Date.now() + 3_000;
            while (isRunning(pid) && Date.now() < deadline) await delay(20);
            expect(isRunning(pid)).toBe(false);
        } finally {
            connection.close();
            if (pid !== undefined && isRunning(pid)) process.kill(pid, "SIGKILL");
        }
    }, 10_000);
});
