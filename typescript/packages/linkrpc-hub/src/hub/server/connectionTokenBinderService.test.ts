import { describe, expect, it } from 'vitest';
import {
    LinkRpcConnection,
    type IMessageTransport,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    TransportPair,
} from '@hediet/linkrpc';
import { registerConnectionTokenBinderService } from './connectionTokenBinderService';
import { TokenIdentityStore } from './tokenIdentityStore';

class TestClient {
    private _nextId = 100;
    private readonly _pending = new Map<string, (r: JsonRpcResponse) => void>();
    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((m) => this._onMessage(m));
    }
    public sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
        const id = this._nextId++;
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params as never };
        const p = new Promise<JsonRpcResponse>((resolve) => this._pending.set(String(id), resolve));
        this.transport.send(req);
        return p;
    }
    private _onMessage(m: JsonRpcMessage): void {
        const id = (m as { id?: number | string | null }).id;
        if (id !== undefined && id !== null && 'method' in m === false) {
            const resolve = this._pending.get(String(id));
            if (resolve) {
                this._pending.delete(String(id));
                resolve(m as JsonRpcResponse);
            }
        }
    }
}

function serve(
    opts: { identitySlotPrefixes?: readonly string[]; serviceIdPrefixes?: readonly string[] },
    store = new TokenIdentityStore(),
): { client: TestClient; store: TokenIdentityStore } {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    registerConnectionTokenBinderService(server, {
        store,
        identitySlotPrefixes: opts.identitySlotPrefixes ?? [],
        serviceIdPrefixes: opts.serviceIdPrefixes ?? [],
    });
    return { client: new TestClient(pair.b), store };
}

const METHOD = 'connectionTokenBinder::bindConnectionToken';

function result(res: JsonRpcResponse): { token: string; expiresAt: number } {
    return (res as unknown as { result: { token: string; expiresAt: number } }).result;
}
function errorMessage(res: JsonRpcResponse): string {
    return (res as unknown as { error: { message: string } }).error.message;
}

describe('connectionTokenBinder::bindConnectionToken', () => {
    it('mints a token binding identity + serviceId when both under their prefixes', async () => {
        const { client, store } = serve({ identitySlotPrefixes: ['docker/'], serviceIdPrefixes: ['docker/'] });
        const res = await client.sendRequest(METHOD, {
            identitySlot: 'docker/echo-provider',
            serviceIdNamespace: 'docker/echo-provider',
        });
        expect('result' in res).toBe(true);
        expect(typeof result(res).token).toBe('string');
        expect(store.redeem(result(res).token)).toEqual({
            identitySlot: 'docker/echo-provider',
            grantedServiceIdNamespace: 'docker/echo-provider',
        });
    });

    it('binds each axis independently (identity only)', async () => {
        const { client, store } = serve({ identitySlotPrefixes: ['docker/'] });
        const res = await client.sendRequest(METHOD, { identitySlot: 'docker/echo' });
        expect('result' in res).toBe(true);
        expect(store.redeem(result(res).token)).toEqual({ identitySlot: 'docker/echo' });
    });

    it('binds each axis independently (serviceId only)', async () => {
        const { client, store } = serve({ serviceIdPrefixes: ['svc/'] });
        const res = await client.sendRequest(METHOD, { serviceIdNamespace: 'svc/echo' });
        expect('result' in res).toBe(true);
        expect(store.redeem(result(res).token)).toEqual({ grantedServiceIdNamespace: 'svc/echo' });
    });

    it('rejects an identitySlot outside the granted prefix', async () => {
        const { client, store } = serve({ identitySlotPrefixes: ['docker/'] });
        const res = await client.sendRequest(METHOD, { identitySlot: 'k8s/pod-7' });
        expect('error' in res).toBe(true);
        expect(errorMessage(res)).toContain('identitySlotPrefix');
        expect(store.size).toBe(0);
    });

    it('rejects a serviceIdNamespace outside the granted prefix', async () => {
        const { client, store } = serve({ serviceIdPrefixes: ['docker/'] });
        const res = await client.sendRequest(METHOD, { serviceIdNamespace: 'k8s/pod-7' });
        expect('error' in res).toBe(true);
        expect(errorMessage(res)).toContain('serviceIdPrefix');
        expect(store.size).toBe(0);
    });

    it('rejects an identitySlot when identity binding is disabled (no prefixes)', async () => {
        const { client, store } = serve({ serviceIdPrefixes: ['docker/'] });
        const res = await client.sendRequest(METHOD, { identitySlot: 'docker/echo' });
        expect('error' in res).toBe(true);
        expect(errorMessage(res)).toContain('identitySlotPrefix');
        expect(store.size).toBe(0);
    });

    it('allows the prefix boundary (value === prefix)', async () => {
        const { client } = serve({ identitySlotPrefixes: ['docker/'] });
        const res = await client.sendRequest(METHOD, { identitySlot: 'docker/' });
        expect('result' in res).toBe(true);
    });
});
