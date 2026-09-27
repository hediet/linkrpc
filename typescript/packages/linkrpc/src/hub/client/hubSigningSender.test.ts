import { describe, expect, it } from "vitest";
import {
    CapBag, issueCapabilities, issueCapability, JsonRpcChannel, KeypairSigningIdentity,
    methodNameToTarget, permits, Principal, TransportPair, verifyCall,
    type JsonValue, type Permission, type SignedCapability,
} from "../../index";
import { HubSigningSender } from "./hubSigningSender";

describe("HubSigningSender delegated grants", () => {
    it("retains, persists and forwards the complete requestAccess chain on later signed calls", async () => {
        const [root, delegate, consumer] = await Promise.all(Array.from({ length: 3 }, () => KeypairSigningIdentity.generateNew()));
        let persisted: unknown;
        const storage = {
            get: async <T>() => persisted as T | undefined,
            set: async (_key: string, value: unknown) => { persisted = JSON.parse(JSON.stringify(value)); },
            delete: async () => { const existed = persisted !== undefined; persisted = undefined; return existed; },
            list: async () => [],
        };
        const principal = new Principal(consumer, await CapBag.load({ storage }));
        const permission: Permission = {
            target: { serviceId: { exact: "files" }, interfaceId: { exact: "fs" }, members: [{ exact: "read" }] },
            canInvoke: true,
        };
        const parent = await issueCapability(root, {
            audience: delegate.publicSigningIdentity, permissions: [{ ...permission, canDelegate: true }],
        });
        const capabilities = await issueCapabilities(delegate, {
            audience: principal.id, permissions: [permission], capabilities: [parent],
            acceptableRootIds: [root.publicSigningIdentity.principal],
        });
        const pair = new TransportPair();
        const server = JsonRpcChannel.create(pair.b);
        const client = HubSigningSender.create(pair.a, principal);
        const received: SignedCapability[][] = [];
        server.setRequestHandler({
            handleRequest: async ({ method, params }) => {
                if (method === "hubAccess::requestAccess") {
                    return { result: { status: "granted", capabilities } as unknown as JsonValue };
                }
                const verified = await verifyCall({ method, params, parseMethod: methodNameToTarget, nowMs: Date.now() });
                expect(verified.ok).toBe(true);
                if (!verified.ok) throw new Error(verified.reason);
                received.push([...verified.capabilities]);
                return { result: (await permits(verified.call, verified.capabilities,
                    () => [{ principal: root.publicSigningIdentity.principal, isPublic: false }], Date.now())).ok };
            },
            handleNotification: () => {},
        });
        try {
            const result = await client.requestAccess({ consumer: { name: "test" }, permissions: [permission] });
            expect(result).toMatchObject({ status: "granted", addedDurable: 2, capabilities });
            expect(client.listGrants()).toEqual(capabilities);
            expect((await CapBag.load({ storage })).capabilities).toEqual(capabilities);
            expect(await client.sendRequest("files::fs::read", {})).toBe(true);
            expect(await client.sendRequest("files::fs::write", {})).toBe(false);
            expect(received).toEqual([capabilities, capabilities]);
        } finally {
            client.close();
            server.sender.close();
        }
    });
});
