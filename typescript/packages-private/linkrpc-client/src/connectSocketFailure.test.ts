import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { connect } from "./connect";

describe("socket connection failures", () => {
    it("rejects instead of emitting an unhandled socket error", async () => {
        const socketPath = process.platform === "win32"
            ? `\\\\.\\pipe\\missing-linkrpc-${randomUUID()}`
            : path.join(os.tmpdir(), `missing-linkrpc-${randomUUID()}.sock`);

        await expect(connect({ kind: "socket", path: socketPath }))
            .rejects.toThrow(/ENOENT|connect/);
    });
});
