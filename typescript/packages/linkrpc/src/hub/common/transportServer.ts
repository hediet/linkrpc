import type { IMessageTransport } from '../../index';
import type { TopologyTransportInfo } from '../../inspection/inspection.interfaces';

/**
 * A link the hub can route, plus a close signal. {@link IMessageTransport}
 * on its own has no "closed" event (it only learns of teardown through its
 * own `dispose`), but a *server*-produced connection must be able to tell
 * downstream consumers when the remote end goes away so overlays can be torn
 * down and prefixes released. {@link Transport} adds exactly that.
 */
export interface Transport extends IMessageTransport {
    /** Optional diagnostics surfaced on the corresponding topology link. Never include credentials or payloads. */
    readonly topologyInfo?: TopologyTransportInfo;
    /**
     * Register a handler fired exactly once when the transport closes (remote
     * hang-up or local {@link IMessageTransport.dispose}). Handlers added
     * after close fire on the next microtask.
     */
    onDidClose(handler: () => void): void;
}

/**
 * A source of inbound {@link Transport}s — the single seam every transport
 * backend (UDS socket, websocket, iframe postMessage, in-process pair)
 * implements. The hub side consumes only this; it never names `net.Socket`
 * or any backend-specific type.
 */
export interface ITransportServer<T extends Transport> {
    /**
     * Install the handler invoked once per accepted transport. Replacing the
     * handler is allowed; only the most recent one receives new connections.
     */
    setConnectionHandler(handler: (transport: T) => void): void;
    dispose(): void;
}

/**
 * Lift a transport server from emitting `T1` to emitting `T2`. The `map` may
 * be async (e.g. to attest a peer before exposing it) and may return
 * `undefined` to **drop** a connection — the downstream handler is simply not
 * invoked for it. The transport's identity is preserved when the map returns
 * the same object (important: the hub keys routing state on the transport
 * reference), so prefer annotating in place over wrapping.
 */
export function mapTransport<T1 extends Transport, T2 extends Transport>(
    source: ITransportServer<T1>,
    map: (transport: T1) => T2 | undefined | Promise<T2 | undefined>,
): ITransportServer<T2> {
    return new MappedTransportServer(source, map);
}

class MappedTransportServer<T1 extends Transport, T2 extends Transport>
    implements ITransportServer<T2>
{
    private _handler: ((transport: T2) => void) | undefined;
    private _wired = false;

    constructor(
        private readonly _source: ITransportServer<T1>,
        private readonly _map: (t: T1) => T2 | undefined | Promise<T2 | undefined>,
    ) {}

    public setConnectionHandler(handler: (transport: T2) => void): void {
        this._handler = handler;
        if (this._wired) {
            return;
        }
        this._wired = true;
        this._source.setConnectionHandler((t1) => {
            void this._onIncoming(t1);
        });
    }

    private async _onIncoming(t1: T1): Promise<void> {
        const t2 = await this._map(t1);
        if (t2 !== undefined && this._handler) {
            this._handler(t2);
        }
    }

    public dispose(): void {
        this._source.dispose();
    }
}
