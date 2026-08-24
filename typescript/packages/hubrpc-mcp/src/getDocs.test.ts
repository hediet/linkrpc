import { describe, expect, it } from "vitest";
import { runSandboxed, type SandboxHostApi } from "./sandbox";
import { CONNECTION_DTS } from "./connectionDts";

const host: SandboxHostApi = {
    call: async () => { throw new Error("host.call should not be invoked"); },
    notify: async () => { throw new Error("host.notify should not be invoked"); },
    explore: async () => { throw new Error("host.explore should not be invoked"); },
    requestAccess: async () => { throw new Error("host.requestAccess should not be invoked"); },
    grants: async () => { throw new Error("host.grants should not be invoked"); },
};

describe("con.getDocs", () => {
    it("returns the embedded connection.d.ts text verbatim", async () => {
        const run = await runSandboxed(`({ con }) => con.getDocs()`, host, undefined);
        const text = run.resultJson === "" ? undefined : JSON.parse(run.resultJson);
        expect(typeof text).toBe("string");
        expect(text).toBe(CONNECTION_DTS);
    });
});
