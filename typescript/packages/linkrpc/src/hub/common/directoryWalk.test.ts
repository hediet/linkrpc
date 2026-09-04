import { describe, expect, it } from 'vitest';
import type {
    IRequestSender,
    RawStreamingCall,
    StreamSendOpts,
} from '../../connection/channel';
import type { SigningCallCtx } from '../../identity/signingSender';
import type { JsonValue } from '../../protocol/jsonValue';
import type { ServiceIdPattern } from './reflection.interfaces';
import {
    HubDirectoryExplorer,
    intersectServiceIdScopes,
    normalizeServiceIdScopes,
    serviceIdMatchesPattern,
    type HubDirectoryGraphEvent,
    type HubDirectoryGraphSnapshot,
    type ServiceListing,
} from './directoryWalk';

const DIRECTORY = 'hubrpc.directory';

describe('directory service-id scopes', () => {
    it('matches and intersects exact and segment-aware prefix patterns', () => {
        expect(serviceIdMatchesPattern('cloud/Auth', { prefix: 'cloud' })).toBe(true);
        expect(serviceIdMatchesPattern('cloudy/Auth', { prefix: 'cloud' })).toBe(false);
        expect(serviceIdMatchesPattern('cloud', { exact: 'cloud' })).toBe(true);
        expect(serviceIdMatchesPattern('cloud/Auth', { exact: 'cloud' })).toBe(false);

        expect(intersectServiceIdScopes(
            [{ prefix: 'cloud' }],
            [{ prefix: 'cloud/Auth' }, { exact: 'cloud/Storage' }, { prefix: 'cloudy' }],
        )).toEqual([
            { exact: 'cloud/Storage' },
            { prefix: 'cloud/Auth' },
        ]);
        expect(intersectServiceIdScopes(
            [{ exact: 'cloud/Auth' }],
            [{ prefix: 'cloud/Storage' }],
        )).toEqual([]);
        expect(normalizeServiceIdScopes([
            { prefix: 'cloud' },
            { prefix: 'cloud/Auth' },
            { exact: 'cloud/Auth/login' },
        ])).toEqual([{ prefix: 'cloud' }]);
    });
});

describe('HubDirectoryExplorer', () => {
    it('emits deterministic progressive reports that converge to the final graph', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [referral('cloud', [{ prefix: 'cloud' }])]);
        endpoint.set('cloud', [referral('cloud/Auth')]);
        endpoint.set('cloud/Auth', [listing('cloud/Auth', 'Auth')]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const events: HubDirectoryGraphEvent[] = [];
        let document: HubDirectoryGraphSnapshot | undefined;

        const unsubscribe = explorer.subscribe((event) => {
            events.push(event);
            document = event.snapshot;
        });

        expect(document).toMatchObject({
            complete: false,
            root: {
                target: { kind: 'root' },
                state: 'unexplored',
                nativeListings: [],
            },
            directories: [],
        });

        await explorer.explore();

        expect(events.map(eventLabel)).toEqual([
            'snapshot:subscribed',
            'node-updated:loading:root',
            'node-updated:loaded:root',
            'node-added:referral:cloud',
            'node-updated:loading:cloud',
            'node-updated:loaded:cloud',
            'node-added:referral:cloud/Auth',
            'node-updated:loading:cloud/Auth',
            'node-updated:loaded:cloud/Auth',
            'settled',
        ]);
        expect(document).toEqual(explorer.graphSnapshot);
        expect(document?.complete).toBe(true);
        expect(document?.directories.map((node) => ({
            serviceId: node.target.kind === 'addressed' ? node.target.serviceId : '',
            state: node.state,
            scopes: node.effectiveScopes,
            parents: node.parents.length,
        }))).toEqual([
            {
                serviceId: 'cloud',
                state: 'loaded',
                scopes: [{ prefix: 'cloud' }],
                parents: 1,
            },
            {
                serviceId: 'cloud/Auth',
                state: 'loaded',
                scopes: [{ prefix: 'cloud/Auth' }],
                parents: 1,
            },
        ]);
        expect(document?.directories[1]?.nativeListings).toEqual([
            listing('cloud/Auth', 'Auth'),
        ]);
        unsubscribe();
    });

    it('discovers public-root -> cloud -> Auth only through explicit listings', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [
            referral('cloud', [{ prefix: 'cloud' }]),
        ]);
        endpoint.set('cloud', [
            referral('cloud/Auth'),
        ]);
        endpoint.set('cloud/Auth', [
            listing('cloud/Auth', 'Auth'),
        ]);

        const result = await new HubDirectoryExplorer(endpoint, {}).explore();

        expect(result.listings).toEqual(expect.arrayContaining([
            expect.objectContaining({ serviceId: 'cloud/Auth', interfaceId: 'Auth' }),
        ]));
        expect(endpoint.listCalls.map((call) => call.target)).toEqual([
            undefined,
            'cloud',
            'cloud/Auth',
        ]);
        expect(endpoint.listCalls[1]?.scopes).toEqual([{ prefix: 'cloud' }]);
        expect(endpoint.listCalls[2]?.scopes).toEqual([{ prefix: 'cloud/Auth' }]);
    });

    it('does not follow the implicit root listing as an addressed directory', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [referral('', [{ prefix: '' }])]);
        const explorer = new HubDirectoryExplorer(endpoint);

        const stop = await explorer.watch(() => undefined);

        expect(explorer.graphSnapshot.directories).toEqual([]);
        expect(endpoint.listCalls.map((call) => call.target)).toEqual([
            undefined,
            undefined,
        ]);
        expect(endpoint.watchCount(undefined)).toBe(1);
        expect(endpoint.watchCount('')).toBe(0);
        stop();
        explorer.dispose();
    });

    it('reports an inaccessible initial referral before settling', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [referral('private')]);
        endpoint.fail('private', 'permission denied');
        const explorer = new HubDirectoryExplorer(endpoint);
        const events: HubDirectoryGraphEvent[] = [];
        explorer.subscribe((event) => events.push(event));

        await explorer.explore();

        expect(events.map(eventLabel)).toEqual([
            'snapshot:subscribed',
            'node-updated:loading:root',
            'node-updated:loaded:root',
            'node-added:referral:private',
            'node-updated:loading:private',
            'node-updated:inaccessible:private',
            'settled',
        ]);
        expect(explorer.graphSnapshot.directories[0]).toMatchObject({
            target: { kind: 'addressed', serviceId: 'private' },
            state: 'inaccessible',
            inaccessibleReason: 'permission denied',
            nativeListings: [],
        });
        expect(explorer.graphSnapshot.result.inaccessible).toEqual([
            { serviceId: 'private', reason: 'permission denied' },
        ]);
    });

    it('terminates cycles and unions scopes for a multi-parent directory', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [
            referral('graph/a', [{ prefix: 'graph' }, { prefix: 'services/x' }]),
            referral('graph/b', [{ prefix: 'graph' }, { prefix: 'services/y' }]),
        ]);
        endpoint.set('graph/a', [
            referral('graph/shared', [{ prefix: 'graph' }, { prefix: 'services/x' }]),
        ]);
        endpoint.set('graph/b', [
            referral('graph/shared', [{ prefix: 'graph' }, { prefix: 'services/y' }]),
        ]);
        endpoint.set('graph/shared', [
            referral('graph/a'),
            listing('services/x/api', 'x'),
            listing('services/y/api', 'y'),
            listing('services/z/api', 'z'),
        ]);

        const result = await new HubDirectoryExplorer(endpoint, { maxDepth: 8 }).explore();

        expect(result.listings.some((item) => item.interfaceId === 'x')).toBe(true);
        expect(result.listings.some((item) => item.interfaceId === 'y')).toBe(true);
        expect(result.listings.some((item) => item.interfaceId === 'z')).toBe(false);
        expect(endpoint.listCalls.filter((call) => call.target === 'graph/a')).toHaveLength(1);
        const sharedCalls = endpoint.listCalls.filter((call) => call.target === 'graph/shared');
        expect(sharedCalls).toHaveLength(2);
        expect(sharedCalls.at(-1)?.scopes).toEqual([
            { prefix: 'graph' },
            { prefix: 'services/x' },
            { prefix: 'services/y' },
        ]);
    });

    it('re-lists only a ticked directory and descendants affected by a scope change', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [
            referral('branch/a', [{ prefix: 'branch/a' }]),
            referral('branch/b', [{ prefix: 'branch/b' }]),
        ]);
        endpoint.set('branch/a', [listing('branch/a/one', 'leaf.a')]);
        endpoint.set('branch/b', [listing('branch/b/one', 'leaf.b')]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const changes: Array<string | undefined> = [];
        const stop = await explorer.watch((change) => changes.push(change.target));

        endpoint.set('branch/a', [
            listing('branch/a/one', 'leaf.a'),
            listing('branch/a/two', 'leaf.a'),
        ]);
        endpoint.emit('branch/a');
        await explorer.whenIdle();

        expect(endpoint.listCount(undefined)).toBe(2);
        expect(endpoint.listCount('branch/a')).toBe(3);
        expect(endpoint.listCount('branch/b')).toBe(2);
        expect(endpoint.watchCount('branch/b')).toBe(1);
        expect(changes).toEqual(['branch/a']);

        endpoint.set(undefined, [
            referral('branch/a', [{ exact: 'branch/a' }]),
            referral('branch/b', [{ prefix: 'branch/b' }]),
        ]);
        endpoint.emit(undefined);
        await explorer.whenIdle();

        expect(endpoint.listCount(undefined)).toBe(3);
        expect(endpoint.listCount('branch/a')).toBe(5);
        expect(endpoint.listCount('branch/b')).toBe(2);
        expect(endpoint.watchCount('branch/a')).toBe(2);
        expect(endpoint.watchCount('branch/b')).toBe(1);
        stop();
        explorer.dispose();
    });

    it('closes the initial list-to-watch handoff with a verification list', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [listing('svc/old', 'old')]);
        endpoint.afterNextList(undefined, () => {
            endpoint.set(undefined, [listing('svc/new', 'new')]);
        });
        const explorer = new HubDirectoryExplorer(endpoint);

        const stop = await explorer.watch(() => undefined);

        expect(endpoint.listCount(undefined)).toBe(2);
        expect(explorer.result.listings.some((item) => item.interfaceId === 'new')).toBe(true);
        expect(explorer.result.listings.some((item) => item.interfaceId === 'old')).toBe(false);
        stop();
        explorer.dispose();
    });

    it('shrinks scopes through a referral cycle to the root-derived least fixed point', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [
            referral('graph/a', [{ prefix: 'graph' }, { prefix: 'data' }]),
        ]);
        endpoint.set('graph/a', [
            referral('graph/b', [{ prefix: 'graph' }, { prefix: 'data' }]),
        ]);
        endpoint.set('graph/b', [
            referral('graph/a', [{ prefix: 'graph' }, { prefix: 'data' }]),
            listing('data/allowed', 'allowed'),
            listing('data/out-of-scope', 'out-of-scope'),
        ]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const stop = await explorer.watch(() => undefined);
        expect(explorer.result.listings.some((item) => item.interfaceId === 'out-of-scope'))
            .toBe(true);

        endpoint.set(undefined, [
            referral('graph/a', [{ prefix: 'graph' }, { exact: 'data/allowed' }]),
        ]);
        endpoint.emit(undefined);
        await explorer.whenIdle();

        expect(explorer.result.listings.some((item) => item.interfaceId === 'allowed')).toBe(true);
        expect(explorer.result.listings.some((item) => item.interfaceId === 'out-of-scope'))
            .toBe(false);
        expect(endpoint.listCalls.filter((call) => call.target === 'graph/a').at(-1)?.scopes)
            .toEqual([{ exact: 'data/allowed' }, { prefix: 'graph' }]);
        expect(endpoint.listCalls.filter((call) => call.target === 'graph/b').at(-1)?.scopes)
            .toEqual([{ exact: 'data/allowed' }, { prefix: 'graph' }]);
        stop();
        explorer.dispose();
    });

    it('reports later additions and deepest-first removals while retaining unchanged siblings', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [
            referral('branch/a'),
            referral('branch/b'),
        ]);
        endpoint.set('branch/a', [referral('branch/a/child')]);
        endpoint.set('branch/a/child', [listing('branch/a/child', 'leaf.a')]);
        endpoint.set('branch/b', [listing('branch/b', 'leaf.b')]);
        endpoint.set('branch/c', [listing('branch/c', 'leaf.c')]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const events: HubDirectoryGraphEvent[] = [];
        explorer.subscribe((event) => events.push(event));
        const stop = await explorer.watch(() => undefined);
        events.length = 0;

        endpoint.set(undefined, [
            referral('branch/b'),
            referral('branch/c'),
        ]);
        endpoint.emit(undefined);
        await explorer.whenIdle();

        expect(events.map(eventLabel)).toEqual([
            'snapshot:reconciliation-started',
            'node-updated:loading:root',
            'node-updated:loaded:root',
            'node-added:referral:branch/c',
            'node-updated:loading:branch/c',
            'node-updated:loaded:branch/c',
            'node-removed:unreachable:branch/a/child',
            'node-removed:unreachable:branch/a',
            'node-updated:watch-started:branch/c',
            'node-updated:loading:branch/c',
            'node-updated:loaded:branch/c',
            'settled',
        ]);
        expect(explorer.graphSnapshot.complete).toBe(true);
        expect(explorer.graphSnapshot.directories.map((node) =>
            node.target.kind === 'addressed' ? node.target.serviceId : '')).toEqual([
            'branch/b',
            'branch/c',
        ]);
        expect(endpoint.listCount('branch/b')).toBe(2);
        stop();
        explorer.dispose();
    });

    it('restarts a directory watch that ends unexpectedly', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [listing('svc', 'demo')]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const stop = await explorer.watch(() => undefined);
        expect(endpoint.watchCount(undefined)).toBe(1);

        endpoint.endWatches(undefined);
        await until(() => endpoint.watchCount(undefined) >= 2);

        endpoint.set(undefined, [listing('svc', 'demo.changed')]);
        endpoint.emit(undefined);
        await explorer.whenIdle();
        expect(explorer.result.listings).toContainEqual(expect.objectContaining({
            interfaceId: 'demo.changed',
        }));
        stop();
        explorer.dispose();
    });

    it('isolates throwing change listeners', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [listing('svc', 'before')]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const stopThrowing = await explorer.watch(() => {
            throw new Error('listener failed');
        });
        let observed = 0;
        const stopObserving = await explorer.watch(() => observed++);

        endpoint.set(undefined, [listing('svc', 'after')]);
        endpoint.emit(undefined);
        await explorer.whenIdle();

        expect(observed).toBe(1);
        stopThrowing();
        stopObserving();
        explorer.dispose();
    });
});

function listing(serviceId: string, interfaceId: string): ServiceListing {
    return { serviceId, interfaceId, hash: `hash:${interfaceId}` };
}

function referral(
    serviceId: string,
    reachableServiceIds?: readonly ServiceIdPattern[],
): ServiceListing {
    return {
        serviceId,
        interfaceId: DIRECTORY,
        hash: 'hash:directory',
        ...(reachableServiceIds === undefined ? {} : { reachableServiceIds }),
    };
}

class FakeDirectoryEndpoint implements IRequestSender<SigningCallCtx> {
    public readonly listCalls: Array<{
        target: string | undefined;
        scopes: readonly ServiceIdPattern[] | undefined;
    }> = [];
    private readonly _directories = new Map<string, readonly ServiceListing[]>();
    private readonly _failures = new Map<string, string>();
    private readonly _watchers = new Map<string, Set<() => void>>();
    private readonly _watchCalls = new Map<string, number>();
    private readonly _watchSettlers = new Map<string, Set<() => void>>();
    private readonly _afterList = new Map<string, () => void>();

    public set(target: string | undefined, items: readonly ServiceListing[]): void {
        this._directories.set(key(target), items);
        this._failures.delete(key(target));
    }

    public fail(target: string | undefined, reason: string): void {
        this._failures.set(key(target), reason);
    }

    public afterNextList(target: string | undefined, callback: () => void): void {
        this._afterList.set(key(target), callback);
    }

    public listCount(target: string | undefined): number {
        return this.listCalls.filter((call) => call.target === target).length;
    }

    public watchCount(target: string | undefined): number {
        return this._watchCalls.get(key(target)) ?? 0;
    }

    public emit(target: string | undefined): void {
        for (const watcher of this._watchers.get(key(target)) ?? []) watcher();
    }

    public endWatches(target: string | undefined): void {
        for (const settle of [...(this._watchSettlers.get(key(target)) ?? [])]) settle();
    }

    public async sendRequest(method: string, params: JsonValue | undefined): Promise<JsonValue> {
        const target = parseTarget(method, 'list');
        const scopes = (params as { serviceIdScopes?: ServiceIdPattern[] } | undefined)
            ?.serviceIdScopes;
        this.listCalls.push({ target, scopes });
        const failure = this._failures.get(key(target));
        if (failure !== undefined) throw new Error(failure);
        const items = this._directories.get(key(target)) ?? [];
        const result = {
            items: items.map((item) => ({
                serviceId: item.serviceId,
                interfaceId: item.interfaceId,
                interfaceHash: item.hash,
                ...(item.rootPrincipalSets === undefined
                    ? {}
                    : {
                        rootPrincipalSets: item.rootPrincipalSets.map((set) =>
                            set.map((requirement) => ({ ...requirement }))
                        ),
                    }),
                ...(item.reachableServiceIds === undefined
                    ? {}
                    : {
                        reachableServiceIds: item.reachableServiceIds.map((pattern) => ({
                            ...pattern,
                        })),
                    }),
            })),
        };
        const afterList = this._afterList.get(key(target));
        if (afterList !== undefined) {
            this._afterList.delete(key(target));
            afterList();
        }
        return result;
    }

    public sendRequestWithStream(
        method: string,
        _params: JsonValue | undefined,
        opts?: StreamSendOpts<SigningCallCtx>,
    ): RawStreamingCall {
        const target = parseTarget(method, 'watch');
        const targetKey = key(target);
        this._watchCalls.set(targetKey, (this._watchCalls.get(targetKey) ?? 0) + 1);
        const watchers = this._watchers.get(targetKey) ?? new Set();
        const listener = () => opts?.onStreamMessage?.({});
        watchers.add(listener);
        this._watchers.set(targetKey, watchers);
        let settle!: (value: JsonValue) => void;
        let active = true;
        const result = new Promise<JsonValue>((resolve) => {
            settle = (value) => {
                if (!active) return;
                active = false;
                watchers.delete(listener);
                settlers.delete(end);
                resolve(value);
            };
        });
        const settlers = this._watchSettlers.get(targetKey) ?? new Set<() => void>();
        const end = () => settle({});
        settlers.add(end);
        this._watchSettlers.set(targetKey, settlers);
        return {
            result,
            send: () => undefined,
            cancel: () => {
                settle({});
            },
            ping: async () => undefined,
        };
    }

    public async sendNotification(): Promise<void> {
        // Not used by directory exploration.
    }

    public close(): void {
        // Not used by directory exploration.
    }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function parseTarget(method: string, member: 'list' | 'watch'): string | undefined {
    const rootMethod = `hubrpc.directory::${member}`;
    if (method === rootMethod) return undefined;
    const suffix = `::${rootMethod}`;
    if (!method.endsWith(suffix)) throw new Error(`Unexpected method: ${method}`);
    return method.slice(0, -suffix.length);
}

function key(target: string | undefined): string {
    return target ?? '<root>';
}

function eventLabel(event: HubDirectoryGraphEvent): string {
    if (event.type === 'snapshot') return `snapshot:${event.reason}`;
    if (event.type === 'settled') return 'settled';
    const report = event.type === 'node-removed' ? event.previous : event.node;
    const target = report.target.kind === 'root' ? 'root' : report.target.serviceId;
    return `${event.type}:${event.reason}:${target}`;
}
