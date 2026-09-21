/**
 * Minimal JSON-RPC 2.0 wire types — only what we need to send and receive
 * requests, notifications, and responses.
 */

import type { JsonValue } from "./jsonValue";

export type { JsonValue };

export type RequestId = number | string;

export interface JsonRpcRequest<TParams = JsonValue> {
    jsonrpc: "2.0";
    id: RequestId;
    method: string;
    params?: TParams;
}

export interface JsonRpcNotification<TParams = JsonValue> {
    jsonrpc: "2.0";
    method: string;
    params?: TParams;
}

export interface JsonRpcSuccess {
    jsonrpc: "2.0";
    id: RequestId | null;
    result: JsonValue;
}

export interface JsonRpcError {
    jsonrpc: "2.0";
    id: RequestId | null;
    error: { code: number; message: string; data?: JsonValue };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ErrorCode = {
    /** Default code for named LinkRPC application errors. */
    applicationError: 1,
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    /** Caller is authenticated but lacks a capability covering the call. */
    permissionRequired: -32401,
    /** The peer a request was routed to detached before it could respond. */
    peerDisconnected: -32402,
    /** The request exceeded the hub's idle timeout with no stream activity. */
    requestTimeout: -32403,
    /** The request was cancelled (by the caller, or by the hub on disconnect). */
    cancelled: -32800,
} as const;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
    return typeof (m as JsonRpcRequest).method === "string"
        && (m as JsonRpcRequest).id !== undefined;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
    return typeof (m as JsonRpcNotification).method === "string"
        && (m as JsonRpcRequest).id === undefined;
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
    return typeof (m as JsonRpcRequest).method !== "string";
}
