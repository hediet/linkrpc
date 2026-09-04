import {
    defineInterface,
    type JsonRpcMessage,
    type JsonValue,
    requestType,
} from "@hediet/linkrpc";
import { parseEndpointUri } from "@hediet/linkrpc/node";
import { SocketServer, type NodeSocketTransport } from "@hediet/linkrpc-hub/hub/server/node";
import { connect } from "@hediet/linkrpc-client";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStaticHubSchema } from "../staticHubSchema";
import {
    disconnectBroker,
    getBrokerStatus,
    readBrokerNotifications,
} from "./connectionBrokerClient";
import { runConnectionBroker } from "./connectionBrokerProcess";

const disposables: { dispose(): void; }[] = [];

afterEach(() => {
    for (const disposable of disposables.splice(0)) {
        disposable.dispose();
    }
});

describe("runConnectionBroker", () => {
    it("keeps one initialized remote transport across local clients and buffers notifications", async () => {
        const remoteServer = await SocketServer.start();
        disposables.push(remoteServer);
        const remoteTransports: NodeSocketTransport[] = [];
        remoteServer.setConnectionHandler((transport) => remoteTransports.push(transport));

        const broker = await runConnectionBroker({
            remote: { kind: "socket", path: remoteServer.endpoint, token: "remote-token" },
            timeoutMs: 30_000,
            ttlMs: 300_000,
        });
        disposables.push(broker);
        await vi.waitFor(() => expect(remoteTransports).toHaveLength(1));

        const first = await connect(parseEndpointUri(broker.endpoint));
        await remoteTransports[0].send(notification("event.ready", { value: 1 }));
        await expect(readBrokerNotifications(first.channel)).resolves.toMatchObject({
            notifications: [{
                sequence: 1,
                method: "event.ready",
                params: { value: 1 },
            }],
        });
        first.close();

        await vi.waitFor(async () => {
            const second = await connect(parseEndpointUri(broker.endpoint));
            try {
                await expect(getBrokerStatus(second.channel)).resolves.toMatchObject({
                    mode: "linkrpc",
                    notificationCount: 1,
                });
                await disconnectBroker(second.channel);
            } finally {
                second.close();
            }
        });
        await expect(broker.stopped).resolves.toBe("disconnect");
        expect(remoteTransports).toHaveLength(1);
    });

    it("redacts remote endpoint tokens in status", async () => {
        const remoteServer = await SocketServer.start();
        disposables.push(remoteServer);
        const broker = await runConnectionBroker({
            remote: { kind: "socket", path: remoteServer.endpoint, token: "secret" },
            timeoutMs: 30_000,
            ttlMs: 300_000,
        });
        disposables.push(broker);

        const client = await connect(parseEndpointUri(broker.endpoint));
        try {
            const status = await getBrokerStatus(client.channel);
            expect(JSON.stringify(status)).not.toContain("secret");
        } finally {
            client.close();
        }
    });

    it("serves a configured static schema through the real local socket", async () => {
        const remoteServer = await SocketServer.start();
        disposables.push(remoteServer);
        remoteServer.setConnectionHandler(() => { });
        const iface = defineInterface(
            { id: "example.ping" },
            { ping: requestType(z.object({}), z.object({ ok: z.boolean() })) },
        );
        const schema = iface.toSchema();
        const ref = { interfaceId: schema.id, interfaceHash: schema.hash };
        const broker = await runConnectionBroker({
            remote: { kind: "socket", path: remoteServer.endpoint, token: "remote-token" },
            timeoutMs: 30_000,
            ttlMs: 300_000,
            staticHubSchema: parseStaticHubSchema({
                services: [],
                defaultInterface: ref,
                interfaceSchemas: [schema],
            }),
        });
        disposables.push(broker);

        const client = await connect(parseEndpointUri(broker.endpoint));
        try {
            await expect(client.channel.sendRequest("hubrpc.defaults::get", {})).resolves.toEqual({
                interfaceId: schema.id,
                interfaceHash: schema.hash,
            });
        } finally {
            client.close();
        }
    });
});

function notification(method: string, params: JsonValue): JsonRpcMessage {
    return {
        jsonrpc: "2.0",
        method,
        params,
    };
}
