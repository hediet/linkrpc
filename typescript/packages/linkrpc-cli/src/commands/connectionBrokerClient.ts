import { withRpcTimeout, type JsonValue } from "@hediet/linkrpc";
import { connect, type CliChannel, type CliConnection } from "@hediet/linkrpc-client-internal";
import { parseEndpointUri } from "@hediet/linkrpc/node";
import {
    BROKER_DISCONNECT_METHOD,
    BROKER_READ_NOTIFICATIONS_METHOD,
    BROKER_STATUS_METHOD,
    type BufferedNotification,
} from "./connectionBroker";

export interface ReadBrokerNotificationsOptions {
    readonly after?: number;
    readonly waitMs?: number;
}

export interface BrokerNotificationBatch {
    readonly notifications: readonly BufferedNotification[];
    readonly next: number;
    readonly droppedBefore: number;
}

export function getBrokerStatus(channel: CliChannel): Promise<JsonValue> {
    return channel.sendRequest(BROKER_STATUS_METHOD, {});
}

export async function disconnectBroker(channel: CliChannel): Promise<void> {
    const call = channel.sendRequestWithStream(BROKER_DISCONNECT_METHOD, {});
    await withRpcTimeout(Object.assign(call.result, {
        cancel: (reason?: string) => call.cancel(reason),
        dispose: (reason?: string) => call.dispose?.(reason),
    }), BROKER_DISCONNECT_METHOD);
}

export async function stopConnectionBroker(endpoint: string, allowMissing = false): Promise<void> {
    const parsed = parseEndpointUri(endpoint);
    if (parsed.kind !== "socket" || parsed.token === undefined || parsed.brokerMode === undefined) {
        throw new Error("owned connection must be an authenticated local broker endpoint");
    }
    let connection: CliConnection;
    try {
        connection = await connect(parsed);
    } catch (error) {
        if (
            allowMissing
            && error instanceof Error
            && "code" in error
            && (error.code === "ENOENT" || error.code === "ECONNREFUSED")
            && "syscall" in error
            && error.syscall === "connect"
        ) {
            return;
        }
        throw error;
    }
    try {
        await disconnectBroker(connection.channel);
    } finally {
        connection.close();
    }
}

export async function readBrokerNotifications(
    channel: CliChannel,
    options: ReadBrokerNotificationsOptions = {},
): Promise<BrokerNotificationBatch> {
    const value = await channel.sendRequest(BROKER_READ_NOTIFICATIONS_METHOD, {
        after: options.after ?? 0,
        waitMs: options.waitMs ?? 0,
    });
    if (!isRecord(value) || !Array.isArray(value.notifications)) {
        throw new Error("connection broker returned an invalid notification batch");
    }
    const next = value.next;
    const droppedBefore = value.droppedBefore;
    if (
        typeof next !== "number"
        || !Number.isSafeInteger(next)
        || typeof droppedBefore !== "number"
        || !Number.isSafeInteger(droppedBefore)
    ) {
        throw new Error("connection broker returned invalid notification sequence metadata");
    }
    const notifications = value.notifications.map(parseNotification);
    return { notifications, next, droppedBefore };
}

function parseNotification(value: unknown): BufferedNotification {
    if (
        !isRecord(value)
        || typeof value.sequence !== "number"
        || !Number.isSafeInteger(value.sequence)
        || typeof value.receivedAt !== "number"
        || !Number.isSafeInteger(value.receivedAt)
        || typeof value.method !== "string"
    ) {
        throw new Error("connection broker returned an invalid notification");
    }
    return {
        sequence: value.sequence,
        receivedAt: value.receivedAt,
        method: value.method,
        ...("params" in value ? { params: value.params as JsonValue } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
