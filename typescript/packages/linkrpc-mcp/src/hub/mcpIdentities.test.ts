import { describe, expect, it } from "vitest";
import { defaultMcpIdentity, staticMcpIdentities } from "./mcpIdentities";
import { upstreamFromConfig } from "./upstream";

const stdio = { kind: "stdio" as const, command: "server" };
const http = { kind: "streamable-http" as const, url: "https://mcp.example.com/mcp" };

describe("MCP identities", () => {
    it("uses the identity marked default, else the first", () => {
        expect(defaultMcpIdentity([{ id: "a" }, { id: "b", default: true }])?.id).toBe("b");
        expect(defaultMcpIdentity([{ id: "a" }, { id: "b" }])?.id).toBe("a");
        expect(defaultMcpIdentity([])).toBeUndefined();
    });

    it("rejects inconsistent identity configs", () => {
        expect(() => staticMcpIdentities(stdio, [{ id: "a" }, { id: "a" }])).toThrow("Duplicate MCP identity: a");
        expect(() => staticMcpIdentities(stdio, [{ id: "a", default: true }, { id: "b", default: true }]))
            .toThrow("At most one MCP identity can be the default");
        expect(() => staticMcpIdentities(stdio, [{ id: "a", headers: { x: "1" } }]))
            .toThrow("MCP identity 'a' sets headers on a stdio transport");
        expect(() => staticMcpIdentities(http, [{ id: "a", env: { X: "1" } }]))
            .toThrow("MCP identity 'a' sets env on a streamable-http transport");
        expect(() => staticMcpIdentities(stdio, [{ id: "a b" }])).toThrow("Invalid MCP identity id: a b");
    });

    it("reads { fromEnv } values when a session opens", async () => {
        const upstream = upstreamFromConfig(
            { ...http, headers: { Authorization: { fromEnv: "TOKEN" } } },
            { env: {} },
        );
        expect(upstream.label).toBe("https://mcp.example.com/mcp");
        expect(() => upstream.createTransport()).toThrow("Environment variable TOKEN is not set (for Authorization)");
        expect(staticMcpIdentities(http, [{ id: "a", headers: { Authorization: { fromEnv: "TOKEN" } } }], {
            env: { TOKEN: "Bearer x" },
        }).upstream("a").createTransport()).toBeDefined();
    });
});
