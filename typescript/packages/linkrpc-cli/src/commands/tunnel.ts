import { ErrorCode, type IncomingCall, type IRequestHandler, type JsonValue, RpcError } from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import { hubServiceIdRegistryInterface } from '@hediet/linkrpc/hub/common';
import type { CliConnection } from '@hediet/linkrpc-client';

/**
 * The wire method for the provenance claim front door. Mirrors
 * `Hub.registerServiceIdNamespace`, which calls
 * `connection.get(hubGrantedServiceIdInterface).register({ serviceId })`
 * with no serviceId prefix — i.e. interface-form
 * `hubGrantedServiceId::register`. The claimed serviceId must be
 * within the connection's granted namespace.
 */
const CLAIM_METHOD = `${hubGrantedServiceIdInterface.info.id}::register`;
const GET_CLAIM_NAMESPACE_METHOD = `${hubGrantedServiceIdInterface.info.id}::get`;
const GET_HUB_SERVICE_ID_METHOD = `${hubGrantedServiceIdInterface.info.id}::getHubServiceId`;

export interface TunnelOptions {
    readonly serviceId: string;
    /** Live connection to the hub we claim `serviceId` on and receive requests from. */
    readonly local: CliConnection;
    /** Live connection to the endpoint we forward every received request to. */
    readonly remote: CliConnection;
    /**
     * When set, also forward every request/notification the {@link remote}
     * endpoint emits back to {@link local} (the hub), exposing the hub to the
     * endpoint. Forwards everything verbatim (unsigned).
     */
    readonly bidi?: boolean;
    /**
     * Resolves to stop the tunnel (e.g. on SIGINT). When omitted, the tunnel
     * runs until the process is signalled (`SIGINT` / `SIGTERM`).
     */
    readonly stop?: Promise<void>;
    /** Sink for human-readable status lines (defaults to stderr). */
    readonly log?: (line: string) => void;
}

/**
 * Run a transparent service tunnel until stopped.
 *
 * Claims `serviceId` on {@link TunnelOptions.local} via the hub claim
 * interface, then forwards every inbound request/notification verbatim onto
 * {@link TunnelOptions.remote} and pipes the response back. Forwarding is
 * signature-preserving: the original caller's `$linkrpc` envelope rides inside
 * `params`, so the remote send is issued unsigned (`signerOverride: null`) to
 * avoid re-wrapping it. The streaming sub-protocol is bridged both ways, so
 * long-running / streaming calls forward their in-flight stream messages and
 * cancellation, not just the final response.
 *
 * When {@link TunnelOptions.bidi} is set, the mirror forwarder is also bound on
 * {@link TunnelOptions.remote}, so every request/notification the endpoint
 * emits is forwarded verbatim back to the hub.
 *
 * Resolves when {@link TunnelOptions.stop} resolves (or on `SIGINT`/`SIGTERM`).
 */
export async function tunnelCommand(opts: TunnelOptions): Promise<void> {
    const log = opts.log ?? ((line) => process.stderr.write(line + '\n'));

    // Bind the catch-all forwarder BEFORE claiming so no request can race in
    // between the claim landing and the handler being installed.
    opts.local.setRequestHandler(createForwardingHandler(opts.remote));

    // When bidirectional, mirror the forwarder on the remote so every request
    // and notification the endpoint emits is routed back to the source hub.
    if (opts.bidi) {
        opts.remote.setRequestHandler(createForwardingHandler(opts.local));
    }

    // Claim via root namespace when in-namespace, otherwise via the hub-level
    // service id registry.
    await _claimServiceId(opts.local, opts.serviceId);
    log(
        opts.bidi
            ? `tunnel: claimed '${opts.serviceId}' — forwarding requests to remote (bidirectional)`
            : `tunnel: claimed '${opts.serviceId}' — forwarding requests to remote`,
    );

    await (opts.stop ?? _untilSignalled());
    log('tunnel: stopping');
}

/**
 * Build the inbound handler that forwards every request/notification received
 * on one connection onto `to`, bridging the streaming sub-protocol both ways
 * (see {@link _forwardRequest}). Used for the source→target direction and, in
 * bidirectional mode, the mirror.
 */
export function createForwardingHandler(to: CliConnection): IRequestHandler {
    return {
        handleRequest: (call) => _forwardRequest(to, call),
        handleNotification: (call) => _forwardNotification(to, call),
    };
}

async function _claimServiceId(local: CliConnection, serviceId: string): Promise<void> {
    const namespaceRes = await local.channel.sendRequest(GET_CLAIM_NAMESPACE_METHOD, {});
    const grantedNamespace =
        typeof namespaceRes === 'object'
        && namespaceRes !== null
        && 'grantedServiceIdNamespace' in namespaceRes
        && typeof (namespaceRes as { grantedServiceIdNamespace?: unknown; }).grantedServiceIdNamespace === 'string'
            ? (namespaceRes as { grantedServiceIdNamespace: string; }).grantedServiceIdNamespace
            : '';

    if (_isServiceIdUnder(serviceId, grantedNamespace)) {
        await local.channel.sendRequest(CLAIM_METHOD, { serviceId });
        return;
    }

    const hubIdRes = await local.channel.sendRequest(GET_HUB_SERVICE_ID_METHOD, {});
    const hubServiceId =
        typeof hubIdRes === 'object'
        && hubIdRes !== null
        && 'hubServiceId' in hubIdRes
        && typeof (hubIdRes as { hubServiceId?: unknown; }).hubServiceId === 'string'
            ? (hubIdRes as { hubServiceId: string; }).hubServiceId
            : undefined;
    if (!hubServiceId) {
        throw new Error('tunnel: failed to resolve hub service id for out-of-namespace claim');
    }

    const registerMethod = `${hubServiceId}::${hubServiceIdRegistryInterface.info.id}::registerServiceId`;
    await local.channel.sendRequest(registerMethod, { requestedPrefix: serviceId });
}

function _isServiceIdUnder(serviceId: string, namespace: string): boolean {
    if (namespace === '') return false;
    return serviceId === namespace || serviceId.startsWith(`${namespace}/`);
}

/** Resolve on the next `SIGINT` / `SIGTERM`. */
function _untilSignalled(): Promise<void> {
    return new Promise<void>((resolve) => {
        const done = (): void => {
            process.removeListener('SIGINT', done);
            process.removeListener('SIGTERM', done);
            resolve();
        };
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
    });
}

async function _forwardRequest(
    remote: CliConnection,
    call: IncomingCall,
): Promise<{ result: JsonValue; } | { error: { code: number; message: string; data?: JsonValue; }; }> {
    // Bridge the streaming sub-protocol both ways so long-running / streaming
    // calls forward transparently, not just their final response:
    //   - callee → caller progress: relayed via `onStreamMessage` → `call.stream.send`
    //   - caller → callee input: relayed via `call.stream.onMessage` → `rc.send`
    //   - caller cancellation (disconnect / idle / explicit): via `call.signal` → `rc.cancel`
    // `signerOverride: null` forwards verbatim: the inbound `$linkrpc` envelope
    // (if any) is preserved instead of being re-signed.
    const rc = remote.channel.sendRequestWithStream(call.method, call.params, {
        ctx: { signerOverride: null },
        onStreamMessage: (payload) => { void call.stream.send(payload); },
    });
    call.stream.onMessage((payload) => rc.send(payload));
    const cancelRemote = (): void => rc.cancel((call.signal.reason as Error | undefined)?.message);
    if (call.signal.aborted) {
        cancelRemote();
    } else {
        call.signal.addEventListener('abort', cancelRemote, { once: true });
    }
    try {
        const result = await rc.result;
        return { result };
    } catch (err) {
        if (err instanceof RpcError) {
            return { error: { code: err.code, message: err.message, data: err.data } };
        }
        return {
            error: { code: ErrorCode.internalError, message: (err as Error).message },
        };
    }
}

function _forwardNotification(remote: CliConnection, call: IncomingCall): void {
    void remote.channel
        .sendNotification(call.method, call.params, { ctx: { signerOverride: null } })
        .catch(() => { /* notifications are fire-and-forget */ });
}