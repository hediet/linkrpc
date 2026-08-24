import { describe, expect, it } from 'vitest';
import {
    type IMessageTransport,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type Keypair,
    type PrincipalId,
    principalForPublicKey,
    type SignedCapability,
    HubRpcConnection,
    TransportPair,
} from '@vscode/hubrpc';
import { InMemoryManagedIdentity as _InMemoryManagedIdentity } from '@vscode/hubrpc';
import { permits, type Call, type CallTarget } from '@vscode/hubrpc';
import { mintCapability } from './mintCapability';
import {
    registerHubAccessService,
    type AccessDecision,
    type HubAccessHandlers,
    type RegisterHubAccessOptions,
} from './hubAccessService';
import type { DirectoryEntry } from './accessCandidates';
import { crypto } from '@vscode/hubrpc';

// `InMemoryManagedIdentity.generate` no longer takes a crypto provider (it uses
// the package `crypto` module).
const InMemoryManagedIdentity = {
    generate: () => _InMemoryManagedIdentity.generate(),
};

class TestClient {
    private _nextId = 100;
    private readonly _pending = new Map<string, (r: JsonRpcResponse) => void>();
    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((m) => this._onMessage(m));
    }
    public async sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
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

/**
 * Serve `hubAccess::*` at the connection root (the new front door) and return a
 * direct client. The consent surface no longer depends on a verified signer —
 * the audience comes from `params.consumer.principal` — so a plain connection pair
 * reached in root form is all the harness needs.
 */
function serveAccess(options: RegisterHubAccessOptions): TestClient {
    const pair = new TransportPair();
    const server = HubRpcConnection.fromTransport(pair.a);
    registerHubAccessService(server, options);
    return new TestClient(pair.b);
}

interface Identity {
    principal: PrincipalId;
    keypair: Keypair;
}
async function makeIdentity(): Promise<Identity> {
    const keypair = await crypto.generateKeypair();
    const nodeId = principalForPublicKey(keypair.publicKey);
    return { principal: nodeId, keypair };
}

function makeCall(target: CallTarget, signer: PrincipalId): Call {
    return { target, params: undefined, nonce: 'req', signedAtMs: 0, signer, callHash: '' };
}

/** Accept-all root policy pinned to a single trusted issuer. */
function accept(issuer: PrincipalId) {
    return () => [{ principal: issuer, isPublic: true }];
}

function denyAll(): HubAccessHandlers {
    return {
        onAccessRequest: async () => ({ granted: false, reason: 'nope' }),
        onAccessExtend: async () => ({ granted: false }),
        onAccessRequestDirect: async () => ({ granted: false }),
    };
}

const GITHUB_DIR: DirectoryEntry[] = [
    { serviceId: 'github', interfaceId: 'github.repos', hash: 'h1' },
];

describe('registerHubAccessService', () => {
    it('grants service-discovery access and mints a cap bound to consumer.principal', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await makeIdentity();

        const handlers: HubAccessHandlers = {
            onAccessRequest: async (args): Promise<AccessDecision> => {
                const cap = await mintCapability({
                    issuer: admin,
                    audience: args.consumerPrincipalId,
                    permissions: [
                        {
                            target: {
                                serviceId: { exact: 'github' },
                                interfaceId: { exact: 'github.repos' },
                                members: [{ prefix: '' }],
                            },
                            canInvoke: true,
                        },
                    ],
                });
                return {
                    granted: true,
                    resolvedSlots: { slot0: { serviceId: 'github', interfaces: ['github.repos'] } },
                    capabilities: [cap],
                };
            },
            onAccessExtend: async () => ({ granted: false }),
            onAccessRequestDirect: async () => ({ granted: false }),
        };
        const client = serveAccess({ handlers, fetchDirectory: async () => GITHUB_DIR });

        const resp = await client.sendRequest('hubAccess::request', {
            consumer: { name: 'Test consumer', principal: consumer.principal },
            dependencies: { slot0: { interfaces: [{ id: 'github.repos', required: true }] } },
            duration: 'once',
        });

        expect('result' in resp).toBe(true);
        const result = (resp as unknown as { result: { status: string; slots: Record<string, { serviceId: string }>; capabilities: SignedCapability[] } }).result;
        expect(result.status).toBe('granted');
        expect(result.slots.slot0.serviceId).toBe('github');
        expect(result.capabilities).toHaveLength(1);

        // The minted cap is wieldable by the consumer for the granted call.
        const target: CallTarget = { serviceId: 'github', interfaceId: 'github.repos', member: 'list' };
        const verified = await permits(
            makeCall(target, consumer.principal),
            [result.capabilities[0]],
            accept(admin.principal),
            0,
        );
        expect(verified).toMatchObject({ ok: true, rootIssuer: admin.principal });
    });

    it('returns noCandidates when no service satisfies the slot', async () => {
        const consumer = await makeIdentity();
        const client = serveAccess({ handlers: denyAll(), fetchDirectory: async () => GITHUB_DIR });

        const resp = await client.sendRequest('hubAccess::request', {
            consumer: { name: 'Test consumer', principal: consumer.principal },
            dependencies: { slot0: { interfaces: [{ id: 'does.not.exist', required: true }] } },
        });
        const result = (resp as unknown as { result: { status: string; slots: string[] } }).result;
        expect(result.status).toBe('noCandidates');
        expect(result.slots).toEqual(['slot0']);
    });

    it('passes the handler denial through as status:denied', async () => {
        const consumer = await makeIdentity();
        const client = serveAccess({ handlers: denyAll(), fetchDirectory: async () => GITHUB_DIR });

        const resp = await client.sendRequest('hubAccess::request', {
            consumer: { name: 'Test consumer', principal: consumer.principal },
            dependencies: { slot0: { interfaces: [{ id: 'github.repos', required: true }] } },
        });
        const result = (resp as unknown as { result: { status: string; reason?: string } }).result;
        expect(result.status).toBe('denied');
        expect(result.reason).toBe('nope');
    });

    it('rejects a request that omits the consumer.principal audience', async () => {
        const client = serveAccess({ handlers: denyAll(), fetchDirectory: async () => GITHUB_DIR });

        const resp = await client.sendRequest('hubAccess::request', {
            consumer: { name: 'Test consumer' },
            dependencies: { slot0: { interfaces: [{ id: 'github.repos', required: true }] } },
        });
        expect('error' in resp).toBe(true);
    });

    it('grants a verbatim direct capability via requestAccess', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await makeIdentity();

        const client = serveAccess({
            fetchDirectory: async () => [],
            handlers: {
                onAccessRequest: async () => ({ granted: false }),
                onAccessExtend: async () => ({ granted: false }),
                onAccessRequestDirect: async (args) => {
                    const cap = await mintCapability({
                        issuer: admin,
                        audience: args.consumerPrincipalId,
                        permissions: [...args.permissions],
                    });
                    return { granted: true, capabilities: [cap] };
                },
            },
        });

        const resp = await client.sendRequest('hubAccess::requestAccess', {
            consumer: { name: 'Explorer', principal: consumer.principal },
            permissions: [
                {
                    target: { serviceId: { exact: 'any' }, interfaceId: { exact: 'hubrpc.directory' }, members: [{ exact: 'list' }] },
                    canInvoke: true,
                },
            ],
        });
        const result = (resp as unknown as { result: { status: string; capabilities: SignedCapability[] } }).result;
        expect(result.status).toBe('granted');
        expect(result.capabilities).toHaveLength(1);
    });

    it('delivers the per-attenuation callIntent to onAccessRequestDirect', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await makeIdentity();

        let seenCallIntent: unknown;
        const client = serveAccess({
            fetchDirectory: async () => [],
            handlers: {
                onAccessRequest: async () => ({ granted: false }),
                onAccessExtend: async () => ({ granted: false }),
                onAccessRequestDirect: async (args) => {
                    seenCallIntent = args.permissions[0]?.callIntent;
                    const cap = await mintCapability({
                        issuer: admin,
                        audience: args.consumerPrincipalId,
                        // Strip the consent-only `callIntent` before signing.
                        permissions: args.permissions.map(({ callIntent: _ignored, ...perm }) => perm),
                    });
                    return { granted: true, capabilities: [cap] };
                },
            },
        });

        const resp = await client.sendRequest('hubAccess::requestAccess', {
            consumer: { name: 'Explorer', principal: consumer.principal },
            permissions: [
                {
                    target: {
                        serviceId: { exact: 'github' },
                        interfaceId: { exact: 'github.issues' },
                        members: [{ exact: 'create' }],
                    },
                    canInvoke: true,
                    callIntent: {
                        method: 'github::github.issues::create',
                        params: { title: 'Hello' },
                        nonce: 'nonce-abc',
                        signedAtMs: 1_700_000_000,
                        summary: 'Create an issue',
                        suggestion: 'once',
                    },
                },
            ],
        });
        const result = (resp as unknown as { result: { status: string } }).result;
        expect(result.status).toBe('granted');
        expect(seenCallIntent).toMatchObject({
            method: 'github::github.issues::create',
            params: { title: 'Hello' },
            nonce: 'nonce-abc',
            signedAtMs: 1_700_000_000,
        });
    });
});
