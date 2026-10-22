import {
    ErrorCode,
    type IncomingCall,
    type IRequestHandler,
    type JsonValue,
    RpcError,
    type SigningCallCtx,
} from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import { hubServiceIdRegistryInterface } from '@hediet/linkrpc/hub/common';
import type { CliConnection } from '@hediet/linkrpc-client-internal';

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

/**
 * How calls the participant emits reach the hub:
 * - `signed`: re-sent under the proxy's own principal (managed identity +
 *   capability negotiation), so an unsigned participant can call gated
 *   services.
 * - `verbatim`: forwarded unsigned, preserving any `$hubrpc` envelope the
 *   participant attached itself.
 * - `none`: not forwarded.
 */
export type OutboundForwarding = 'signed' | 'verbatim' | 'none';

export interface ProxyOptions {
    /** Live connection to the hub. Outbound `signed` calls use its signer. */
    readonly hub: CliConnection;
    /** Live connection to the participant the proxy stands in for. */
    readonly participant: CliConnection;
    /** Claim this service id on the hub and forward its requests verbatim to the participant. */
    readonly claimServiceId?: string;
    readonly outbound: OutboundForwarding;
    /**
     * Resolves to stop the proxy (e.g. when the participant disconnects). When
     * omitted, the proxy runs until the process is signalled (`SIGINT` / `SIGTERM`).
     */
    readonly stop?: Promise<void>;
    /** Sink for human-readable status lines (defaults to stderr). */
    readonly log?: (line: string) => void;
}

/**
 * Stand in for a participant on the hub until stopped.
 *
 * Requests the hub routes to this connection (e.g. for
 * {@link ProxyOptions.claimServiceId}) are forwarded verbatim to the
 * participant: the original caller's `$hubrpc` envelope rides inside `params`,
 * so it is not re-wrapped. Calls the participant emits are forwarded to the hub
 * according to {@link ProxyOptions.outbound}. The streaming sub-protocol is
 * bridged both ways, so long-running / streaming calls forward their in-flight
 * stream messages and cancellation, not just the final response.
 */
export async function proxyCommand(opts: ProxyOptions): Promise<void> {
    const log = opts.log ?? ((line) => process.stderr.write(line + '\n'));

    // Bind the catch-all forwarders BEFORE claiming so no request can race in
    // between the claim landing and the handler being installed.
    opts.hub.setRequestHandler(createForwardingHandler(opts.participant));
    if (opts.outbound !== 'none') {
        opts.participant.setRequestHandler(createForwardingHandler(opts.hub, opts.outbound));
    }

    if (opts.claimServiceId !== undefined) {
        await _claimServiceId(opts.hub, opts.claimServiceId);
        log(`proxy: claimed '${opts.claimServiceId}' — forwarding its requests to the participant unchanged`);
    }
    log({
        signed: 'proxy: forwarding participant calls to the hub, signed as the identity above',
        verbatim: 'proxy: forwarding participant calls to the hub as they are (not signed by the proxy)',
        none: 'proxy: dropping participant calls',
    }[opts.outbound]);

    await (opts.stop ?? _untilSignalled());
    log('proxy: stopping');
}

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
 * Run a transparent service tunnel until stopped: a {@link proxyCommand} that
 * claims `serviceId` and, with `bidi`, forwards the endpoint's calls verbatim.
 */
export async function tunnelCommand(opts: TunnelOptions): Promise<void> {
    await proxyCommand({
        hub: opts.local,
        participant: opts.remote,
        claimServiceId: opts.serviceId,
        outbound: opts.bidi ? 'verbatim' : 'none',
        ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
        ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
}

/**
 * Build the inbound handler that forwards every request/notification received
 * on one connection onto `to`, bridging the streaming sub-protocol both ways
 * (see {@link _forwardRequest}). `signing` selects whether forwarded calls are
 * sent verbatim (default) or signed by `to`'s signer.
 */
export function createForwardingHandler(
    to: CliConnection,
    signing: Exclude<OutboundForwarding, 'none'> = 'verbatim',
): IRequestHandler {
    // `signerOverride: null` forwards verbatim: an inbound `$hubrpc` envelope
    // (if any) is preserved instead of being re-signed.
    const ctx: SigningCallCtx = signing === 'verbatim' ? { signerOverride: null } : {};
    return {
        handleRequest: (call) => _forwardRequest(to, call, ctx),
        handleNotification: (call) => _forwardNotification(to, call, ctx),
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
    ctx: SigningCallCtx,
): Promise<{ result: JsonValue; } | { error: { code: number; message: string; data?: JsonValue; }; }> {
    // Bridge the streaming sub-protocol both ways so long-running / streaming
    // calls forward transparently, not just their final response:
    //   - callee → caller progress: relayed via `onStreamMessage` → `call.stream.send`
    //   - caller → callee input: relayed via `call.stream.onMessage` → `rc.send`
    //   - caller cancellation (disconnect / idle / explicit): via `call.signal` → `rc.cancel`
    const rc = remote.channel.sendRequestWithStream(call.method, call.params, {
        ctx,
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

function _forwardNotification(remote: CliConnection, call: IncomingCall, ctx: SigningCallCtx): void {
    void remote.channel
        .sendNotification(call.method, call.params, { ctx })
        .catch(() => { /* notifications are fire-and-forget */ });
}