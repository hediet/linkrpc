import { connectTransports, type IMessageTransport } from '@hediet/linkrpc';

/**
 * A live transport plus the seams to observe and tear down its underlying
 * resource. `IMessageTransport` itself exposes no close event, so `onClose`
 * bridges the raw socket / child-process lifecycle (mirrors how the docker
 * provenance proxy drives its splice teardown).
 */
export interface TransportHandle {
    readonly transport: IMessageTransport;
    /** Register a callback fired when the underlying resource closes. */
    onClose(cb: () => void): void;
    /** Tear down the transport and its underlying resource. */
    dispose(): void;
}

export interface ConnectAsDeps {
    /**
     * Mint a single-use `hubrpc::initialize` token bound to the target's slot
     * (identity + granted namespace), via a `connectionTokenBinder` service.
     */
    mintToken(): Promise<string>;
    /**
     * Open the **hub-facing** transport, presenting `token` in its initialize
     * handshake so the hub's `{ token: "bound" }` handler redeems it — binding
     * this connection to the slot's identity + granted namespace.
     */
    openHubTransport(token: string): Promise<TransportHandle>;
    /**
     * Open the **target-facing** transport. Either a dial (ws / socket / uri /
     * cmd-stdio) or an accept-one (cmd-env: spawn the child and take the
     * connection it dials back).
     */
    openTargetTransport(): Promise<TransportHandle>;
    /**
     * Optional tap wrapping the target-facing transport so every spliced
     * message is logged. Tapping one edge captures the full bidirectional flow
     * (each message crosses it exactly once), so this is applied to a single
     * side to avoid double-logging.
     */
    tapTarget?(transport: IMessageTransport): IMessageTransport;
    /** Human-readable status sink. */
    log?(line: string): void;
    /** Resolves to stop the proxy (e.g. on SIGINT). */
    stop?: Promise<void>;
}

/**
 * Run a **connect-as** proxy until either side closes (or {@link
 * ConnectAsDeps.stop} resolves).
 *
 * Mints a bound token for a slot, opens the target-facing transport and the
 * hub-facing transport (which redeems the token → this connection *is* the slot
 * on the hub), and splices them message-for-message. The target thereby joins
 * the hub as a first-class participant with the slot's managed identity +
 * granted namespace, without running a local hub and without the target needing
 * to perform the hub handshake itself.
 *
 * Because all traffic crosses the CLI's splice point, {@link
 * ConnectAsDeps.tapTarget} yields complete `--log-messages` observability.
 */
export async function connectAs(deps: ConnectAsDeps): Promise<void> {
    const token = await deps.mintToken();

    const target = await deps.openTargetTransport();
    let hub: TransportHandle;
    try {
        hub = await deps.openHubTransport(token);
    } catch (e) {
        target.dispose();
        throw e;
    }

    const targetTransport = deps.tapTarget
        ? deps.tapTarget(target.transport)
        : target.transport;
    const pipe = connectTransports(targetTransport, hub.transport);

    deps.log?.('connect-as: bridged target ⟷ hub');

    await new Promise<void>((resolve) => {
        let done = false;
        const teardown = (): void => {
            if (done) return;
            done = true;
            pipe.dispose();
            try { target.dispose(); } catch { /* best effort */ }
            try { hub.dispose(); } catch { /* best effort */ }
            resolve();
        };
        target.onClose(teardown);
        hub.onClose(teardown);
        void deps.stop?.then(teardown);
    });

    deps.log?.('connect-as: closed');
}
