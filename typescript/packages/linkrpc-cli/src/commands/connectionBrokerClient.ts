import type { JsonValue } from "@hediet/linkrpc";
import type { CliChannel } from "@hediet/linkrpc-client";
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
    await channel.sendRequest(BROKER_DISCONNECT_METHOD, {});
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
