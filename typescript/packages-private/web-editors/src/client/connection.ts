import { Channel, LinkRpcConnection, JsonRpcChannel } from "@hediet/linkrpc";
import { createManagedSigningChannel } from "@hediet/linkrpc/hub/common";
import { WindowMessageTransport } from "@hediet/linkrpc/web";

/**
 * Accepted `connection` inputs for the editor-side clients.
 *
 * - A ready {@link LinkRpcConnection} — used as-is.
 * - The literal `"windowParent"` — the client builds a connection over a
 *   {@link WindowMessageTransport} talking to `window.parent`. This lets an
 *   app avoid depending on `@hediet/linkrpc` directly.
 */
export type ConnectionInput = LinkRpcConnection | "windowParent";

/**
 * Create a {@link Channel} wired to the parent window via
 * {@link WindowMessageTransport}. Use inside an iframe whose host is the
 * embedding (parent) window.
 */
function createWindowParentChannel(): Channel<undefined> {
    return JsonRpcChannel.create(new WindowMessageTransport(window, window.parent));
}

/**
 * Create a {@link LinkRpcConnection} wired to the parent window via
 * {@link WindowMessageTransport}. Use inside an iframe whose host is the
 * embedding (parent) window.
 */
export function createWindowParentConnection(): LinkRpcConnection {
    return new LinkRpcConnection(createWindowParentChannel());
}

/** Normalize a {@link ConnectionInput} into a concrete {@link LinkRpcConnection}. */
export function resolveConnection(input: ConnectionInput): LinkRpcConnection {
    return input === "windowParent" ? createWindowParentConnection() : input;
}

/**
 * A resolved host connection, plus the ability to obtain a *signed* send-only
 * connection (managed identity) for the rare cap-gated call that needs one
 * (e.g. registering the app as the default editor for a file type).
 *
 * The main {@link connection} is left unsigned — the vast majority of calls
 * don't need an identity, and signing every call would force a managed-identity
 * handshake on connect. The signed path is built lazily, only when a cap-gated
 * call actually asks for it.
 */
export class HostConnection {
    /**
     * Build from a {@link ConnectionInput}. When `"windowParent"`, we retain
     * the underlying {@link Channel} so a managed-identity signing layer can be
     * added later over the *same* transport. When given a ready
     * {@link LinkRpcConnection}, the signed path is unavailable (we have no
     * channel to wrap).
     */
    public static from(input: ConnectionInput): HostConnection {
        if (input === "windowParent") {
            const channel = createWindowParentChannel();
            return new HostConnection(new LinkRpcConnection(channel), channel);
        }
        return new HostConnection(input, undefined);
    }

    private _signed: Promise<LinkRpcConnection> | undefined;

    private constructor(
        /** The primary (unsigned) connection to the host. */
        public readonly connection: LinkRpcConnection,
        private readonly _channel: Channel<undefined> | undefined,
    ) { }

    /**
     * A send-only connection whose outbound calls are signed with a managed
     * identity. Built lazily and memoized — only set up when a cap-gated call
     * (e.g. registering as the default editor) actually needs it.
     *
     * Shares the underlying transport with {@link connection} and never binds
     * an inbound handler (the main connection owns the receive side); response
     * correlation happens in the shared `JsonRpcChannel`.
     */
    public getSignedConnection(): Promise<LinkRpcConnection> {
        const channel = this._channel;
        if (channel === undefined) {
            throw new Error(
                "A signed connection is only available when the client built the connection itself "
                + "(connection: \"windowParent\").",
            );
        }
        return (this._signed ??= this._buildSigned(channel));
    }

    private async _buildSigned(channel: Channel<undefined>): Promise<LinkRpcConnection> {
        const { channel: signed } = await createManagedSigningChannel(channel, {
            autoNegotiateCaps: true,
            consumer: { name: "VS Code app" },
        });
        // Send-only: hand the signing *sender* (not the Channel) to the
        // connection so it does not rebind the shared inbound handler that the
        // main connection already owns.
        return new LinkRpcConnection(signed.sender);
    }
}
