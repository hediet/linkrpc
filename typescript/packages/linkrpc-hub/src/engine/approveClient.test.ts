import type { Permission } from '@hediet/linkrpc';
import type {
    HubAccessManifestDecision,
    HubAccessManifestRequest,
    IHubAccessManifest,
} from '@hediet/linkrpc/hub/common';
import { describe, expect, it } from 'vitest';
import { ApproveClient } from './approveClient';

const PERMISSION: Permission = {
    target: {
        serviceId: { exact: 'service' },
        interfaceId: { exact: 'interface' },
        members: [{ exact: 'method' }],
    },
    canInvoke: true,
};

function direct(
    name: string,
    acceptableRootIds?: string[],
): HubAccessManifestRequest {
    return {
        kind: 'direct',
        consumer: { name, principal: `id:key:${name}` },
        permissions: [PERMISSION],
        ...(acceptableRootIds !== undefined ? { acceptableRootIds } : {}),
    };
}

class FakeManifest {
    public requested: Record<string, HubAccessManifestRequest> = {};
    public revision = 0;
    public watchCount = 0;
    public keepDecidedRequests = false;
    public readonly decisions: Array<{ id: string; value: HubAccessManifestDecision }> = [];
    private onMessage: (() => void) | undefined;
    private resolveWatch: (() => void) | undefined;

    public readonly client: IHubAccessManifest = {
        getDesired: async () => ({ requested: this.requested, revision: this.revision }),
        watchDesired: (_params, options) => {
            this.watchCount++;
            this.onMessage = options.onMessage;
            const promise = new Promise<Record<string, never>>((resolve) => {
                this.resolveWatch = () => resolve({});
            });
            return Object.assign(promise, {
                requestId: Promise.resolve(1 as never),
                send: async (_value: never) => { /* no client stream */ },
                ping: async () => { /* alive */ },
                cancel: async () => { this.resolveWatch?.(); },
            });
        },
        getCurrent: async () => ({ current: {}, revision: 0 }),
        setCurrent: async ({ patches }) => {
            for (const patch of patches) {
                if (patch.op !== 'set' || !patch.path.startsWith('/current/')) continue;
                const id = unescapePointer(patch.path.slice('/current/'.length));
                this.decisions.push({ id, value: patch.value as HubAccessManifestDecision });
                if (!this.keepDecidedRequests) delete this.requested[id];
            }
            this.revision++;
            this.onMessage?.();
            return { revision: this.revision };
        },
        watchCurrent: () => idleWatch(),
    };

    public change(requested: Record<string, HubAccessManifestRequest>): void {
        this.requested = requested;
        this.revision++;
        this.onMessage?.();
    }

    public endWatch(): void {
        this.resolveWatch?.();
    }
}

describe('ApproveClient', () => {
    it('publishes authoritative snapshots and removes stale requests', async () => {
        const manifest = new FakeManifest();
        manifest.requested = {
            first: direct('first'),
            second: direct('second'),
        };
        const client = new ApproveClient({ manifest: manifest.client });

        await waitFor(() => client.requests.get().length === 2);
        manifest.change({ second: direct('second') });
        await waitFor(() => client.requests.get().map((request) => request.id).join() === 'second');

        client.dispose();
    });

    it('filters unsatisfiable roots and positively acknowledges decisions', async () => {
        const manifest = new FakeManifest();
        manifest.requested = {
            accepted: direct('accepted', ['id:key:admin']),
            other: direct('other', ['id:key:other']),
            impossible: direct('impossible', []),
        };
        const client = new ApproveClient({
            manifest: manifest.client,
            ownPrincipalId: 'id:key:admin',
        });

        await waitFor(() => client.state.get() === 'live');
        expect(client.requests.get().map((request) => request.id)).toEqual(['accepted']);
        expect(await client.decide('accepted', { status: 'denied', reason: 'test' })).toBe('applied');
        expect(manifest.decisions).toEqual([{
            id: 'accepted',
            value: { status: 'denied', reason: 'test' },
        }]);
        expect(await client.decide('missing', { status: 'denied' })).toBe('gone');

        client.dispose();
    });

    it('reconnects a completed watch and refreshes missed changes', async () => {
        const manifest = new FakeManifest();
        const client = new ApproveClient({
            manifest: manifest.client,
            reconnectDelayMs: 1,
        });
        await waitFor(() => manifest.watchCount === 1);

        manifest.endWatch();
        manifest.requested = { afterReconnect: direct('afterReconnect') };
        manifest.revision++;

        await waitFor(() => manifest.watchCount >= 2);
        await waitFor(() => client.requests.get()[0]?.id === 'afterReconnect');

        client.dispose();
    });

    it('distinguishes an accepted decision from a matching request that remains pending', async () => {
        const manifest = new FakeManifest();
        manifest.requested = { retried: direct('retried') };
        manifest.keepDecidedRequests = true;
        const client = new ApproveClient({ manifest: manifest.client });
        await waitFor(() => client.requests.get().length === 1);

        expect(await client.decide('retried', { status: 'denied' })).toBe('still-pending');
        expect(manifest.decisions).toHaveLength(1);
        expect(client.requests.get().map((request) => request.id)).toEqual(['retried']);

        client.dispose();
    });
});

function idleWatch(): ReturnType<IHubAccessManifest['watchCurrent']> {
    const promise = new Promise<Record<string, never>>(() => { /* remains open */ });
    return Object.assign(promise, {
        requestId: Promise.resolve(1 as never),
        send: async (_value: never) => { /* no client stream */ },
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
