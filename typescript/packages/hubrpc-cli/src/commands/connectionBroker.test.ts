import {
    defineInterface,
    ErrorCode,
    requestType,
    RpcError,
    TransportPair,
} from "@vscode/hubrpc";
import { connectViaTransport, type CliConnection } from "@vscode/hubrpc-client";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStaticHubSchema, type StaticHubSchema } from "../staticHubSchema";
import {
    BROKER_DISCONNECT_METHOD,
    BROKER_READ_NOTIFICATIONS_METHOD,
    BROKER_STATUS_METHOD,
    ConnectionBroker,
} from "./connectionBroker";

interface TestConnections {
    readonly broker: ConnectionBroker;
    readonly localClient: CliConnection;
    readonly remotePeer: CliConnection;
    dispose(): void;
}

function createConnections(options: {
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
    staticHubSchema?: StaticHubSchema;
} = {}): TestConnections {
    const remotePair = new TransportPair();
    const remote = connectViaTransport(remotePair.a);
    const remotePeer = connectViaTransport(remotePair.b);
    const broker = new ConnectionBroker(remote, {
        id: "test",
        remoteEndpoint: "ws-no-init://example.test/",
        mode: "raw",
        startedAt: options.now?.() ?? Date.now(),
        timeoutMs: options.timeoutMs ?? 30_000,
        ttlMs: options.ttlMs ?? 300_000,
        notificationLimit: 2,
        now: options.now,
        staticHubSchema: options.staticHubSchema,
    });

    const localPair = new TransportPair();
    const localClient = connectViaTransport(localPair.a);
    const localBroker = connectViaTransport(localPair.b);
    broker.attach(localBroker);

    return {
        broker,
        localClient,
        remotePeer,
        dispose: () => {
            localClient.close();
            remotePeer.close();
            broker.dispose();
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("ConnectionBroker", () => {
    it("forwards arbitrary bare JSON-RPC methods and notifications", async () => {
        const connections = createConnections();
        const notifications: unknown[] = [];
        connections.remotePeer.setRequestHandler({
            handleRequest: async (call) => ({ result: { method: call.method, params: call.params } }),
            handleNotification: (call) => notifications.push({
                method: call.method,
                params: call.params,
            }),
        });

        try {
            await expect(connections.localClient.channel.sendRequest("bareMethod", { value: 1 }))
                .resolves.toEqual({ method: "bareMethod", params: { value: 1 } });
            await connections.localClient.channel.sendNotification("bareNotification", { value: 2 });
            await vi.waitFor(() => expect(notifications).toHaveLength(1));
            expect(notifications).toEqual([{
                method: "bareNotification",
                params: { value: 2 },
            }]);
        } finally {
            connections.dispose();
        }
    });

    it("intercepts overlay status without forwarding it", async () => {
        const connections = createConnections();
        const remoteMethods: string[] = [];
        connections.remotePeer.setRequestHandler({
            handleRequest: async (call) => {
                remoteMethods.push(call.method);
                return { result: {} };
            },
            handleNotification: () => { },
        });

        try {
            await expect(connections.localClient.channel.sendRequest(BROKER_STATUS_METHOD, {}))
                .resolves.toMatchObject({
                    id: "test",
                    mode: "raw",
                    remoteEndpoint: "ws-no-init://example.test/",
                    notificationCount: 0,
                });
            expect(remoteMethods).toEqual([]);
        } finally {
            connections.dispose();
        }
    });

    it("serves a static reflection facade without forwarding reflection calls", async () => {
        const iface = defineInterface(
            { id: "example.greeter" },
            {
                hello: requestType(
                    z.object({ name: z.string() }),
                    z.object({ greeting: z.string() }),
                ),
            },
        );
        const schema = iface.toSchema();
        const ref = { interfaceId: schema.id, interfaceHash: schema.hash };
        const connections = createConnections({
            staticHubSchema: parseStaticHubSchema({
                services: [],
                defaultInterface: ref,
                interfaceSchemas: [schema],
            }),
        });
        const remoteMethods: string[] = [];
        connections.remotePeer.setRequestHandler({
            handleRequest: async (call) => {
                remoteMethods.push(call.method);
                return { result: { greeting: `Hello ${(call.params as { name: string }).name}` } };
            },
            handleNotification: () => { },
        });

        try {
            await expect(connections.localClient.channel.sendRequest("hubrpc.defaults::get", {}))
                .resolves.toEqual({
                    interfaceId: schema.id,
                    interfaceHash: schema.hash,
                });
            await expect(connections.localClient.channel.sendRequest("hubrpc.directory::list", {}))
                .resolves.toEqual({ items: [] });
            await expect(connections.localClient.channel.sendRequest(
                "hubrpc.schemas::get",
                { interfaceId: schema.id },
            )).resolves.toEqual({ schema });
            await expect(connections.localClient.channel.sendRequest("hello", { name: "Ada" }))
                .resolves.toEqual({ greeting: "Hello Ada" });
            expect(remoteMethods).toEqual(["hello"]);
        } finally {
            connections.dispose();
        }
    });

    it("buffers remote notifications and reports dropped entries", async () => {
        const connections = createConnections();
        try {
            await connections.remotePeer.channel.sendNotification("event.one", { n: 1 });
            await connections.remotePeer.channel.sendNotification("event.two", { n: 2 });
            await connections.remotePeer.channel.sendNotification("event.three", { n: 3 });

            await expect(connections.localClient.channel.sendRequest(
                BROKER_READ_NOTIFICATIONS_METHOD,
                { after: 0 },
            )).resolves.toMatchObject({
                droppedBefore: 2,
                notifications: [
                    { sequence: 2, method: "event.two", params: { n: 2 } },
                    { sequence: 3, method: "event.three", params: { n: 3 } },
                ],
            });
        } finally {
            connections.dispose();
        }
    });

    it("long-polls for the next notification", async () => {
        const connections = createConnections();
        try {
            const pending = connections.localClient.channel.sendRequest(
                BROKER_READ_NOTIFICATIONS_METHOD,
                { after: 0, waitMs: 1_000 },
            );
            await connections.remotePeer.channel.sendNotification("event.ready", { ok: true });
            await expect(pending).resolves.toMatchObject({
                notifications: [{
                    sequence: 1,
                    method: "event.ready",
                    params: { ok: true },
                }],
            });
        } finally {
            connections.dispose();
        }
    });

    it("supports concurrent local clients with independent request correlation", async () => {
        const connections = createConnections();
        const pair = new TransportPair();
        const second = connectViaTransport(pair.a);
        const secondBroker = connectViaTransport(pair.b);
        connections.broker.attach(secondBroker);
        connections.remotePeer.setRequestHandler({
            handleRequest: async (call) => {
                await Promise.resolve();
                return { result: { method: call.method } };
            },
            handleNotification: () => { },
        });
        try {
            await expect(Promise.all([
                connections.localClient.channel.sendRequest("first", {}),
                second.channel.sendRequest("second", {}),
            ])).resolves.toEqual([
                { method: "first" },
                { method: "second" },
            ]);
        } finally {
            connections.broker.detach(secondBroker);
            second.close();
            secondBroker.close();
            connections.dispose();
        }
    });

    it("disconnects through the overlay after returning a response", async () => {
        const connections = createConnections();
        try {
            await expect(connections.localClient.channel.sendRequest(BROKER_DISCONNECT_METHOD, {}))
                .resolves.toEqual({ disconnected: true });
            await vi.waitFor(() => expect(connections.broker.stoppedReason).toBe("disconnect"));
        } finally {
            connections.dispose();
        }
    });

    it("rejects unknown broker overlay methods locally", async () => {
        const connections = createConnections();
        try {
            await expect(connections.localClient.channel.sendRequest(
                "hubrpc.connectionBroker::unknown",
                {},
            )).rejects.toEqual(expect.objectContaining<RpcError>({
                code: ErrorCode.methodNotFound,
            }));
        } finally {
            connections.dispose();
        }
    });

    it("applies inactivity timeout and hard ttl independently", async () => {
        vi.useFakeTimers();
        let now = 1_000;
        vi.setSystemTime(now);
        const inactive = createConnections({ timeoutMs: 100, ttlMs: 1_000, now: () => now });
        try {
            now += 50;
            vi.setSystemTime(now);
            inactive.broker.recordActivity();
            await vi.advanceTimersByTimeAsync(99);
            expect(inactive.broker.stoppedReason).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);
            expect(inactive.broker.stoppedReason).toBe("timeout");
        } finally {
            inactive.dispose();
        }

        now = 2_000;
        vi.setSystemTime(now);
        const hardTtl = createConnections({ timeoutMs: 100, ttlMs: 250, now: () => now });
        try {
            for (let i = 0; i < 4; i++) {
                await vi.advanceTimersByTimeAsync(50);
                now += 50;
                hardTtl.broker.recordActivity();
            }
            await vi.advanceTimersByTimeAsync(50);
            expect(hardTtl.broker.stoppedReason).toBe("ttl");
        } finally {
            hardTtl.dispose();
        }
    });
});
