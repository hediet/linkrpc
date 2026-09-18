import { describe, expect, it } from 'vitest';
import { KeypairSigningIdentity } from '@hediet/linkrpc';
import {
    attachCapabilities, type Capability, defineInterface, ErrorCode,
    LinkRpcConnection,
    type IMessageTransport,
    invoke,
    isRequest,
    issueCapability,
    JsonRpcChannel,
    type JsonObject,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type JsonValue,
    type Keypair,
    methodNameToTarget,
    type PrincipalId,
    type Permission,
    prefix,
    Principal,
    principalForPublicKey,
    requestType,
    RpcError,
    signCapability,
    type SignedCapability,
    SigningSender,
    signParams,
    TransportPair,
    verifyCall
} from '@hediet/linkrpc';
import { object, strictObject, string } from 'zod/mini';
import { withForwardedCallGate, withFullyQualifiedCallGate } from './forwardedCallGate';
import { Hub } from './routing/routingHub';
import { GET_NODE_ID_METHOD } from './routing/peerDiscovery';
import { crypto } from '@hediet/linkrpc';

/** Tiny test client: send a request and await the matching response. */
class TestClient {
    private _nextId = 100;
    private readonly _pending = new Map<string, (r: JsonRpcResponse) => void>();

    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((m) => this._onMessage(m));
    }

    public async sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
        const id = this._nextId++;
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params as never };
        const promise = new Promise<JsonRpcResponse>((resolve) => {
            this._pending.set(String(id), resolve);
        });
        this.transport.send(req);
        return promise;
    }

    private _onMessage(m: JsonRpcMessage): void {
        const id = (m as { id?: number | string | null; }).id;
        if (id !== undefined && id !== null && 'method' in m === false) {
            const resolve = this._pending.get(String(id));
            if (resolve) {
                this._pending.delete(String(id));
                resolve(m as JsonRpcResponse);
            }
        }
    }
}

/** A participant that records inbound requests and auto-replies. */
class RecordingProvider {
    public readonly received: JsonRpcRequest[] = [];

    constructor(
        private readonly _transport: IMessageTransport,
        private readonly _result: JsonValue = { ok: true },
    ) {
        _transport.setListener((m) => {
            if (isRequest(m)) {
                if (m.method === GET_NODE_ID_METHOD) {
                    void _transport.send({
                        jsonrpc: '2.0', id: m.id,
                        error: { code: ErrorCode.methodNotFound, message: 'Discovery unsupported' },
                    });
                    return;
                }
                this.received.push(m);
                void _transport.send({ jsonrpc: '2.0', id: m.id, result: this._result });
            }
        });
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

async function signedCall(
    id: Identity,
    method: string,
    params: JsonObject,
    capabilities?: SignedCapability[],
): Promise<JsonObject> {
    return signParams({
        method,
        params,
        signingIdentity: id.signer,
        ...(capabilities !== undefined ? { capabilities } : {}),
    });
}

let _capNonce = 0;
async function issueCap(opts: {
    issuer: Identity;
    audience: PrincipalId;
    permissions: Permission[];
    expiresAtMs?: number;
}): Promise<SignedCapability> {
    _capNonce += 1;
    const cap: Capability = {
        issuer: opts.issuer.principal,
        audience: opts.audience,
        permissions: opts.permissions,
        nonce: `gate-cap-${_capNonce}`,
        ...(opts.expiresAtMs !== undefined ? { expiresAtMs: opts.expiresAtMs } : {}),
    };
    return signCapability(cap, opts.issuer.signer);
}

/** A permission granting `invoke` on `svc::math::add` (the common harness target). */
function addPermission(extra?: Partial<Permission>): Permission {
    return {
        target: { serviceId: { exact: 'svc' }, interfaceId: { exact: 'math' }, members: [{ exact: 'add' }] },
        canInvoke: true,
        ...extra,
    };
}

/**
 * Wire up a hub with: a recording provider claiming `svc`, an exempt-prefix
 * provider claiming `hub`, and a caller attached through the gate.
 */
function makeHarness(options?: {
    requireCapability?: boolean;
    acceptedRootIssuers?: (serviceId: string) => readonly PrincipalId[];
}) {
    const hub = new Hub();

    const provPair = new TransportPair();
    hub.attach(provPair.a);
    hub.claimPrefix(provPair.a, 'svc');
    const provider = new RecordingProvider(provPair.b);

    const hubSvcPair = new TransportPair();
    hub.attach(hubSvcPair.a);
    hub.claimPrefix(hubSvcPair.a, 'hub');
    const hubServices = new RecordingProvider(hubSvcPair.b);

    const callerPair = new TransportPair();
    const resolver = options?.acceptedRootIssuers;
    const acceptedRootIssuers = (serviceId: string) =>
        (resolver ? resolver(serviceId) : []).map((nodeId) => ({ principal: nodeId, isPublic: true }));
    // Build a value matching the gate's discriminated option union: capability
    // mode always carries `acceptedRootIssuers` (an empty resolver fails
    // closed, which the "no accepted roots" tests rely on).
    const gate = options?.requireCapability === true
        ? withForwardedCallGate(callerPair.b, {
            exemptPrefixes: ['hub'],
            requireCapability: true,
            acceptedRootIssuers,
        })
        : withForwardedCallGate(callerPair.b, {
            exemptPrefixes: ['hub'],
            ...(resolver !== undefined ? { acceptedRootIssuers } : {}),
        });
    hub.attach(gate);
    const caller = new TestClient(callerPair.a);

    return { hub, provider, hubServices, caller };
}

/**
 * Compute the `callBind.payloadHash` (base64url sha256) of the canonical
 * bytes a signed wire call commits to — exactly what the gate re-derives.
 */
async function callBindHashOf(wireParams: JsonObject, method: string): Promise<string> {
    const res = await verifyCall({ method, params: wireParams, parseMethod: methodNameToTarget });
    if (!res.ok) {
        throw new Error(`verifyCall failed: ${res.reason}`);
    }
    // `callHash` is already the base64url sha256 of `signingInput("call", ...)`
    // — exactly the `callBind.payloadHash` the gate re-derives.
    return res.callHash;
}

describe('withForwardedCallGate (hub signature front door)', () => {
    it('forwards reserved inspection calls without affecting transit logging', async () => {
        const { hub, provider, caller } = makeHarness();
        const identity = await makeIdentity();
        const transits: string[] = [];
        const observation = hub.observeTransits((transit) => {
            transits.push(transit.method ?? '');
        });

        const inspectionMethod = 'svc::hubrpc.topology::getGraph';
        await caller.sendRequest(
            inspectionMethod,
            await signedCall(identity, inspectionMethod, {}),
        );
        expect(provider.received.at(-1)?.method).toBe(inspectionMethod);
        expect(transits).toEqual([inspectionMethod, inspectionMethod]);

        const visibleMethod = 'svc::hubrpc.topology.extra::getGraph';
        await caller.sendRequest(
            visibleMethod,
            await signedCall(identity, visibleMethod, {}),
        );
        expect(transits).toEqual([
            inspectionMethod,
            inspectionMethod,
            visibleMethod,
            visibleMethod,
        ]);
        observation.dispose();
    });

    it('forwards a signed cross-service request and returns the result', async () => {
        const { provider, caller } = makeHarness();
        const id = await makeIdentity();

        const resp = await caller.sendRequest('svc::math::add', await signedCall(id, 'svc::math::add', { a: 2, b: 3 }));

        expect(resp).toMatchObject({ result: { ok: true } });
        expect(provider.received).toHaveLength(1);
        // The envelope is forwarded intact (not stripped) for re-verification.
        expect(provider.received[0].params).toHaveProperty('$hubrpc');
    });

    it('keeps the envelope intact through chained gates and strips it only for a strict terminal handler', async () => {
        const strictNotes = defineInterface({ id: 'strict.notes' }, {
            read: requestType(
                strictObject({ id: string() }),
                object({ contents: string() }),
            ),
        });
        const pair = new TransportPair();
        let firstGateCalls = 0;
        let secondGateCalls = 0;
        const firstGate = withFullyQualifiedCallGate(pair.b, {
            nowMs: () => {
                firstGateCalls++;
                return Date.now();
            },
        });
        const secondGate = withFullyQualifiedCallGate(firstGate, {
            nowMs: () => {
                secondGateCalls++;
                return Date.now();
            },
        });
        const server = LinkRpcConnection.fromTransport(secondGate);
        const receivedParams: unknown[] = [];
        server.register(strictNotes, {
            read: (params) => {
                receivedParams.push(params);
                return { contents: `Contents of ${params.id}` };
            },
        }, { serviceId: 'notes' });

        const appId = await KeypairSigningIdentity.generateNew();
        const principal = await Principal.create(appId);
        const signedChannel = SigningSender.wrapChannel(JsonRpcChannel.create(pair.a), {
            principal,
        });
        const client = new LinkRpcConnection(signedChannel, {
            validateOutboundParams: false,
        });
        const notes = client.service('notes').get(strictNotes);

        await expect(notes.read({ id: 'public/roadmap' }))
            .resolves.toEqual({ contents: 'Contents of public/roadmap' });
        expect(receivedParams).toEqual([{ id: 'public/roadmap' }]);
        expect(firstGateCalls).toBe(1);
        expect(secondGateCalls).toBe(1);

        // @ts-expect-error Exercise terminal validation with client validation disabled.
        const invalidError = await notes.read({ id: 42 }).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(invalidError).toBeInstanceOf(RpcError);
        expect(invalidError).toMatchObject({
            code: ErrorCode.invalidParams,
            message: 'Invalid params',
            data: {
                issues: [
                    expect.objectContaining({
                        path: ['id'],
                    }),
                ],
            },
        });
        expect(receivedParams).toHaveLength(1);
        expect(firstGateCalls).toBe(2);
        expect(secondGateCalls).toBe(2);
    });

    it('rejects an unsigned cross-service request before it reaches the hub', async () => {
        const { provider, caller } = makeHarness();

        const resp = await caller.sendRequest('svc::math::add', { a: 2, b: 3 });

        expect(resp).toMatchObject({ error: { code: ErrorCode.invalidRequest } });
        expect(provider.received).toHaveLength(0);
    });

    it('rejects a request whose signature was tampered with', async () => {
        const { provider, caller } = makeHarness();
        const id = await makeIdentity();
        const params = await signedCall(id, 'svc::math::add', { a: 2, b: 3 }) as Record<string, unknown>;
        // Corrupt the call signature.
        const sigs = params['$hubrpcSignature'] as { call: { keyId: string; sig: string }; };
        sigs.call.sig = (sigs.call.sig.startsWith('A') ? 'B' : 'A') + sigs.call.sig.slice(1);

        const resp = await caller.sendRequest('svc::math::add', params);

        expect(resp).toMatchObject({ error: { code: ErrorCode.invalidRequest } });
        expect(provider.received).toHaveLength(0);
    });

    it('lets an unsigned request to an exempt prefix pass verbatim', async () => {
        const { hubServices, caller } = makeHarness();

        const resp = await caller.sendRequest('hub::hubrpc.directory::list', {});

        expect(resp).toMatchObject({ result: { ok: true } });
        expect(hubServices.received).toHaveLength(1);
    });

    it('always lets a root-addressed request pass verbatim', async () => {
        const pair = new TransportPair();
        const gate = withFullyQualifiedCallGate(pair.b, {
            requireCapability: true,
            trustedRoots: [],
        });
        const provider = new RecordingProvider(gate);
        const caller = new TestClient(pair.a);

        const resp = await caller.sendRequest('math::add', { a: 2, b: 3 });

        expect(resp).toMatchObject({ result: { ok: true } });
        expect(provider.received).toHaveLength(1);
    });

    it('gates fully-qualified notifications', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const pair = new TransportPair();
        const gate = withFullyQualifiedCallGate(pair.b, {
            requireCapability: true,
            trustedRoots: [root.signer.publicSigningIdentity],
        });
        const received: JsonRpcMessage[] = [];
        gate.setListener((message) => received.push(message));
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission()],
        });

        pair.a.send({
            jsonrpc: '2.0',
            method: 'svc::math::add',
            params: await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]) as never,
        });
        pair.a.send({
            jsonrpc: '2.0',
            method: 'svc::math::add',
            params: { a: 2, b: 2 },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ method: 'svc::math::add' });
    });

    it('rejects a replayed request nonce (same signed wire sent twice)', async () => {
        const { provider, caller } = makeHarness();
        const id = await makeIdentity();
        const wire = await signedCall(id, 'svc::math::add', { a: 2, b: 3 });

        const first = await caller.sendRequest('svc::math::add', wire);
        const second = await caller.sendRequest('svc::math::add', wire);

        expect(first).toMatchObject({ result: { ok: true } });
        expect(second).toMatchObject({ error: { code: ErrorCode.invalidRequest } });
        expect(provider.received).toHaveLength(1);
    });

    it('requireCapability: rejects a signed request that presents no capability', async () => {
        const { provider, caller } = makeHarness({ requireCapability: true });
        const id = await makeIdentity();

        const resp = await caller.sendRequest('svc::math::add', await signedCall(id, 'svc::math::add', { a: 1, b: 1 }));

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(0);
    });

    it('requireCapability: admits a signed request carrying a matching, accepted-rooted capability', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        const cap = await issueCap({ issuer: root, audience: worker.principal, permissions: [addPermission()] });

        const resp = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(resp).toMatchObject({ result: { ok: true } });
        expect(provider.received).toHaveLength(1);
    });
});

describe('withForwardedCallGate (capability authorization)', () => {
    it('callBind: admits the one call whose signed bytes match the bound hash', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });

        // Sign the concrete call first so we can bind the cap to its bytes.
        const wire = await signedCall(worker, 'svc::math::add', { a: 2, b: 3 });
        const payloadHash = await callBindHashOf(wire, 'svc::math::add');
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission({ callBind: { alg: 'sha256', payloadHash } })],
        });
        // Attach the cap without disturbing the signed fields.
        const wireWithCap = attachCapabilities(wire, [cap]) as JsonObject;

        const resp = await caller.sendRequest('svc::math::add', wireWithCap);

        expect(resp).toMatchObject({ result: { ok: true } });
        expect(provider.received).toHaveLength(1);
    });

    it('callBind: rejects a call whose bytes do not match the bound hash', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });

        const boundWire = await signedCall(worker, 'svc::math::add', { a: 2, b: 3 });
        const payloadHash = await callBindHashOf(boundWire, 'svc::math::add');
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission({ callBind: { alg: 'sha256', payloadHash } })],
        });
        // A DIFFERENT call (different params + fresh nonce) presenting the same cap.
        const otherWire = attachCapabilities(
            await signedCall(worker, 'svc::math::add', { a: 9, b: 9 }),
            [cap],
        ) as JsonObject;

        const resp = await caller.sendRequest('svc::math::add', otherWire);

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(0);
    });

    it('callBind: a bound cap is single-use via the replay ledger', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });

        const wire = await signedCall(worker, 'svc::math::add', { a: 2, b: 3 });
        const payloadHash = await callBindHashOf(wire, 'svc::math::add');
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission({ callBind: { alg: 'sha256', payloadHash } })],
        });
        const wireWithCap = attachCapabilities(wire, [cap]) as JsonObject;

        const first = await caller.sendRequest('svc::math::add', wireWithCap);
        const second = await caller.sendRequest('svc::math::add', wireWithCap);

        expect(first).toMatchObject({ result: { ok: true } });
        // Same nonce → rejected as a replay before re-authorizing the callBind.
        expect(second).toMatchObject({ error: { code: ErrorCode.invalidRequest } });
        expect(provider.received).toHaveLength(1);
    });

    it('params: admits matching params and rejects mismatched ones', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission({ params: { a: { exact: 1 }, b: { any: true } } })],
        });

        const ok = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 7 }, [cap]),
        );
        const bad = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 2, b: 7 }, [cap]),
        );

        expect(ok).toMatchObject({ result: { ok: true } });
        expect(bad).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(1);
    });

    it('rejects malformed capability JSON and continues processing later calls', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission()],
        });

        const malformed = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [null as unknown as SignedCapability]),
        );
        const valid = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(malformed).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(valid).toMatchObject({ result: { ok: true } });
        expect(provider.received).toHaveLength(1);
    });

    it('acceptedRootIssuers: rejects a self-issued capability not rooted at an accepted issuer', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        // worker issues a cap to itself — root is `worker`, not accepted.
        const cap = await issueCap({ issuer: worker, audience: worker.principal, permissions: [addPermission()] });

        const resp = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(0);
    });

    it('acceptedRootIssuers: fail closed when empty (no accept-any affordance)', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [],
        });
        const cap = await issueCap({ issuer: root, audience: worker.principal, permissions: [addPermission()] });

        const resp = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(0);
    });

    it('acceptedRootIssuers: admits an accepted-rooted capability', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        const cap = await issueCap({ issuer: root, audience: worker.principal, permissions: [addPermission()] });

        const resp = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(resp).toMatchObject({ result: { ok: true } });
        expect(provider.received).toHaveLength(1);
    });

    it('rejects an expired capability', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        // Capability that expired one minute ago.
        const cap = await issueCap({
            issuer: root,
            audience: worker.principal,
            permissions: [addPermission()],
            expiresAtMs: Date.now() - 60_000,
        });

        const resp = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(0);
    });

    it('rejects a capability issued to a different audience', async () => {
        const root = await makeIdentity();
        const worker = await makeIdentity();
        const other = await makeIdentity();
        const { provider, caller } = makeHarness({
            requireCapability: true,
            acceptedRootIssuers: () => [root.principal],
        });
        // Cap is bound to `other`, but `worker` signs and presents the call.
        const cap = await issueCap({ issuer: root, audience: other.principal, permissions: [addPermission()] });

        const resp = await caller.sendRequest(
            'svc::math::add',
            await signedCall(worker, 'svc::math::add', { a: 1, b: 1 }, [cap]),
        );

        expect(resp).toMatchObject({ error: { code: ErrorCode.permissionRequired } });
        expect(provider.received).toHaveLength(0);
    });
});

describe('capability demo flow', () => {
    it('gates fully-qualified calls before they reach service handlers after a JSON round-trip', async () => {
        const notes = defineInterface({ id: 'demo.notes' }, {
            read: requestType(
                object({ id: string() }),
                object({ contents: string() }),
            ),
        });
        const adminId = await KeypairSigningIdentity.generateNew();
        const appId = await KeypairSigningIdentity.generateNew();
        const capability = await issueCapability(adminId, {
            audience: appId.publicSigningIdentity,
            permissions: [
                invoke('notes', notes, 'read', {
                    id: prefix('public/'),
                }),
            ],
        });

        const capabilityJson = JSON.stringify(capability);
        const pair = new TransportPair();
        const gatedTransport = withFullyQualifiedCallGate(pair.b, {
            requireCapability: true,
            trustedRoots: [adminId.publicSigningIdentity],
        });
        const server = LinkRpcConnection.fromTransport(gatedTransport);
        let handlerCalls = 0;
        server.register(notes, {
            read: ({ id }) => {
                handlerCalls++;
                return { contents: `Contents of ${id}` };
            },
        }, { serviceId: 'notes' });

        const receivedCapability: SignedCapability = JSON.parse(capabilityJson)
        const appPrincipal = await Principal.create(appId, [receivedCapability]);
        const signedChannel = SigningSender.wrapChannel(JsonRpcChannel.create(pair.a), {
            principal: appPrincipal,
        });
        const client = new LinkRpcConnection(signedChannel);
        const notesClient = client.service('notes').get(notes);

        await expect(notesClient.read({ id: 'public/roadmap' }))
            .resolves.toEqual({ contents: 'Contents of public/roadmap' });
        await expect(notesClient.read({ id: 'private/payroll' }))
            .rejects.toMatchObject({ code: ErrorCode.permissionRequired });
        expect(handlerCalls).toBe(1);
    });
});
