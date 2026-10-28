import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    RpcError,
    type IRequestSender,
    type RawStreamingCall,
    type StreamSendOpts,
} from '../../connection/channel';
import type { SigningCallCtx } from '../../identity/signingSender';
import { ErrorCode } from '../../protocol/jsonRpc';
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
    it('retains tag-only changes from a watched directory without schema calls', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [{ ...listing('svc', 'demo'), tags: ['initial'] }]);
        const explorer = new HubDirectoryExplorer(endpoint);
        const stop = await explorer.watch(() => undefined);
        expect(explorer.result.listings[0]?.tags).toEqual(['initial']);
        endpoint.set(undefined, [{ ...listing('svc', 'demo'), tags: ['updated'] }]);
        endpoint.emit(undefined);
        await explorer.whenIdle();
        expect(explorer.result.listings[0]?.tags).toEqual(['updated']);
        expect(explorer.graphSnapshot.root.nativeListings[0]?.tags).toEqual(['updated']);
        stop();
    });

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
        expect(endpoint.listCalls.map((call) => call.target)).toEqual([undefined]);
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

        expect(endpoint.listCount(undefined)).toBe(1);
        expect(endpoint.listCount('branch/a')).toBe(2);
        expect(endpoint.listCount('branch/b')).toBe(1);
        expect(endpoint.watchCount('branch/b')).toBe(1);
        expect(changes).toEqual(['branch/a']);

        endpoint.set(undefined, [
            referral('branch/a', [{ exact: 'branch/a' }]),
            referral('branch/b', [{ prefix: 'branch/b' }]),
        ]);
        endpoint.emit(undefined);
        await explorer.whenIdle();

        expect(endpoint.listCount(undefined)).toBe(2);
        expect(endpoint.listCount('branch/a')).toBe(3);
        expect(endpoint.listCount('branch/b')).toBe(1);
        expect(endpoint.watchCount('branch/a')).toBe(2);
        expect(endpoint.watchCount('branch/b')).toBe(1);
        stop();
        explorer.dispose();
    });

    it('opens the watch before the first list, so a change right after that list arrives as a tick', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [listing('svc/old', 'old')]);
        let watchesDuringFirstList: number | undefined;
        endpoint.afterNextList(undefined, () => {
            watchesDuringFirstList = endpoint.watchCount(undefined);
            endpoint.set(undefined, [listing('svc/new', 'new')]);
            endpoint.emit(undefined);
        });
        const explorer = new HubDirectoryExplorer(endpoint);
        const notified: string[][] = [];

        const stop = await explorer.watch((change) => notified.push(
            change.result.listings.map((item) => item.interfaceId).filter((id) => id === 'old' || id === 'new'),
        ));
        await explorer.whenIdle();

        expect({
            watchesDuringFirstList,
            lists: endpoint.listCount(undefined),
            old: explorer.result.listings.some((item) => item.interfaceId === 'old'),
            new: explorer.result.listings.some((item) => item.interfaceId === 'new'),
            lastNotified: notified.at(-1),
        }).toEqual({ watchesDuringFirstList: 1, lists: 2, old: false, new: true, lastNotified: ['new'] });
        stop();
        explorer.dispose();
    });

    it('lists sibling directories concurrently', async () => {
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [referral('machine/a'), referral('machine/b'), referral('machine/c')]);
        for (const machine of ['a', 'b', 'c']) endpoint.set(`machine/${machine}`, [listing(`machine/${machine}`, machine)]);
        endpoint.hang('machine/a');
        endpoint.hang('machine/b');
        endpoint.hang('machine/c');
        const explorer = new HubDirectoryExplorer(endpoint, { timeoutMs: 300 });

        const explored = explorer.explore();
        const loading = () => explorer.graphSnapshot.directories
            .filter((node) => node.state === 'loading')
            .map((node) => node.target.kind === 'addressed' ? node.target.serviceId : '');
        // One after another, only the first sibling would be loading before its 300 ms timeout.
        await until(() => loading().length === 3, 250);

        expect(loading()).toEqual(['machine/a', 'machine/b', 'machine/c']);
        await explored;
        expect(endpoint.cancelledLists.sort()).toEqual(['machine/a', 'machine/b', 'machine/c']);
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
            'node-updated:watch-started:branch/c',
            'node-updated:loaded:branch/c',
            'node-removed:unreachable:branch/a/child',
            'node-removed:unreachable:branch/a',
            'settled',
        ]);
        expect(explorer.graphSnapshot.complete).toBe(true);
        expect(explorer.graphSnapshot.directories.map((node) =>
            node.target.kind === 'addressed' ? node.target.serviceId : '')).toEqual([
            'branch/b',
            'branch/c',
        ]);
        expect(endpoint.listCount('branch/b')).toBe(1);
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

describe('HubDirectoryExplorer failed watches', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('retries a rejected watch only on its backoff schedule, re-listing once per attempt', async () => {
        vi.useFakeTimers({ now: 0 });
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [referral('static')]);
        endpoint.set('static', [listing('static', 'demo')]);
        endpoint.rejectWatches('static', watchNotFound('static'));
        const logs: string[] = [];
        const explorer = new HubDirectoryExplorer(endpoint, { log: (line) => logs.push(line) });

        const stop = await explorer.watch(() => undefined);
        await vi.advanceTimersByTimeAsync(10_000);

        expect({
            watchAttemptsAt: watchTimes(endpoint, 'static'),
            lists: endpoint.listCount('static'),
            rootWatches: endpoint.watchCount(undefined),
            staticWatching: explorer.graphSnapshot.directories[0]?.watching,
            complete: explorer.graphSnapshot.complete,
            listings: explorer.result.listings.map((item) => item.interfaceId),
        }).toMatchInlineSnapshot(`
          {
            "complete": true,
            "listings": [
              "hubrpc.directory",
              "demo",
            ],
            "lists": 6,
            "rootWatches": 1,
            "staticWatching": false,
            "watchAttemptsAt": [
              0,
              200,
              600,
              1400,
              3000,
              6200,
            ],
          }
        `);
        expect(logs.filter((line) => !line.includes('watch(static) ended: method not found')))
            .toEqual([]);
        stop();
        explorer.dispose();
    });

    it('resets the backoff once a recovered watch ticks', async () => {
        vi.useFakeTimers({ now: 0 });
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [listing('svc', 'demo')]);
        endpoint.rejectWatches(undefined, watchNotFound('<root>'));
        const explorer = new HubDirectoryExplorer(endpoint);
        const stop = await explorer.watch(() => undefined);

        await vi.advanceTimersByTimeAsync(1_000);
        endpoint.acceptWatches(undefined);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(explorer.graphSnapshot.root.watching).toBe(true);
        endpoint.emit(undefined);
        await explorer.whenIdle();
        endpoint.endWatches(undefined);
        await vi.advanceTimersByTimeAsync(1_000);

        // Failures at 0, 200, 600; accepted at 1400; ended at 2000 and retried after the initial delay.
        expect(watchTimes(endpoint, undefined)).toEqual([0, 200, 600, 1400, 2200]);
        stop();
        explorer.dispose();
    });

    it('cancels pending retries when the watch is stopped', async () => {
        vi.useFakeTimers({ now: 0 });
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [listing('svc', 'demo')]);
        endpoint.rejectWatches(undefined, watchNotFound('<root>'));
        const explorer = new HubDirectoryExplorer(endpoint);
        const stop = await explorer.watch(() => undefined);

        stop();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(watchTimes(endpoint, undefined)).toEqual([0]);
        expect(vi.getTimerCount()).toBe(0);
        explorer.dispose();
    });

    it('does not retry the watch of a directory that is no longer referred to', async () => {
        vi.useFakeTimers({ now: 0 });
        const endpoint = new FakeDirectoryEndpoint();
        endpoint.set(undefined, [referral('static')]);
        endpoint.set('static', [listing('static', 'demo')]);
        endpoint.rejectWatches('static', watchNotFound('static'));
        const explorer = new HubDirectoryExplorer(endpoint);
        const stop = await explorer.watch(() => undefined);

        endpoint.set(undefined, []);
        endpoint.emit(undefined);
        await explorer.whenIdle();
        await vi.advanceTimersByTimeAsync(60_000);

        expect({
            staticWatches: watchTimes(endpoint, 'static'),
            directories: explorer.graphSnapshot.directories.length,
            pendingTimers: vi.getTimerCount(),
        }).toEqual({ staticWatches: [0], directories: 0, pendingTimers: 0 });
        stop();
        explorer.dispose();
    });
});

function watchNotFound(target: string): RpcError {
    return new RpcError(
        `method not found: ${target}::hubrpc.directory::watch`,
        ErrorCode.methodNotFound,
        undefined,
        'remote',
    );
}

function watchTimes(endpoint: FakeDirectoryEndpoint, target: string | undefined): number[] {
    return endpoint.watchLog.filter((call) => call.target === target).map((call) => call.at);
}

it('cancels and reports a directory service that exceeds its timeout', async () => {
    const endpoint = new FakeDirectoryEndpoint();
    endpoint.set(undefined, [referral('slow')]);
    endpoint.hang('slow');
    const explorer = new HubDirectoryExplorer(endpoint, { timeoutMs: 10 });

    await explorer.explore();

    expect(endpoint.cancelledLists).toEqual(['slow']);
    expect(explorer.graphSnapshot.directories[0]).toMatchObject({
        target: { kind: 'addressed', serviceId: 'slow' },
        state: 'inaccessible',
        inaccessibleReason: "hub directory service 'slow' timed out after 10ms",
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
    private readonly _watchFailures = new Map<string, Error>();
    /** `Date.now()` of every watch request, in call order. */
    public readonly watchLog: Array<{ target: string | undefined; at: number }> = [];
    private readonly _watchSettlers = new Map<string, Set<() => void>>();
    private readonly _afterList = new Map<string, () => void>();
    private readonly _hanging = new Set<string>();
    public readonly cancelledLists: Array<string | undefined> = [];

    public set(target: string | undefined, items: readonly ServiceListing[]): void {
        this._directories.set(key(target), items);
        this._failures.delete(key(target));
    }

    public fail(target: string | undefined, reason: string): void {
        this._failures.set(key(target), reason);
    }

    /** Reject subsequent watch requests for `target` asynchronously, like a remote error response. */
    public rejectWatches(target: string | undefined, error: Error): void {
        this._watchFailures.set(key(target), error);
    }

    public acceptWatches(target: string | undefined): void {
        this._watchFailures.delete(key(target));
    }

    public hang(target: string | undefined): void {
        this._hanging.add(key(target));
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
                ...(item.tags === undefined ? {} : { tags: [...item.tags] }),
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
        params: JsonValue | undefined,
        opts?: StreamSendOpts<SigningCallCtx>,
    ): RawStreamingCall {
        if (method.endsWith('hubrpc.directory::list')) {
            const target = parseTarget(method, 'list');
            let rejectResult!: (error: Error) => void;
            const result = this._hanging.has(key(target))
                ? new Promise<JsonValue>((_resolve, reject) => { rejectResult = reject; })
                : this.sendRequest(method, params);
            return {
                result,
                send: () => undefined,
                cancel: () => {
                    this.cancelledLists.push(target);
                },
                dispose: (reason) => rejectResult?.(new Error(reason)),
                ping: async () => undefined,
            };
        }
        const target = parseTarget(method, 'watch');
        const targetKey = key(target);
        this._watchCalls.set(targetKey, (this._watchCalls.get(targetKey) ?? 0) + 1);
        this.watchLog.push({ target, at: Date.now() });
        const failure = this._watchFailures.get(targetKey);
        if (failure !== undefined) {
            return {
                result: Promise.resolve().then(() => { throw failure; }),
                send: () => undefined,
                cancel: () => undefined,
                ping: async () => undefined,
            };
        }
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
