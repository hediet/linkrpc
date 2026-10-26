import { describe, expect, it, vi } from "vitest";
import {
    createSeededMemoryPrincipal, directoryInterface, directoryWatchNever, ErrorCode,
    issueCapability, LinkRpcConnection,
    RpcError, schemasInterface, TransportPair,
} from "@hediet/linkrpc";
import { withForwardedCallGate } from "@hediet/linkrpc-hub/hub/server";
import { connectViaTransport } from "@hediet/linkrpc-client-internal";
import type { SigningSession } from "@hediet/linkrpc-client-internal";
import { lsCommand, requestDirectoryAccess, type LsState } from "./ls";

function fixture(failure: () => void | Promise<void>, schemaFailure?: () => void) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    server.register(directoryInterface, {
        list: () => ({ items: [{
            serviceId: "private", interfaceId: directoryInterface.info.id,
            interfaceHash: directoryInterface.schemaHash,
        }] }),
        watch: directoryWatchNever,
    });
    let calls = 0;
    server.register(directoryInterface, {
        list: async () => {
            calls++;
            await failure();
            return { items: [{ serviceId: "private", interfaceId: "test.api", interfaceHash: "test" }] };
        },
        watch: directoryWatchNever,
    }, { serviceId: "private" });
    server.register(schemasInterface, {
        get: () => {
            schemaFailure?.();
            return { schema: directoryInterface.toSchema() };
        },
    }, { serviceId: "private" });
    const connection = connectViaTransport(pair.a);
    return {
        channel: connection.channel,
        calls: () => calls,
        dispose: () => { connection.close(); server.close(); },
    };
}

describe("ls discovery access", () => {
    it("requests schema access when the directory itself is already readable", async () => {
        let allowed = false;
        const f = fixture(() => {}, () => {
            if (!allowed) throw new RpcError("Schema needs consent", ErrorCode.permissionRequired);
        });
        const unlock = vi.fn(async () => { allowed = true; return true; });
        try {
            const output = await lsCommand(f.channel, {
                serviceId: "private", withMembers: true, requestDirectoryAccess: unlock,
            });
            expect(output).toContain("list");
            expect(unlock).toHaveBeenCalledExactlyOnceWith("private");
            expect(f.calls()).toBe(1);
        } finally { f.dispose(); }
    });

    it("uses an approved capability across a real gate without granting API access", async () => {
        const root = await createSeededMemoryPrincipal({ seed: 701 });
        const principal = await createSeededMemoryPrincipal({ seed: 702 });
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.b, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
        }));
        server.register(directoryInterface, {
            list: () => ({ items: [{
                serviceId: "private", interfaceId: directoryInterface.info.id,
                interfaceHash: directoryInterface.schemaHash,
            }] }),
            watch: directoryWatchNever,
        });
        server.register(directoryInterface, {
            list: () => ({ items: [{ serviceId: "private", interfaceId: "test.api", interfaceHash: "test" }] }),
            watch: directoryWatchNever,
        }, { serviceId: "private" });
        const connection = connectViaTransport(pair.a);
        connection.signing.principal = principal;
        const requestAccess = vi.fn<SigningSession["requestAccess"]>(async request => {
            const capability = await issueCapability(root.identity, {
                audience: principal.identity.publicSigningIdentity,
                permissions: request.permissions.map(permission => ({
                    ...permission,
                    target: { ...permission.target, members: [...permission.target.members] },
                })),
                expiresAtMs: Date.now() + 60_000,
            });
            await principal.capBag.add(capability);
            return { status: "granted", capabilities: [capability] };
        });
        try {
            const output = await lsCommand(connection.channel, {
                requestDirectoryAccess: id => requestDirectoryAccess({ requestAccess }, id, {}),
            });
            expect(output).toContain("test.api");
            expect(output).not.toContain("Inaccessible");
            expect(requestAccess).toHaveBeenCalledOnce();
            await expect(connection.channel.sendRequest("private::test.api::mutate", {}))
                .rejects.toMatchObject({ code: ErrorCode.permissionRequired });
        } finally { connection.close(); server.close(); }
    });

    it("requests watch and schema reads only when those modes need them", async () => {
        const requestAccess = vi.fn<SigningSession["requestAccess"]>(async () =>
            ({ status: "granted", capabilities: [] }));
        await requestDirectoryAccess({ requestAccess }, "private", { watch: true, withMembers: true });
        expect(requestAccess.mock.calls[0][0].permissions).toMatchInlineSnapshot(`
          [
            {
              "canInvoke": true,
              "target": {
                "interfaceId": {
                  "exact": "hubrpc.directory",
                },
                "members": [
                  {
                    "exact": "list",
                  },
                  {
                    "exact": "watch",
                  },
                ],
                "serviceId": {
                  "exact": "private",
                },
              },
            },
            {
              "canInvoke": true,
              "target": {
                "interfaceId": {
                  "exact": "hubrpc.schemas",
                },
                "members": [
                  {
                    "exact": "get",
                  },
                ],
                "serviceId": {
                  "exact": "private",
                },
              },
            },
          ]
        `);
    });

    it.each([undefined, "json", "pretty", "jsonl"] as const)(
        "requests scoped access and retries discovery in %s output",
        async format => {
            let allowed = false;
            const f = fixture(() => {
                if (!allowed) throw new RpcError("Directory needs consent", ErrorCode.permissionRequired);
            });
            const requestAccess = vi.fn<SigningSession["requestAccess"]>(async () => {
                allowed = true;
                return { status: "granted", capabilities: [] };
            });
            const lines: string[] = [];
            try {
                const output = await lsCommand(f.channel, {
                    format,
                    emitLine: line => { lines.push(line); },
                    requestDirectoryAccess: id => requestDirectoryAccess({ requestAccess }, id, {}),
                });
                expect(output + lines.join("\n")).toContain("test.api");
                expect(f.calls()).toBe(2);
                expect(requestAccess.mock.calls).toEqual([[{
                    consumer: { name: "linkrpc-cli", purpose: "Discover interfaces in private." },
                    duration: "shortLived",
                    permissions: [{
                        canInvoke: true,
                        target: {
                            interfaceId: { exact: "hubrpc.directory" },
                            members: [{ exact: "list" }],
                            serviceId: { exact: "private" },
                        },
                    }],
                }]]);
            } finally { f.dispose(); }
        },
    );

    it("reports denial and does not retry or loop", async () => {
        const f = fixture(() => { throw new RpcError("Directory needs consent", ErrorCode.permissionRequired); });
        const requestAccess = vi.fn<SigningSession["requestAccess"]>(async () =>
            ({ status: "denied", reason: "Operator declined" }));
        const log = vi.fn();
        try {
            const output = await lsCommand(f.channel, {
                requestDirectoryAccess: id => requestDirectoryAccess({ requestAccess }, id, {}),
                log,
            });
            expect(output).toContain("! Inaccessible directory private: Directory needs consent");
            expect(log.mock.calls.flat().join("\n")).toContain("Operator declined");
            expect(requestAccess).toHaveBeenCalledOnce();
            expect(f.calls()).toBe(1);
        } finally { f.dispose(); }
    });

    it.each([undefined, "private"])("reports a still-rejected grant after exactly one retry (service=%s)", async serviceId => {
        const f = fixture(() => { throw new RpcError("Wrong issuer", ErrorCode.permissionRequired); });
        const unlock = vi.fn(async () => true);
        try {
            const state: LsState = JSON.parse(await lsCommand(f.channel, {
                format: "json", requestDirectoryAccess: unlock, serviceId,
            }));
            expect(state.inaccessible).toEqual([{ reason: "Wrong issuer", serviceId: "private" }]);
            expect(unlock).toHaveBeenCalledOnce();
            expect(f.calls()).toBe(2);
        } finally { f.dispose(); }
    });

    it.each(["timeout", "missing", "transport"] as const)("does not request access for %s", async kind => {
        const f = fixture(() => {
            if (kind === "timeout") return new Promise<void>(() => {});
            throw new RpcError(kind, kind === "missing" ? ErrorCode.methodNotFound : ErrorCode.internalError);
        });
        const unlock = vi.fn(async () => true);
        try {
            const state: LsState = JSON.parse(await lsCommand(f.channel, {
                format: "json", timeoutMs: 20, requestDirectoryAccess: unlock,
            }));
            expect(state.inaccessible).toEqual([{
                serviceId: "private",
                reason: kind === "timeout" ? "hub directory service 'private' timed out after 20ms" : kind,
            }]);
            expect(unlock).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });
});
