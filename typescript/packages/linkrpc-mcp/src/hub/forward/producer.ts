import { ErrorCode, type InterfaceRegistration, type LinkRpcConnection, RpcError } from "@hediet/linkrpc";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { legacyMcpForwardInterface, mcpForwardInterface } from "../contracts";
import { type McpIdentities, resolveMcpIdentity } from "../mcpIdentities";
import type { McpUpstream } from "../upstream";

export interface ServeMcpForwardOptions {
    readonly connection: LinkRpcConnection;
    readonly serviceId: string;
    /** The accounts to forward to; `connect` selects one with `mcpIdentity`. */
    readonly identities: McpIdentities;
    /** Register reflection for `serviceId`. Defaults to `true`. */
    readonly enableReflection?: boolean;
    /** Also serve the deprecated `vscode.mcp-forward` id. Defaults to `true`. */
    readonly legacyAlias?: boolean;
    readonly log?: (line: string) => void;
}

/**
 * Serve `mcp.forward` under `serviceId`: every `connect` leg gets its own
 * upstream MCP session of the selected MCP identity (exclusive forwarding: a
 * new process for stdio, a new MCP session for HTTP) and relays MCP JSON-RPC
 * messages verbatim in both directions.
 */
export function serveMcpForward(options: ServeMcpForwardOptions): InterfaceRegistration {
    const log = options.log ?? ((line: string) => console.error(line));
    const handlers = {
        connect: (params: { mcpIdentity?: string }, _ctx: unknown, stream: ForwardLegStream) => {
            const identityId = resolveMcpIdentity(options.identities, params.mcpIdentity);
            const authentication = options.identities.authentication(identityId);
            if (authentication.status === "authorization-required") {
                throw new RpcError(
                    `MCP identity '${identityId}' requires authorization at ${authentication.authorizationUri}`,
                    ErrorCode.invalidRequest,
                );
            }
            return runForwardLeg(options.identities.upstream(identityId), stream, log);
        },
    };
    const registrations: InterfaceRegistration[] = [];
    // Register handlers before enabling reflection so a discovered service can always be connected.
    registrations.push(options.connection.register(mcpForwardInterface, handlers, { serviceId: options.serviceId }));
    if (options.legacyAlias !== false) {
        registrations.push(options.connection.register(legacyMcpForwardInterface, handlers, { serviceId: options.serviceId }));
    }
    if (options.enableReflection !== false) {
        registrations.push(options.connection.enableReflection({ serviceId: options.serviceId }));
    }
    return {
        dispose: () => {
            for (const registration of registrations.reverse()) registration.dispose();
        },
    };
}

/** The server side of one `mcp.forward::connect` stream. */
export interface ForwardLegStream {
    send(payload: { frame: unknown }): Promise<void>;
    onMessage(listener: (payload: { frame: unknown }) => void): void;
    readonly signal: AbortSignal;
}

/**
 * Relay one MCP session between `stream` and a fresh upstream transport until
 * either side ends it. Never rejects: upstream failures end the leg.
 */
export async function runForwardLeg(
    upstream: McpUpstream,
    stream: ForwardLegStream,
    log: (line: string) => void,
): Promise<Record<string, never>> {
    let transport: Transport;
    try {
        transport = await upstream.createTransport();
    } catch (error) {
        log(`mcp-forward: cannot create upstream ${upstream.label}: ${errorMessage(error)}`);
        return {};
    }
    return new Promise((resolve) => {
        let settled = false;
        // Remembered so the negotiated protocol version can be applied to transports
        // that send it as a header (Streamable HTTP); a forwarder has no MCP client.
        let initializeRequestId: RequestId | undefined;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            stream.signal.removeEventListener("abort", finish);
            void closeUpstream(transport).catch((error: unknown) => {
                log(`mcp-forward: cannot close upstream ${upstream.label}: ${errorMessage(error)}`);
            });
            resolve({});
        };

        transport.onmessage = (message: JSONRPCMessage) => {
            if (settled) return;
            if (initializeRequestId !== undefined && "id" in message && message.id === initializeRequestId) {
                initializeRequestId = undefined;
                const version = "result" in message ? message.result.protocolVersion : undefined;
                if (typeof version === "string") transport.setProtocolVersion?.(version);
            }
            void stream.send({ frame: message }).catch(() => { /* the leg is ending */ });
        };
        transport.onerror = (error: Error) => log(`mcp-forward: upstream ${upstream.label}: ${error.message}`);
        transport.onclose = finish;

        const started = transport.start();
        started.catch((error: unknown) => {
            log(`mcp-forward: cannot start upstream ${upstream.label}: ${errorMessage(error)}`);
            finish();
        });
        stream.onMessage(({ frame }) => {
            const parsed = JSONRPCMessageSchema.safeParse(frame);
            if (!parsed.success) {
                log(`mcp-forward: dropped an invalid MCP message from the caller: ${parsed.error.message}`);
                return;
            }
            const message = parsed.data;
            if ("method" in message && message.method === "initialize" && "id" in message) {
                initializeRequestId = message.id;
            }
            // `then` callbacks run in registration order, so frames sent before
            // the upstream finished starting keep their order.
            void started.then(() => {
                if (!settled) return transport.send(message);
            }).catch((error: unknown) => {
                log(`mcp-forward: cannot send to upstream ${upstream.label}: ${errorMessage(error)}`);
            });
        });

        if (stream.signal.aborted) finish();
        else stream.signal.addEventListener("abort", finish, { once: true });
    });
}

async function closeUpstream(transport: Transport): Promise<void> {
    const terminable = transport as Transport & { terminateSession?: () => Promise<void> };
    if (terminable.terminateSession !== undefined && transport.sessionId !== undefined) {
        await terminable.terminateSession().catch(() => { /* best effort: the server may be gone */ });
    }
    await transport.close();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
