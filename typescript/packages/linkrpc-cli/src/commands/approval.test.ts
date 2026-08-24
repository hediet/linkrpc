import {
    createSeededMemoryPrincipal,
    createSeededSigningIdentity,
    permissionMatchesTarget,
    type Permission,
} from '@hediet/linkrpc';
import {
    type HubAccessManifestDecision,
    type HubAccessManifestRequest,
    type IHubAccessManifest,
} from '@hediet/linkrpc/hub/common';
import { describe, expect, it } from 'vitest';
import {
    approvalCommandPermissions,
    ApprovalCommandClient,
    bootstrapApprovalCommandCapability,
    encodeApprovalRequestId,
    formatApprovalDecision,
    formatApprovalRequests,
} from './approval';

const PERMISSION: Permission = {
    target: {
        serviceId: { exact: 'calendar' },
        interfaceId: { exact: 'events' },
        members: [{ exact: 'list' }],
    },
    canInvoke: true,
};

class FakeManifest {
    public requested: Record<string, HubAccessManifestRequest> = {};
    public revision = 0;
    public acknowledgeDecisions = true;
    public readonly decisions: Array<{ id: string; value: HubAccessManifestDecision }> = [];
    private readonly _watchers = new Set<() => void>();

    public get activeWatchCount(): number {
        return this._watchers.size;
    }

    public readonly client: IHubAccessManifest = {
        getDesired: async () => ({ requested: this.requested, revision: this.revision }),
        watchDesired: (_params, options) => {
            const onMessage = () => options.onMessage?.({});
            this._watchers.add(onMessage);
            let finish!: () => void;
            const promise = new Promise<Record<string, never>>((resolve) => {
                finish = () => resolve({});
            });
            return Object.assign(promise, {
                requestId: Promise.resolve(1),
                send: async () => { /* no client stream */ },
                ping: async () => { /* alive */ },
                cancel: async () => {
                    this._watchers.delete(onMessage);
                    finish();
                },
            });
        },
        getCurrent: async () => ({ current: {}, revision: this.revision }),
        setCurrent: async ({ patches }) => {
            for (const patch of patches) {
                if (patch.op !== 'set' || !patch.path.startsWith('/current/')) continue;
                const id = unescapePointer(patch.path.slice('/current/'.length));
                this.decisions.push({ id, value: patch.value as HubAccessManifestDecision });
                if (this.acknowledgeDecisions) delete this.requested[id];
            }
            this.revision++;
            for (const watcher of this._watchers) watcher();
            return { revision: this.revision };
        },
        watchCurrent: () => idleWatch(),
    };
}

describe('approval commands', () => {
    it('bootstraps one exact, durable approval capability and reuses it', async () => {
        const principal = await createSeededMemoryPrincipal({ seed: 100 });

        const first = await bootstrapApprovalCommandCapability(principal);
        const second = await bootstrapApprovalCommandCapability(principal);

        expect(second).toBe(first);
        expect(principal.capBag.capabilities).toEqual([first]);
        expect(first).toMatchObject({
            issuer: principal.id,
            audience: principal.id,
            permissions: approvalCommandPermissions,
        });
        expect(first.expiresAtMs).toBeUndefined();
        expect(first.parentHash).toBeUndefined();
    });

    it('scopes bootstrap authority to manifests and directory discovery', () => {
        const permits = (interfaceId: string, member: string) =>
            approvalCommandPermissions.some((permission) =>
                permissionMatchesTarget({ serviceId: 'any/service', interfaceId, member }, permission)
            );

        expect(permits('hubAccessManifest', 'getDesired')).toBe(true);
        expect(permits('hubAccessManifest', 'watchDesired')).toBe(true);
        expect(permits('hubAccessManifest', 'setCurrent')).toBe(true);
        expect(permits('linkrpc.directory', 'list')).toBe(true);
        expect(permits('linkrpc.directory', 'watch')).toBe(true);
        expect(permits('hubAccess', 'requestAccess')).toBe(false);
        expect(permits('linkrpc.defaults', 'getDesired')).toBe(false);
        expect(permits('identity', 'getPrincipal')).toBe(false);
    });

    it('lists requests for other consumers when they accept the CLI root', async () => {
        const identity = await createSeededSigningIdentity({ seed: 1 });
        const rootPrincipal = identity.publicSigningIdentity.principal;
        const manifest = new FakeManifest();
        manifest.requested = {
            'source\u0000auth': direct('Auth', 'id:key:auth-service', [rootPrincipal]),
            'source\u0000unconstrained': direct('Worker', 'id:key:worker'),
            'source\u0000wrong-root': direct('Other', 'id:key:other-service', ['id:key:other-root']),
        };
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        try {
            const requests = await client.requests();
            expect(requests).toEqual([
                {
                    id: encodeApprovalRequestId('source\u0000auth'),
                    request: manifest.requested['source\u0000auth'],
                    revision: 0,
                    sourceServiceId: 'source',
                },
                {
                    id: encodeApprovalRequestId('source\u0000unconstrained'),
                    request: manifest.requested['source\u0000unconstrained'],
                    revision: 0,
                    sourceServiceId: 'source',
                },
            ].sort((a, b) => a.id.localeCompare(b.id)));
        } finally {
            client.dispose();
        }
    });

    it('uses the CLI identity as issuer and mints for the actual request consumer', async () => {
        const identity = await createSeededSigningIdentity({ seed: 2 });
        const rootPrincipal = identity.publicSigningIdentity.principal;
        const consumerPrincipal = 'id:key:auth-service';
        const manifest = new FakeManifest();
        const internalId = 'source\u0000approve-me';
        manifest.requested[internalId] = direct('Auth', consumerPrincipal, [rootPrincipal]);
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        try {
            await client.approve(encodeApprovalRequestId(internalId));

            expect(manifest.decisions).toHaveLength(1);
            const decision = manifest.decisions[0].value;
            expect(decision.status).toBe('granted');
            if (decision.status === 'granted') {
                expect(decision.granted.kind).toBe('direct');
                expect(decision.granted.capabilities).toHaveLength(1);
                expect(decision.granted.capabilities[0].audience).toBe(consumerPrincipal);
                expect(decision.granted.capabilities[0].issuer).toBe(rootPrincipal);
            }
        } finally {
            client.dispose();
        }
    });

    it('reports when a matching request remains after the decision was accepted', async () => {
        const identity = await createSeededSigningIdentity({ seed: 7 });
        const principal = identity.publicSigningIdentity.principal;
        const manifest = new FakeManifest();
        const internalId = 'source\u0000unacknowledged';
        manifest.requested[internalId] = direct('Auth', principal, [principal]);
        manifest.acknowledgeDecisions = false;
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        try {
            await expect(client.approve(encodeApprovalRequestId(internalId))).resolves.toBe('still-pending');
            expect(manifest.decisions).toHaveLength(1);
        } finally {
            client.dispose();
        }
    });

    it('resolves discovery requests before awaiting the manifest acknowledgement', async () => {
        const identity = await createSeededSigningIdentity({ seed: 8 });
        const principal = identity.publicSigningIdentity.principal;
        const manifest = new FakeManifest();
        const internalId = 'source\u0000discover';
        manifest.requested[internalId] = {
            kind: 'discover',
            consumer: { name: 'Calendar agent', principal: 'id:key:calendar-agent' },
            interfaces: [{ id: 'events' }],
            members: [{ interfaceId: 'events', member: { exact: 'list' } }],
            acceptableRootIds: [principal],
        };
        const client = new ApprovalCommandClient({
            manifest: manifest.client,
            identity,
            fetchDirectory: async () => [{
                serviceId: 'calendar',
                interfaceId: 'events',
                hash: 'events-v1',
            }],
        });
        try {
            const prepared = await client.prepareApproval(encodeApprovalRequestId(internalId));
            expect(prepared).toMatchObject({
                resolvedSlot: {
                    serviceId: 'calendar',
                    satisfiedInterfaces: ['events'],
                },
                permissions: [PERMISSION],
            });
            await client.approvePrepared(prepared);

            const decision = manifest.decisions[0]?.value;
            expect(decision?.status).toBe('granted');
            if (decision?.status === 'granted') {
                expect(decision.granted).toMatchObject({
                    kind: 'discover',
                    serviceId: 'calendar',
                    satisfiedInterfaces: ['events'],
                });
                expect(decision.granted.capabilities[0].permissions).toEqual([PERMISSION]);
            }
        } finally {
            client.dispose();
        }
    });

    it('rejects approval if the request changes after operator review', async () => {
        const identity = await createSeededSigningIdentity({ seed: 9 });
        const principal = identity.publicSigningIdentity.principal;
        const manifest = new FakeManifest();
        const internalId = 'source\u0000changed';
        const externalId = encodeApprovalRequestId(internalId);
        manifest.requested[internalId] = direct('Calendar', principal, [principal]);
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        try {
            const prepared = await client.prepareApproval(externalId);
            manifest.requested[internalId] = {
                ...direct('Calendar', principal, [principal]),
                permissions: [{
                    ...PERMISSION,
                    canDelegate: true,
                }],
            };
            manifest.revision++;

            await expect(client.approvePrepared(prepared)).rejects.toThrow(
                /changed after it was reviewed/,
            );
            expect(manifest.decisions).toEqual([]);
        } finally {
            client.dispose();
        }
    });

    it('denies a pending request with an optional reason', async () => {
        const identity = await createSeededSigningIdentity({ seed: 3 });
        const principal = identity.publicSigningIdentity.principal;
        const manifest = new FakeManifest();
        const internalId = 'source\u0000deny-me';
        manifest.requested[internalId] = direct('self', principal, [principal]);
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        try {
            await client.deny(encodeApprovalRequestId(internalId), 'operator denied');
            expect(manifest.decisions).toEqual([{
                id: internalId,
                value: { status: 'denied', reason: 'operator denied' },
            }]);
        } finally {
            client.dispose();
        }
    });

    it('rejects malformed, unknown, and requests that do not accept the CLI root', async () => {
        const identity = await createSeededSigningIdentity({ seed: 4 });
        const manifest = new FakeManifest();
        manifest.requested['wrong-root'] = direct(
            'foreign',
            'id:key:foreign-consumer',
            ['id:key:other-root'],
        );
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        try {
            await expect(client.approve('not-an-approval-id')).rejects.toThrow(/invalid approval request id/);
            await expect(client.deny('ar1_***')).rejects.toThrow(/invalid approval request id/);
            await expect(client.approve(encodeApprovalRequestId('missing'))).rejects.toThrow(/not pending/);
            await expect(client.approve(encodeApprovalRequestId('wrong-root'))).rejects.toThrow(/not pending/);
            expect(manifest.decisions).toEqual([]);
        } finally {
            client.dispose();
        }
    });

    it('completes a one-shot requests snapshot without waiting for the open watch', async () => {
        const identity = await createSeededSigningIdentity({ seed: 6 });
        const manifest = new FakeManifest();
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });

        const requests = await withTimeout(client.requests(), 250);
        expect(requests).toEqual([]);
        expect(manifest.activeWatchCount).toBe(1);

        client.dispose();
        await waitFor(() => manifest.activeWatchCount === 0);
    });

    it('provides stable JSON and readable text output', () => {
        const principal = 'id:key:self';
        const id = encodeApprovalRequestId('source\u0000request');
        const requests = [{ id, request: direct('calendar agent', principal), revision: 1 }];

        const machine = JSON.parse(formatApprovalRequests(requests, principal, true));
        expect(machine).toEqual({
            version: 1,
            principal,
            requests: [{ id, request: requests[0].request }],
        });
        const plain = formatApprovalRequests(requests, principal);
        expect(plain).toContain(`${id}  direct  calendar agent`);
        expect(plain).toContain('• exact("calendar")::exact("events") {exact("list")}');
        expect(plain).toContain('Actions 1: invoke');
        expect(JSON.parse(formatApprovalDecision('approved', id, principal, true))).toEqual({
            version: 1,
            action: 'approved',
            id,
            principal,
        });
        expect(JSON.parse(
            formatApprovalDecision('approved', id, principal, true, 'still-pending'),
        )).toEqual({
            version: 1,
            action: 'approved',
            id,
            principal,
            requestStillPending: true,
        });
        expect(formatApprovalDecision(
            'denied',
            id,
            principal,
            false,
            'still-pending',
        )).toContain('matching request is still pending');
    });

    it('wires the interactive prompt to pending requests until aborted', async () => {
        const identity = await createSeededSigningIdentity({ seed: 5 });
        const principal = identity.publicSigningIdentity.principal;
        const manifest = new FakeManifest();
        const internalId = 'source\u0000interactive';
        manifest.requested[internalId] = direct('interactive', principal, [principal]);
        const client = new ApprovalCommandClient({ manifest: manifest.client, identity });
        const abort = new AbortController();
        let prompts = 0;
        try {
            const running = client.runInteractive(abort.signal, async (request) => {
                prompts++;
                expect(request.consumerPrincipalId).toBe(principal);
                return { grant: false, reason: 'interactive test' };
            });
            await waitFor(() => manifest.decisions.length === 1);
            abort.abort();
            await running;

            expect(prompts).toBe(1);
            expect(manifest.decisions).toEqual([{
                id: internalId,
                value: { status: 'denied', reason: 'interactive test' },
            }]);
        } finally {
            abort.abort();
            client.dispose();
        }
    });
});

function direct(
    name: string,
    principal: string,
    acceptableRootIds?: string[],
): HubAccessManifestRequest {
    return {
        kind: 'direct',
        consumer: { name, principal },
        permissions: [PERMISSION],
        ...(acceptableRootIds !== undefined ? { acceptableRootIds } : {}),
    };
}

function idleWatch(): ReturnType<IHubAccessManifest['watchCurrent']> {
    const promise = new Promise<Record<string, never>>(() => { /* remains open */ });
    return Object.assign(promise, {
        requestId: Promise.resolve(1),
        send: async () => { /* no client stream */ },
        ping: async () => { /* alive */ },
        cancel: async () => { /* no-op */ },
    });
}

function unescapePointer(segment: string): string {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition not met before timeout');
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('requests did not complete')), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
