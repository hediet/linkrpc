import { ErrorCode, RpcError, type IMessageTransport, type JsonValue } from '@hediet/linkrpc';
import { nodeInterface, type NodeInfo } from '@hediet/linkrpc/hub/common';
import { safeParse } from 'zod/v4/core';

export const GET_NODE_ID_METHOD = `${nodeInterface.info.id}::getNodeId`;

interface PeerState {
    info?: NodeInfo;
    status: 'identified' | 'pending' | 'unsupported' | 'error';
    attempt?: Promise<NodeInfo>;
    timer?: ReturnType<typeof setTimeout>;
    retryDelayMs: number;
}

interface PeerDiscoveryOptions {
    readonly timeoutMs?: number;
    readonly request: (link: IMessageTransport, timeoutMs: number) => Promise<JsonValue | undefined>;
    readonly onDidChange: () => void;
}

/** Background policy for direct-peer identity; forwarding never waits for it. */
export class PeerDiscovery {
    private readonly _peers = new WeakMap<IMessageTransport, PeerState>();
    private readonly _timeoutMs: number;

    constructor(private readonly _options: PeerDiscoveryOptions) {
        this._timeoutMs = _options.timeoutMs ?? 1_000;
        if (!Number.isFinite(this._timeoutMs) || this._timeoutMs <= 0) {
            throw new Error('peerIdentificationTimeoutMs must be a positive finite number');
        }
    }

    public attach(link: IMessageTransport): void {
        if (this._peers.has(link)) return;
        const state: PeerState = { status: 'pending', retryDelayMs: 200 };
        this._peers.set(link, state);
        this._schedule(link, state, 0);
    }

    public detach(link: IMessageTransport): void {
        const state = this._peers.get(link);
        if (state?.timer !== undefined) clearTimeout(state.timer);
        this._peers.delete(link);
        // The request owner cancels/settles in-flight requests on detach.
    }

    public info(link: IMessageTransport): NodeInfo | undefined {
        return this._peers.get(link)?.info;
    }

    public status(link: IMessageTransport): PeerState['status'] {
        return this._peers.get(link)?.status ?? 'pending';
    }

    public identify(link: IMessageTransport): Promise<NodeInfo> {
        const state = this._peers.get(link);
        if (state === undefined) return Promise.reject(new Error('identifyPeer: link is detached'));
        if (state.info !== undefined) return Promise.resolve(state.info);
        if (state.attempt !== undefined) return state.attempt;
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.timer = undefined;

        // Defer dispatch so even a synchronous transport cannot reenter before
        // the in-flight attempt has been registered.
        const attempt = Promise.resolve().then(async () => {
            if (this._peers.get(link) !== state) throw new Error('identifyPeer: link is detached');
            const raw = await this._options.request(link, this._timeoutMs);
            const parsed = safeParse(nodeInterface.members.getNodeId.resultSchema, raw);
            if (!parsed.success || parsed.data.nodeId.length === 0 || parsed.data.portId.length === 0) {
                throw new Error(`identifyPeer: invalid result from ${GET_NODE_ID_METHOD}`);
            }
            const info = parsed.data;
            if (this._peers.get(link) !== state) throw new Error('identifyPeer: link is detached');
            state.info = info;
            state.status = 'identified';
            this._options.onDidChange();
            return info;
        }).catch((error: unknown) => {
            if (this._peers.get(link) === state) {
                const status = error instanceof RpcError && error.code === ErrorCode.methodNotFound
                    ? 'unsupported' : 'error';
                if (state.status !== status) {
                    state.status = status;
                    this._options.onDidChange();
                }
                const delay = state.status === 'unsupported' ? 30_000 : state.retryDelayMs;
                state.retryDelayMs = Math.min(5_000, state.retryDelayMs * 2);
                this._schedule(link, state, delay * (0.8 + Math.random() * 0.4));
            }
            throw new Error(
                `identifyPeer: ${GET_NODE_ID_METHOD} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                { cause: error },
            );
        }).finally(() => {
            state.attempt = undefined;
        });
        state.attempt = attempt;
        return attempt;
    }

    private _schedule(link: IMessageTransport, state: PeerState, delayMs: number): void {
        if (this._peers.get(link) !== state) return;
        state.timer = setTimeout(() => {
            state.timer = undefined;
            if (this._peers.get(link) !== state) return;
            // Failures are exposed through peerState and retried by identify().
            void this.identify(link).catch(() => {});
        }, delayMs);
        state.timer.unref();
    }
}
