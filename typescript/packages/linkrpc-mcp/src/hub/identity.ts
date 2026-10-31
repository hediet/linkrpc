import {
    capabilityFreshAt,
    type IRequestSender,
    type JsonValue,
    type RawStreamingCall,
    type SendOpts,
    type SignedCapability,
    type SigningCallCtx,
    type SigningIdentity,
    type StreamSendOpts,
} from "@hediet/linkrpc";
import type { HubAccessRequest, HubAccessResult } from "@hediet/linkrpc/hub/common";
import type { HubAccess, IConnectionPool, PooledConnection, TraceListener } from "../connectionPool";

export interface DelegatedHubSenderOptions {
    /** Signing channel shared by all delegated principals, e.g. a service's hub connection. */
    readonly channel: IRequestSender<SigningCallCtx>;
    /** The delegated principal every call is signed as. */
    readonly identity: SigningIdentity;
    /** Durable capabilities of the principal, read before every call. */
    readonly capabilities: () => readonly SignedCapability[] | Promise<readonly SignedCapability[]>;
    /** Persist durable (not one-shot) capabilities granted through {@link DelegatedHubSender.requestAccess}. */
    readonly onGranted?: (durable: readonly SignedCapability[]) => Promise<void>;
    /** Runs before every call, e.g. to check that the delegating session is still authorized. */
    readonly beforeSend?: () => Promise<void>;
    /** Capabilities expiring sooner are not presented. Defaults to 30 s. */
    readonly freshnessMarginMs?: number;
}

/**
 * Signs calls as a delegated principal over a channel it does not own: each
 * call carries the principal as signer override and its capabilities as caps
 * override. This lets one service connection act for many principals (one per
 * chat, OAuth grant, or MCP session) without a connection per principal.
 */
export class DelegatedHubSender implements IRequestSender<SigningCallCtx>, HubAccess {
    public static async create(options: DelegatedHubSenderOptions): Promise<DelegatedHubSender> {
        const sender = new DelegatedHubSender(options);
        await sender._refreshCapabilities();
        return sender;
    }

    private _capabilities: readonly SignedCapability[] = [];

    private constructor(private readonly _options: DelegatedHubSenderOptions) {}

    public get principal(): string {
        return this._options.identity.publicSigningIdentity.principal;
    }

    public listGrants(): readonly SignedCapability[] {
        return this._capabilities.filter((capability) => capabilityFreshAt(capability, Date.now()));
    }

    public async requestAccess(request: HubAccessRequest): Promise<HubAccessResult> {
        const raw = await this.sendRequest("hubAccess::requestAccess", {
            consumer: { ...request.consumer, principal: this.principal },
            permissions: request.permissions,
            ...(request.duration !== undefined ? { duration: request.duration } : {}),
        } as never) as unknown as { status: string; capabilities?: SignedCapability[]; reason?: string };
        if (raw.status !== "granted") return { status: raw.status, reason: raw.reason } as HubAccessResult;
        const capabilities = raw.capabilities ?? [];
        const durable = capabilities.filter((capability) => !capability.permissions.some((p) => p.callBind !== undefined));
        if (durable.length > 0) {
            await this._options.onGranted?.(durable);
            await this._refreshCapabilities();
        }
        return { status: "granted", capabilities, addedDurable: durable.length };
    }

    public async sendRequest(method: string, params: JsonValue | undefined, opts?: SendOpts<SigningCallCtx>): Promise<JsonValue> {
        const ctx = await this._prepare(opts);
        return this._options.channel.sendRequest(method, params, { ...opts, ctx });
    }

    public async sendNotification(method: string, params: JsonValue | undefined, opts?: SendOpts<SigningCallCtx>): Promise<void> {
        const ctx = await this._prepare(opts);
        return this._options.channel.sendNotification(method, params, { ...opts, ctx });
    }

    public sendRequestWithStream(
        method: string,
        params: JsonValue | undefined,
        opts?: StreamSendOpts<SigningCallCtx>,
    ): RawStreamingCall {
        const opening = this._prepare(opts).then((ctx) =>
            this._options.channel.sendRequestWithStream(method, params, { ...opts, ctx }));
        // `then` callbacks run in registration order, so operations issued while
        // the call is still being prepared keep their order.
        const enqueue = <T>(operation: (call: RawStreamingCall) => T | Promise<T>): Promise<T> => opening.then(operation);
        return {
            result: opening.then((call) => call.result),
            send: (payload) => enqueue((call) => call.send(payload)),
            cancel: (reason) => enqueue((call) => call.cancel(reason)),
            dispose: (reason) => void enqueue((call) => call.dispose?.(reason)).catch(() => { /* never opened */ }),
            ping: () => enqueue((call) => call.ping()),
        };
    }

    /** The channel belongs to its owner. */
    public close(): void {}

    private async _prepare(opts: SendOpts<SigningCallCtx> | undefined): Promise<SigningCallCtx> {
        await this._options.beforeSend?.();
        await this._refreshCapabilities();
        return { ...opts?.ctx, signerOverride: this._options.identity, capsOverride: this._capabilities };
    }

    private async _refreshCapabilities(): Promise<void> {
        const now = Date.now();
        const margin = this._options.freshnessMarginMs ?? 30_000;
        this._capabilities = (await this._options.capabilities())
            .filter((capability) => capabilityFreshAt(capability, now, margin));
    }
}

/**
 * An {@link IConnectionPool} that always resolves to one channel, for
 * embedders that bind each MCP server instance to one principal. Explicit
 * endpoint arguments are rejected.
 */
export function singleConnectionPool(
    channel: IRequestSender<SigningCallCtx>,
    access: HubAccess,
    label: string,
): IConnectionPool {
    const traceListeners = new Set<TraceListener>();
    const entry: PooledConnection = {
        channel,
        endpoint: label,
        key: label,
        session: access,
        lastResultVal: undefined,
        addTraceListener: (listener) => {
            traceListeners.add(listener);
            return () => traceListeners.delete(listener);
        },
        trace: (line) => {
            for (const listener of traceListeners) {
                try {
                    listener(line);
                } catch { /* listener errors must not break the wire */ }
            }
        },
        dispose: () => {},
    };
    return {
        resolve: async (endpoint) => {
            if (endpoint !== undefined && endpoint !== label) {
                throw new Error("This MCP server cannot connect to other hub endpoints");
            }
            return entry;
        },
        dispose: () => {},
    };
}
