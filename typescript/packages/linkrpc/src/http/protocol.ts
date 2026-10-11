import { parseMethodName } from '../protocol/methodName';
import type { JsonRpcMessage, JsonValue } from '../protocol/jsonRpc';
import { STREAM_METHOD, StreamDir, streamInterface } from '../connection/streaming';
import { safeParse } from 'zod/v4/core';

export const CALL_HEADER = 'LinkRPC-Call';
export const NDJSON = 'application/x-ndjson';
export const JSON_TYPE = 'application/json';
export const STREAM_PATH = '/$stream::send';
export const DEFAULT_MAX_BYTES = 1024 * 1024;

export function validateLimits(options: {
    readonly timeoutMs?: number;
    readonly maxFrameBytes?: number;
    readonly maxActiveCalls?: number;
    readonly maxPendingStreamMessages?: number;
}): void {
    for (const key of ['timeoutMs', 'maxFrameBytes', 'maxActiveCalls', 'maxPendingStreamMessages'] as const) {
        const value = options[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) {
            throw new Error(`${key} must be a positive integer no greater than 2147483647`);
        }
    }
}

export class HttpRpcError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = 'HttpRpcError';
    }
}

/** Each namespace is one encoded path segment; only a camel-case verb prefix is stripped. */
export function httpRoute(method: string): { readonly method: string; readonly path: string } {
    const parsed = parseMethodName(method);
    if (!parsed) throw new Error(`Invalid RPC method: ${method}`);
    const match = /^(get|post|put|patch|delete)(?=[A-Z])(.+)$/.exec(parsed.member);
    const verb = match?.[1].toUpperCase() ?? 'POST';
    const member = match ? match[2][0].toLowerCase() + match[2].slice(1) : parsed.member;
    const namespace = parsed.kind === 'bare' ? [] : parsed.kind === 'interface'
        ? [parsed.interfaceId] : [parsed.serviceId, parsed.interfaceId];
    return { method: verb, path: '/' + [...namespace, member].map(encodeURIComponent).join('/') };
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): JsonValue {
    try {
        return JSON.parse(text) as JsonValue;
    } catch {
        throw new HttpRpcError('Invalid JSON', 400);
    }
}

export function parseStreamMessage(value: unknown, dir: StreamDir): JsonRpcMessage {
    if (!isObject(value) || value.jsonrpc !== '2.0' || value.method !== STREAM_METHOD || 'id' in value) {
        throw new HttpRpcError('Expected a stream notification', 400);
    }
    const parsed = safeParse(streamInterface.members.send.paramsSchema, value.params);
    if (!parsed.success || parsed.data.dir !== dir || parsed.data.requestId !== 1
        || (parsed.data.control !== undefined) === Object.hasOwn(parsed.data, 'payload')) {
        throw new HttpRpcError('Invalid stream notification', 400);
    }
    return { jsonrpc: '2.0', method: STREAM_METHOD, params: value.params as JsonValue };
}

export function parseResponseMessage(text: string): JsonRpcMessage {
    const value: unknown = parseJson(text);
    if (isObject(value) && 'method' in value) return parseStreamMessage(value, StreamDir.toCaller);
    if (!isObject(value) || value.jsonrpc !== '2.0' || value.id !== 1
        || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) {
        throw new HttpRpcError('Invalid RPC response', 502);
    }
    if ('error' in value) {
        const error = value.error;
        if (!isObject(error) || !Number.isInteger(error.code) || typeof error.message !== 'string') {
            throw new HttpRpcError('Invalid RPC error', 502);
        }
        return {
            jsonrpc: '2.0', id: 1,
            error: { code: error.code as number, message: error.message, ...('data' in error ? { data: error.data as JsonValue } : {}) },
        };
    }
    return { jsonrpc: '2.0', id: 1, result: value.result as JsonValue };
}

/** Byte-bounded reads also work without Content-Length and across UTF-8 chunk boundaries. */
export async function* readLines(
    body: ReadableStream<Uint8Array>, maxBytes: number,
): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let bytes = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            let start = 0;
            for (let i = 0; i < value.length; i++) {
                if (value[i] !== 10) continue;
                const part = value.subarray(start, i);
                bytes += part.length;
                if (bytes > maxBytes) throw new HttpRpcError('Frame too large', 413);
                pending += decoder.decode(part, { stream: true }) + decoder.decode();
                if (pending.trim()) yield pending;
                pending = '';
                bytes = 0;
                start = i + 1;
            }
            bytes += value.length - start;
            if (bytes > maxBytes) throw new HttpRpcError('Frame too large', 413);
            pending += decoder.decode(value.subarray(start), { stream: true });
        }
        pending += decoder.decode();
        if (pending.trim()) yield pending;
    } finally {
        try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
}

export async function readBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal?: AbortSignal): Promise<string> {
    if (!body) return '';
    const reader = body.getReader();
    const abort = () => { void reader.cancel().catch(() => {
        // A failed body read is reported by reader.read below.
    }); };
    signal?.addEventListener('abort', abort, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let result = '';
    let bytes = 0;
    try {
        while (true) {
            signal?.throwIfAborted();
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) return result + decoder.decode();
            bytes += value.length;
            if (bytes > maxBytes) throw new HttpRpcError('Body too large', 413);
            result += decoder.decode(value, { stream: true });
        }
    } finally {
        signal?.removeEventListener('abort', abort);
        try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
}
