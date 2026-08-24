import type { JsonRpcMessage } from "../protocol/jsonRpc";
import type { IMessageTransport } from "./messageTransport";
import type { IDisposable } from '../disposable';

export interface MuxEnvelope {
    readonly $mux: "v1";
    readonly ch: string;
    readonly m: JsonRpcMessage;
}

export class MultiplexedTransport<TChannels extends Record<string, string>> implements IDisposable {
    public static create<TChannels extends Record<string, string>>(
        base: IMessageTransport<MuxEnvelope, MuxEnvelope>,
        channels: TChannels,
    ): MultiplexedTransport<TChannels> {
        return new MultiplexedTransport(base, channels);
    }

    /** Logical transports keyed by the friendly channel names. */
    public readonly transports: { readonly [K in keyof TChannels]: IMessageTransport };

    private readonly _base: IMessageTransport<MuxEnvelope, MuxEnvelope>;
    private readonly _byId = new Map<string, _ChannelTransport>();
    private readonly _usedIds = new Set<string>();
    private _disposed = false;

    constructor(base: IMessageTransport<MuxEnvelope, MuxEnvelope>, channels: TChannels) {
        this._base = base;
        const transports = {} as { [K in keyof TChannels]: _ChannelTransport };

        for (const name of Object.keys(channels) as (keyof TChannels)[]) {
            const id = channels[name];
            const t = this._createChannel(id);
            transports[name] = t;
        }
        this.transports = transports;

        base.setListener((data) => {
            // Route purely by channel id. Concrete transports own their own
            // framing, so we don't re-validate the envelope shape here; anything
            // that doesn't carry a known channel id is simply ignored.
            const t = data == null ? undefined : this._byId.get(data.ch);
            t?._deliver(data.m);
        });
    }

    /**
     * Add a logical channel after the multiplexer has started.
     *
     * Channel ids are permanently retired when disposed. This prevents a late
     * envelope for an old iframe from being delivered to a replacement iframe.
     */
    public addChannel(id: string): IMessageTransport {
        if (this._disposed) {
            throw new Error("Cannot add a channel to a disposed multiplexed transport.");
        }
        return this._createChannel(id);
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._base.setListener(undefined);
        for (const t of [...this._byId.values()]) t.dispose();
        this._byId.clear();
    }

    private _createChannel(id: string): _ChannelTransport {
        if (id.length === 0) {
            throw new Error("Multiplexed transport channel ids must not be empty.");
        }
        if (this._usedIds.has(id)) {
            throw new Error(`Multiplexed transport channel id "${id}" has already been used.`);
        }

        this._usedIds.add(id);
        const t = new _ChannelTransport(this._base, id, () => {
            if (this._byId.get(id) === t) {
                this._byId.delete(id);
            }
        });
        this._byId.set(id, t);
        return t;
    }
}

class _ChannelTransport implements IMessageTransport {
    private _listener: ((m: JsonRpcMessage) => void) | undefined;
    private readonly _buffer: JsonRpcMessage[] = [];
    private _closed = false;

    constructor(
        private readonly _base: IMessageTransport<MuxEnvelope, MuxEnvelope>,
        private readonly _ch: string,
        private readonly _onDispose: () => void,
    ) { }

    send(message: JsonRpcMessage): void {
        if (this._closed) return;
        void this._base.send({ $mux: "v1", ch: this._ch, m: message });
    }

    setListener(listener: ((m: JsonRpcMessage) => void) | undefined): void {
        this._listener = listener;
        if (listener) {
            while (this._buffer.length > 0 && this._listener) {
                listener(this._buffer.shift()!);
            }
        }
    }

    dispose(): void {
        if (this._closed) return;
        this._closed = true;
        this._listener = undefined;
        this._buffer.length = 0;
        this._onDispose();
    }

    _deliver(m: JsonRpcMessage): void {
        if (this._closed) return;
        if (this._listener) this._listener(m);
        else this._buffer.push(m);
    }
}
