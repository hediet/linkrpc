import type { CliChannel } from "@hediet/linkrpc-client";
import type { JsonValue } from "@hediet/linkrpc";
import { isDeepStrictEqual } from "node:util";
import { parse } from "zod/mini";
import {
    applyJsonDocumentEdits, loggingInterface, logDocumentSchema, logStreamEventSchema,
    type LogDocument, type LogEntry, type LogLevel,
} from "@hediet/linkrpc-infra";
import type { ResolvedViewInterface, ViewOpenContext } from "../../views/types";

export const levels = ["trace", "debug", "info", "warn", "error"] as const;
export interface LoggingTarget {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly route: (member: string) => string;
}
export interface LogFrame {
    readonly revision: number;
    readonly document: LogDocument;
    readonly entries: readonly LogEntry[];
    readonly hidden: number;
}
export interface LogOptions {
    readonly level: LogLevel;
    readonly tail: number;
    readonly maxBytes: number;
    readonly timeoutMs: number;
}

export function resolveLoggingTargets(context: ViewOpenContext): LoggingTarget[] {
    const selected = context.interfaces.filter(listing =>
        listing.interfaceId === "linkrpc.logging" || listing.tags?.includes("linkrpc.logging"));
    return selected.map(listing => {
        validateLoggingSchema(listing);
        return {
            serviceId: listing.serviceId, interfaceId: listing.interfaceId, hash: listing.schema.hash,
            route: member => listing.isDefault ? member
                : [listing.serviceId, listing.interfaceId, member].filter(Boolean).join("::"),
        };
    });
}

function validateLoggingSchema(listing: ResolvedViewInterface): void {
    const canonical = loggingInterface.toSchema();
    if (listing.interfaceId !== canonical.id
        || !isDeepStrictEqual(listing.schema.methods, canonical.methods)
        || !isDeepStrictEqual(listing.schema.components, canonical.components)) {
        throw new Error(`Interface ${listing.interfaceId} does not implement the canonical logging contract (tags are discovery hints)`);
    }
}

export function logOptions(options: Readonly<Record<string, unknown>>): LogOptions {
    const level = String(options.level ?? "trace") as LogLevel;
    if (![...levels, "off"].includes(level)) throw new Error("--level must be trace, debug, info, warn, error, or off");
    const tail = options.tail ?? 200;
    const maxBytes = options.maxBytes ?? 2_000_000;
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(tail) || Number(tail) < 1 || Number(tail) > 10_000) throw new Error("--tail must be an integer from 1 to 10000");
    if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1024 || Number(maxBytes) > 50_000_000) throw new Error("--max-bytes must be an integer from 1024 to 50000000");
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1) throw new Error("--timeout-ms must be a positive integer");
    return { level, tail: Number(tail), maxBytes: Number(maxBytes), timeoutMs: Number(timeoutMs) };
}

function flatten(entries: readonly LogEntry[], result: LogEntry[] = [], depth = 0): LogEntry[] {
    if (depth > 32) throw new Error("Log entry nesting exceeds 32 levels");
    for (const entry of entries) {
        result.push(entry);
        if (entry.entries) flatten(entry.entries, result, depth + 1);
    }
    return result;
}

export function frame(revision: number, document: LogDocument, options: LogOptions): LogFrame {
    const filtered = flatten(document.entries).filter(entry =>
        options.level !== "off" && levels.indexOf(entry.level) >= levels.indexOf(options.level as typeof levels[number]));
    return {
        revision, document, entries: filtered.slice(-options.tail),
        hidden: filtered.length - Math.min(filtered.length, options.tail),
    };
}

function checkedDocument(value: unknown, maxBytes: number): LogDocument {
    checkedSize(value, maxBytes);
    return parse(logDocumentSchema, value);
}

function checkedSize(value: unknown, maxBytes: number): void {
    if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > maxBytes) {
        throw new Error(`Logging payload exceeds --max-bytes (${maxBytes}); stream stopped to bound memory`);
    }
}

export async function readLogSnapshot(channel: CliChannel, target: LoggingTarget, options: LogOptions): Promise<LogFrame> {
    const value = await withDeadline(
        channel.sendRequest(target.route("getLogSnapshot"), {}, { interfaceHash: target.hash }), options.timeoutMs);
    const result = value as { revision?: unknown; document?: unknown };
    if (!Number.isSafeInteger(result?.revision) || Number(result.revision) < 0) throw new Error("Invalid logging snapshot revision");
    return frame(Number(result.revision), checkedDocument(result.document, options.maxBytes), options);
}

export async function watchLog(
    channel: CliChannel, target: LoggingTarget, options: LogOptions,
    emit: (value: LogFrame) => void, stop: Promise<void>,
): Promise<void> {
    let revision: number | undefined;
    let document: LogDocument | undefined;
    let pending = 0;
    let queue = Promise.resolve();
    let fail!: (error: unknown) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    const call = channel.sendRequestWithStream(target.route("watchLog"), {}, {
        interfaceHash: target.hash,
        onStreamMessage: payload => {
            if (++pending > 128) { fail(new Error("Logging stream backlog exceeded 128 events; stopping slow consumer")); return; }
            queue = queue.then(async () => {
                try {
                    checkedSize(payload, options.maxBytes);
                    const event = logStreamEventSchema.parse(payload);
                    if (event.type === "snapshot") {
                        revision = event.revision;
                        document = checkedDocument(event.document, options.maxBytes);
                    } else {
                        if (revision === undefined || event.revision !== revision + 1) {
                            const latest = await readLogSnapshot(channel, target, options);
                            revision = latest.revision;
                            document = latest.document;
                            emit(latest);
                            if (event.revision <= revision) return;
                            if (event.revision !== revision + 1) throw new Error(`Logging revision gap after resync: ${revision} -> ${event.revision}`);
                        }
                        // A validated wire document is JSON data, but its domain
                        // interface has no index signature required by JsonValue.
                        const jsonDocument: JsonValue = JSON.parse(JSON.stringify(document));
                        document = checkedDocument(applyJsonDocumentEdits(jsonDocument, event.edits), options.maxBytes);
                        revision = event.revision;
                    }
                    emit(frame(revision, document, options));
                } finally { pending--; }
            }).catch(fail);
        },
    });
    const timer = setTimeout(() => {
        if (revision === undefined) fail(new Error(`Logging watch produced no snapshot within ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    try {
        const outcome = await Promise.race([call.result.then(() => "ended" as const), stop.then(() => "stop" as const), failure]);
        await Promise.race([queue, failure]);
        if (outcome === "ended" && revision === undefined) throw new Error("Logging watch ended without a snapshot");
    } finally {
        clearTimeout(timer);
        call.cancel("logging view closed");
        call.dispose?.();
        void call.result.catch(() => {});
    }
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Logging snapshot timed out after ${ms}ms`)), ms);
        })]);
    } finally { clearTimeout(timer); }
}
