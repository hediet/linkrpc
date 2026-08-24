import {
    type IMessageTransport,
    type IRequestSender,
    type JsonValue,
    JsonRpcChannel,
    type Principal,
    type PublicSigningIdentity,
    type RawStreamingCall,
    type SendOpts,
    type SignedCapability,
    SigningSender,
    type SigningCallCtx,
    type StreamSendOpts,
} from '@hediet/linkrpc';
import { hubAccessInterface } from '@hediet/linkrpc/hub/common';
import type { HubAccessRequest, HubAccessResult } from './hubSigning';

/**
 * The single connection handle the MCP server consumes: a signing request
 * sender (every outbound call is wrapped in a `$linkrpc` signed envelope by the
 * principal) that also surfaces the principal's public identity and its grants.
 *
 * It IS the channel — `sendRequest("svc::iface::member", params)` routes a
 * form-3 hub call. The {@link Principal}'s `capBag` is the live grant list:
 * {@link listGrants} returns its snapshot and {@link requestAccess} grows it.
 *
 * Construct with {@link HubSigningSender.create} from any transport whose peer
 * is (or routes to) a hub — a socket, a websocket, or an in-memory
 * {@link import('@hediet/linkrpc-hub/hub/server').Hub} link.
 */
export class HubSigningSender implements IRequestSender<SigningCallCtx> {
    /**
     * Wrap `transport` in a JSON-RPC channel + signing sender bound to
     * `principal`.
     */
    public static create(
        transport: IMessageTransport,
        principal: Principal,
    ): HubSigningSender {
        const signed = SigningSender.wrapChannel(JsonRpcChannel.create(transport), { principal });
        return new HubSigningSender(signed.sender, principal);
    }

    private constructor(
        private readonly _inner: IRequestSender<SigningCallCtx>,
        private readonly _principal: Principal,
    ) { }

    /** Public identity (nodeId) this connection signs as. Never exposes keys. */
    public get identity(): PublicSigningIdentity {
        return this._principal.identity.publicSigningIdentity;
    }

    /** Snapshot of the durable capabilities currently held (the cap bag). */
    public listGrants(): readonly SignedCapability[] {
        return this._principal.capBag.capabilities;
    }

    /**
     * Request capabilities from the hub through the same signed connection:
     * a `hubAccess::requestAccess` call served at the connection root (never
     * forwarded → never gated, so no `hubAccess` bootstrap cap is needed). Any
     * durable (non-one-shot) caps the hub mints join the principal's cap bag, so
     * subsequent signed calls present them automatically.
     */
    public async requestAccess(req: HubAccessRequest): Promise<HubAccessResult> {
        const method = `${hubAccessInterface.info.id}::requestAccess`;
        const raw = await this._inner.sendRequest(method, {
            consumer: { ...req.consumer, principal: this._principal.id },
            permissions: req.permissions,
            ...(req.duration !== undefined ? { duration: req.duration } : {}),
        } as never);
        const result = raw as unknown as { status: string; capabilities?: SignedCapability[]; reason?: string; };
        if (result.status === 'granted') {
            const capabilities = result.capabilities ?? [];
            const durable = capabilities.filter((c) => !_isOneShotCap(c));
            if (durable.length > 0) await this._principal.capBag.add(...durable);
            return { status: 'granted', capabilities, addedDurable: durable.length };
        }
        return { status: result.status, reason: result.reason };
    }

    public sendRequest(method: string, params: JsonValue | undefined, opts?: SendOpts<SigningCallCtx>): Promise<JsonValue> {
        return this._inner.sendRequest(method, params, opts);
    }

    public sendNotification(method: string, params: JsonValue | undefined, opts?: SendOpts<SigningCallCtx>): Promise<void> {
        return this._inner.sendNotification(method, params, opts);
    }

    public sendRequestWithStream(method: string, params: JsonValue | undefined, opts?: StreamSendOpts<SigningCallCtx>): RawStreamingCall {
        return this._inner.sendRequestWithStream(method, params, opts);
    }

    public close(): void {
        this._inner.close();
    }
}

/** A cap is one-shot when any permission is pinned to a single call via `callBind`. */
function _isOneShotCap(sc: SignedCapability): boolean {
    return sc.permissions.some((p) => p.callBind !== undefined);
}
