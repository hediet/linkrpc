import { describe, expect, it } from "vitest";
import { formatEndpoint, resolveEndpoint, resolveTargetEndpoint } from "./endpoint";

describe("resolveEndpoint", () => {
    it("returns undefined when nothing is configured", () => {
        const r = resolveEndpoint({ env: {} });
        expect(r.endpoint).toBeUndefined();
        expect(r.error).toBeUndefined();
    });

    it("builds a cmd-env spec from --endpoint-cmd", () => {
        const r = resolveEndpoint({ endpointCmd: "node server.js", env: {} });
        expect(r.endpoint).toEqual({ kind: "cmd-env", command: { command: "node server.js" } });
    });

    it("builds a cmd-stdio spec from --endpoint-cmd-stdio", () => {
        const r = resolveEndpoint({ endpointCmdStdio: "node server.js", env: {} });
        expect(r.endpoint).toEqual({ kind: "cmd-stdio", command: { command: "node server.js" } });
    });

    it("carries --endpoint-cmd-cwd onto a cmd-env spec", () => {
        const r = resolveEndpoint({ endpointCmd: "node server.js", endpointCmdCwd: "/work/dir", env: {} });
        expect(r.endpoint).toEqual({
            kind: "cmd-env",
            command: { command: "node server.js" },
            cwd: "/work/dir",
        });
    });

    it("carries --endpoint-cmd-cwd onto a cmd-stdio spec", () => {
        const r = resolveEndpoint({ endpointCmdStdio: "node server.js", endpointCmdCwd: "/work/dir", env: {} });
        expect(r.endpoint).toEqual({
            kind: "cmd-stdio",
            command: { command: "node server.js" },
            cwd: "/work/dir",
        });
    });

    it("errors when --endpoint-cmd-cwd is given without a cmd endpoint", () => {
        const r = resolveEndpoint({ endpoint: "unix:/x.sock", endpointCmdCwd: "/work/dir", env: {} });
        expect(r.endpoint).toBeUndefined();
        expect(r.error).toMatch(/--endpoint-cmd-cwd requires/);
    });

    it("parses --endpoint URIs", () => {
        const r = resolveEndpoint({ endpoint: "wss://hub/?token=k", env: {} });
        expect(r.endpoint).toEqual({ kind: "ws", url: "wss://hub/", token: "k" });
    });

    it("preserves ws-no-init query parameters for transport-level authentication", () => {
        const r = resolveEndpoint({ endpoint: "ws-no-init://host:4123?tkn=k", env: {} });
        expect(r.endpoint).toEqual({
            kind: "ws-no-init",
            url: "ws://host:4123/?tkn=k",
        });
    });

    it("--endpoint-token overrides the URI token", () => {
        const r = resolveEndpoint({ endpoint: "unix:/x.sock?token=a", endpointToken: "b", env: {} });
        expect(r.endpoint).toEqual({ kind: "socket", path: "/x.sock", token: "b" });
    });

    it("ignores LINKRPC_TOKEN for an explicit --endpoint", () => {
        const r = resolveEndpoint({
            endpoint: "unix:/x.sock",
            env: { LINKRPC_TOKEN: "envtok" },
        });
        expect(r.endpoint).toEqual({ kind: "socket", path: "/x.sock" });
    });

    it("resolves a socket endpoint from env with LINKRPC_TOKEN", () => {
        const r = resolveEndpoint({
            env: { LINKRPC_ENDPOINT: "/tmp/x.sock", LINKRPC_TOKEN: "abc" },
        });
        expect(r.endpoint).toEqual({ kind: "socket", path: "/tmp/x.sock", token: "abc" });
    });

    it("env URI token wins over LINKRPC_TOKEN", () => {
        const r = resolveEndpoint({
            env: { LINKRPC_ENDPOINT: "unix:/x.sock?token=fromuri", LINKRPC_TOKEN: "fromenv" },
        });
        expect(r.endpoint).toEqual({ kind: "socket", path: "/x.sock", token: "fromuri" });
    });

    it("--endpoint-token overrides LINKRPC_TOKEN for an env endpoint", () => {
        const r = resolveEndpoint({
            endpointToken: "flag",
            env: { LINKRPC_ENDPOINT: "/x.sock", LINKRPC_TOKEN: "env" },
        });
        expect(r.endpoint).toEqual({ kind: "socket", path: "/x.sock", token: "flag" });
    });

    it("resolves a bare ws endpoint from env", () => {
        const r = resolveEndpoint({
            env: { LINKRPC_ENDPOINT: "wss://hub.example.com", LINKRPC_TOKEN: "abc" },
        });
        expect(r.endpoint).toEqual({ kind: "ws", url: "wss://hub.example.com/", token: "abc" });
    });

    it("errors on more than one --endpoint* flag", () => {
        const r = resolveEndpoint({ endpoint: "unix:/x", endpointCmd: "node y", env: {} });
        expect(r.endpoint).toBeUndefined();
        expect(r.error).toMatch(/at most one/);
    });

    it("surfaces a parse error for a bad --endpoint scheme", () => {
        const r = resolveEndpoint({ endpoint: "ftp://x/y", env: {} });
        expect(r.endpoint).toBeUndefined();
        expect(r.error).toMatch(/unsupported endpoint scheme/);
    });
});

describe("formatEndpoint", () => {
    it("redacts the token", () => {
        expect(formatEndpoint({ kind: "socket", path: "/x.sock", token: "secret" }))
            .toBe("unix:/x.sock?token=***");
    });
});

describe("resolveTargetEndpoint (cwd)", () => {
    it("carries --target-endpoint-cmd-cwd onto a cmd-env target", () => {
        const r = resolveTargetEndpoint({ targetEndpointCmd: "node t.js", targetEndpointCmdCwd: "/t/dir" });
        expect(r.endpoint).toEqual({
            kind: "cmd-env",
            command: { command: "node t.js" },
            cwd: "/t/dir",
        });
    });

    it("errors when --target-endpoint-cmd-cwd is given without a cmd target", () => {
        const r = resolveTargetEndpoint({ targetEndpoint: "unix:/x.sock", targetEndpointCmdCwd: "/t/dir" });
        expect(r.endpoint).toBeUndefined();
        expect(r.error).toMatch(/--target-endpoint-cmd-cwd requires/);
    });
});
