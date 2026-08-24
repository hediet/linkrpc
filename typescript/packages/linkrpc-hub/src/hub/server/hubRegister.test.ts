import { describe, expect, it } from 'vitest';
import { KeypairSigningIdentity } from '@hediet/linkrpc';
import {
    type Capability,
    ErrorCode,
    type IMessageTransport,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type Keypair,
    type PrincipalId,
    type Permission,
    principalForPublicKey,
    signCapability,
    signedHash,
    type SignedCapability,
    signParams,
    TransportPair,
} from '@hediet/linkrpc';
import { createHubServiceInterfaces } from './hubServices';
import { withForwardedCallGate } from './forwardedCallGate';
import { Hub } from './routing/routingHub';
import { crypto } from '@hediet/linkrpc';

/** The v2 register front door is reached under the hub's own prefix. */
const REGISTER_METHOD = 'hub::hubServiceIdRegistry::registerServiceId';

/** Tiny test client: send a request and await the matching response. */
class TestClient {
    private _nextId = 100;
    private readonly _pending = new Map<string, { resolve: (r: JsonRpcResponse) => void; }>();

    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((m) => this._onMessage(m));
    }

    public async sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
        const id = this._nextId++;
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params as never };
        const promise = new Promise<JsonRpcResponse>((resolve) => {
            this._pending.set(String(id), { resolve });
        });
        this.transport.send(req);
        return promise;
    }

    private _onMessage(m: JsonRpcMessage): void {
        const id = (m as { id?: number | string | null; }).id;
        if (id !== undefined && id !== null && 'method' in m === false) {
            const p = this._pending.get(String(id));
            if (p) {
                this._pending.delete(String(id));
                p.resolve(m as JsonRpcResponse);
            }
        }
    }
}

interface Identity {
    principal: PrincipalId;
    keypair: Keypair;
    signer: KeypairSigningIdentity;
}

async function makeIdentity(): Promise<Identity> {
    const keypair = await crypto.generateKeypair();
    const nodeId = principalForPublicKey(keypair.publicKey);
    return { principal: nodeId, keypair, signer: new KeypairSigningIdentity(nodeId, keypair.privateKey) };
}

async function makeRegisterCall(id: Identity, prefix: string, capabilities?: SignedCapability[]) {
    return signParams({
        method: REGISTER_METHOD,
        params: { requestedPrefix: prefix },
        signingIdentity: id.signer,
        ...(capabilities !== undefined ? { capabilities } : {}),
    });
}

let _capNonce = 0;
async function issueCap(opts: {
    issuer: Identity;
    audience: PrincipalId;
    permissions: Permission[];
    parents?: SignedCapability[];
}): Promise<SignedCapability> {
    _capNonce += 1;
    const cap: Capability = {
        issuer: opts.issuer.principal,
        audience: opts.audience,
        permissions: opts.permissions,
        nonce: `cap-nonce-${_capNonce}`,
        ...(opts.parents && opts.parents.length > 0
            ? { parentHash: signedHash<Capability>('capability', opts.parents[0]) }
            : {}),
    };
    return signCapability(cap, opts.issuer.signer);
}

/**
 * A permission authorizing the register front door for exactly `prefix`.
 *
 * Authorization now lives at the forwarded-call gate, so the permission targets
 * the register endpoint itself (`hub::hubServiceIdRegistry::registerServiceId`)
 * and narrows the claimable prefix through a `requestedPrefix` param matcher —
 * a capability can restrict any param.
 */
function registerPermissions(prefix: string): Permission[] {
    return [{
        target: {
            serviceId: { exact: 'hub' },
            interfaceId: { exact: 'hubServiceIdRegistry' },
            members: [{ exact: 'registerServiceId' }],
        },
        params: { requestedPrefix: { exact: prefix } },
        canInvoke: true,
    }];
}

/** A permission authorizing the register front door for *any* prefix. */
function registerAnyPermission(): Permission[] {
    return [{
        target: {
            serviceId: { exact: 'hub' },
            interfaceId: { exact: 'hubServiceIdRegistry' },
            members: [{ exact: 'registerServiceId' }],
        },
        canInvoke: true,
    }];
}

/**
 * Stand up a hub with the signed register endpoint enabled and a caller wired
 * through a **capability-mode** forwarded-call gate rooted at `admin` — the same
 * front door every untrusted participant sits behind in production. The gate
 * authenticates (signature) and authorizes (capability) before the request ever
 * reaches the register handler, which is a pure side effect.
 */
function makeGatedHarness(admin: Identity): { hub: Hub; client: TestClient; } {
    const hub = new Hub();
    createHubServiceInterfaces(hub);

    const callerPair = new TransportPair();
    const gate = withForwardedCallGate(callerPair.b, {
        requireCapability: true,
        acceptedRootIssuers: () => [{ principal: admin.principal, isPublic: true }],
    });
    hub.attach(gate);
    return { hub, client: new TestClient(callerPair.a) };
}

describe('register front door (gate-authorized, side-effect handler)', () => {
    it('admits an admin presenting a self-issued cap and claims its prefix', async () => {
        const admin = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        const cap = await issueCap({
            issuer: admin,
            audience: admin.principal,
            permissions: registerPermissions('admin'),
        });
        const resp = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(admin, 'admin', [cap]));

        expect(resp).toMatchObject({ result: {} });
        expect(resp).not.toHaveProperty('error');
        expect(hub.claimedPrefixes()).toContain('admin');
    });

    it('admits a non-admin presenting a cap rooted at the admin', async () => {
        const admin = await makeIdentity();
        const worker = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        const cap = await issueCap({
            issuer: admin,
            audience: worker.principal,
            permissions: registerPermissions('github'),
        });
        const resp = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(worker, 'github', [cap]));

        expect(resp).toMatchObject({ result: {} });
        expect(resp).not.toHaveProperty('error');
        expect(hub.claimedPrefixes()).toContain('github');
    });

    it('rejects a caller with no capability (permissionRequired)', async () => {
        const admin = await makeIdentity();
        const worker = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        const resp = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(worker, 'github'));

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(hub.claimedPrefixes()).not.toContain('github');
    });

    it("rejects a cap whose param narrowing doesn't cover the requested prefix", async () => {
        const admin = await makeIdentity();
        const worker = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        const cap = await issueCap({
            issuer: admin,
            audience: worker.principal,
            permissions: registerPermissions('other'),
        });
        const resp = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(worker, 'github', [cap]));

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(hub.claimedPrefixes()).not.toContain('github');
    });

    it('rejects a cap whose root issuer is not an admin', async () => {
        const admin = await makeIdentity();
        const stranger = await makeIdentity();
        const worker = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        // Self-issued by a stranger who is not an accepted admin root.
        const cap = await issueCap({
            issuer: stranger,
            audience: worker.principal,
            permissions: registerPermissions('github'),
        });
        const resp = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(worker, 'github', [cap]));

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(hub.claimedPrefixes()).not.toContain('github');
    });

    it('rejects an unsigned register call at the gate', async () => {
        const admin = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        const resp = await client.sendRequest(REGISTER_METHOD, { requestedPrefix: 'github' });

        expect(resp).toMatchObject({ error: { code: ErrorCode.invalidRequest } });
        expect(hub.claimedPrefixes()).not.toContain('github');
    });

    it('rejects a malformed prefix in the handler (invalidParams)', async () => {
        const admin = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        // A permissive (any-prefix) cap clears the gate, so the malformed prefix
        // is caught by the handler's own validation.
        const cap = await issueCap({
            issuer: admin,
            audience: admin.principal,
            permissions: registerAnyPermission(),
        });
        const resp = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(admin, 'bad/', [cap]));

        expect(resp).toMatchObject({ error: { code: ErrorCode.invalidParams } });
        expect(hub.claimedPrefixes()).not.toContain('bad/');
    });

    it('rejects a claim for an already-owned prefix (invalidRequest)', async () => {
        const admin = await makeIdentity();
        const { hub, client } = makeGatedHarness(admin);

        const cap1 = await issueCap({
            issuer: admin,
            audience: admin.principal,
            permissions: registerAnyPermission(),
        });
        const first = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(admin, 'dup', [cap1]));
        expect(first).toMatchObject({ result: {} });
        expect(hub.claimedPrefixes()).toContain('dup');

        const cap2 = await issueCap({
            issuer: admin,
            audience: admin.principal,
            permissions: registerAnyPermission(),
        });
        const second = await client.sendRequest(REGISTER_METHOD, await makeRegisterCall(admin, 'dup', [cap2]));
        expect(second).toMatchObject({ error: { code: ErrorCode.invalidRequest } });
    });
});
