import { describe, expect, it } from 'vitest';
import type { StreamApi } from '@hediet/linkrpc';
import { RootWatchCoordinator, type GraphLease, type RootAccept, type RootOffer } from './index';

class Retention {
    readonly counts = new Map<string, number>();
    retainClosure(ref: string): GraphLease {
        this.counts.set(ref, (this.counts.get(ref) ?? 0) + 1);
        let disposed = false;
        return { dispose: () => {
            if (disposed) return;
            disposed = true;
            const count = this.counts.get(ref)!;
            if (count === 1) this.counts.delete(ref);
            else this.counts.set(ref, count - 1);
        } };
    }
}
function fixture() {
    const sent: RootOffer<string>[] = [];
    const abort = new AbortController();
    let listener: (message: RootAccept) => void = () => {};
    const stream: StreamApi<RootAccept, RootOffer<string>> = {
        send: async offer => { sent.push(offer); },
        onMessage: next => { listener = next; },
        ping: async () => {}, signal: abort.signal,
    };
    return { sent, abort, stream, accept: (version: number) => listener({ accept: version }) };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const options = (retention = new Retention()) => ({
    paramsKey: (params: string) => params, sameRef: (a: string, b: string) => a === b, retention,
});

describe('root watch coordinator', () => {
    it('streams newest roots without acknowledgements and coalesces while a send is in flight', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator(opts);
        const f = fixture();
        let unblock!: () => void;
        const blocked = new Promise<void>(resolve => { unblock = resolve; });
        let sends = 0;
        f.stream.send = async offer => { f.sent.push(offer); if (sends++ === 0) await blocked; };
        coordinator.publish('root', 'one');
        const watching = coordinator.watch('root', f.stream);
        await flush();
        coordinator.publish('root', 'two');
        coordinator.publish('root', 'three');
        await flush();
        expect(f.sent.map(offer => offer.ref)).toEqual(['one']);
        unblock();
        await flush();
        expect(f.sent.map(offer => offer.ref)).toEqual(['one', 'three']);
        expect([...opts.retention.counts.keys()]).toEqual(['one', 'three']);
        f.abort.abort();
        await expect(watching).resolves.toEqual({});
        expect(opts.retention.counts.size).toBe(0);
    });

    it('acknowledgements release older roots early and stale or unknown versions are ignored', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator({ ...opts, supersededGraceMs: 60_000 });
        const f = fixture();
        coordinator.publish('root', 'one');
        const watching = coordinator.watch('root', f.stream);
        await flush();
        coordinator.publish('root', 'two');
        await flush();
        coordinator.publish('root', 'three');
        await flush();
        expect([...opts.retention.counts.keys()]).toEqual(['one', 'two', 'three']);
        f.accept(999);
        f.accept(f.sent[0]!.version);
        await flush();
        expect([...opts.retention.counts.keys()]).toEqual(['one', 'two', 'three']);
        f.accept(f.sent[1]!.version);
        await flush();
        expect([...opts.retention.counts.keys()]).toEqual(['two', 'three']);
        f.accept(f.sent[0]!.version);
        f.accept(f.sent[2]!.version);
        await flush();
        expect([...opts.retention.counts.keys()]).toEqual(['three']);
        f.abort.abort();
        await watching;
    });

    it('superseded roots expire after the grace period only once their successor was sent', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator({ ...opts, supersededGraceMs: 5 });
        const f = fixture();
        coordinator.publish('root', 'one');
        const watching = coordinator.watch('root', f.stream);
        await flush();
        let unblock!: () => void;
        f.stream.send = offer => { f.sent.push(offer); return new Promise<void>(resolve => { unblock = resolve; }); };
        coordinator.publish('root', 'two');
        await sleep(20);
        expect([...opts.retention.counts.keys()]).toEqual(['one', 'two']);
        unblock();
        await flush();
        expect([...opts.retention.counts.keys()]).toEqual(['one', 'two']);
        await sleep(20);
        expect([...opts.retention.counts.keys()]).toEqual(['two']);
        f.abort.abort();
        await watching;
    });

    it('bounds superseded roots per watcher, releasing the oldest first', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator({ ...opts, supersededGraceMs: 60_000, maxSuperseded: 2 });
        const f = fixture();
        const watching = coordinator.watch('root', f.stream);
        for (const ref of ['one', 'two', 'three', 'four', 'five']) {
            coordinator.publish('root', ref);
            await flush();
        }
        expect(f.sent.map(offer => offer.ref)).toEqual(['one', 'two', 'three', 'four', 'five']);
        expect([...opts.retention.counts.keys()]).toEqual(['three', 'four', 'five']);
        f.abort.abort();
        await watching;
        expect(opts.retention.counts.size).toBe(0);
    });

    it('drops pending roots when publication returns to the outstanding offer', async () => {
        const coordinator = new RootWatchCoordinator(options());
        const f = fixture();
        coordinator.publish('root', 'one');
        const watching = coordinator.watch('root', f.stream);
        coordinator.publish('root', 'two');
        coordinator.publish('root', 'one');
        await flush();
        f.accept(f.sent[0]!.version);
        await flush();
        expect(f.sent.map(offer => offer.ref)).toEqual(['one']);
        f.abort.abort();
        await watching;
    });

    it('isolates parameter keys and watcher lifetimes', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator(opts);
        coordinator.publish('a', 'one');
        coordinator.publish('b', 'two');
        const a = fixture(), b = fixture(), otherA = fixture();
        const watches = [coordinator.watch('a', a.stream), coordinator.watch('b', b.stream),
            coordinator.watch('a', otherA.stream)];
        await flush();
        expect(opts.retention.counts).toEqual(new Map([['one', 2], ['two', 1]]));
        a.abort.abort();
        await watches[0];
        expect(opts.retention.counts.get('one')).toBe(1);
        otherA.abort.abort();
        b.abort.abort();
        await Promise.all(watches);
        expect(opts.retention.counts.size).toBe(0);
    });

    it('settles an already cancelled watch without retaining or sending', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator(opts);
        coordinator.publish('root', 'one');
        const f = fixture();
        f.abort.abort();
        await coordinator.watch('root', f.stream);
        coordinator.publish('root', 'two');
        await flush();
        expect(f.sent).toEqual([]);
        expect(opts.retention.counts.size).toBe(0);
    });

    it('cancels while retention is pending and disposes the late lease without sending', async () => {
        let release!: (lease: GraphLease) => void;
        let disposed = false;
        const coordinator = new RootWatchCoordinator({
            ...options(), retention: { retainClosure: () => new Promise<GraphLease>(resolve => { release = resolve; }) },
        });
        coordinator.publish('root', 'one');
        const f = fixture();
        const watching = coordinator.watch('root', f.stream);
        await flush();
        f.abort.abort();
        await watching;
        release({ dispose: () => { disposed = true; } });
        await flush();
        expect(disposed).toBe(true);
        expect(f.sent).toEqual([]);
    });

    it('cancels a blocked send and releases its lease without waiting for transport progress', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator(opts);
        coordinator.publish('root', 'one');
        const f = fixture();
        let release!: () => void;
        f.stream.send = () => new Promise<void>(resolve => { release = resolve; });
        const watching = coordinator.watch('root', f.stream);
        await flush();
        f.abort.abort();
        await watching;
        expect(opts.retention.counts.size).toBe(0);
        release();
    });

    it('releases retained roots on send failure', async () => {
        const opts = options();
        const coordinator = new RootWatchCoordinator(opts);
        coordinator.publish('root', 'one');
        const f = fixture();
        f.stream.send = async () => { throw new Error('send failed'); };
        await expect(coordinator.watch('root', f.stream)).rejects.toThrow('send failed');
        expect(opts.retention.counts.size).toBe(0);
        coordinator.publish('root', 'two');
        await flush();
        expect(opts.retention.counts.size).toBe(0);
    });

    it('attempts both retained leases when synchronous and asynchronous cleanup fail', async () => {
        const disposed: string[] = [];
        const coordinator = new RootWatchCoordinator({
            ...options(), retention: { retainClosure: (ref: string) => ({
                dispose() {
                    disposed.push(ref);
                    if (ref === 'one') throw new Error('sync cleanup');
                    return Promise.reject(new Error('async cleanup'));
                },
            }) },
        });
        coordinator.publish('root', 'one');
        const f = fixture();
        const watching = coordinator.watch('root', f.stream);
        await flush();
        f.accept(f.sent[0]!.version);
        coordinator.publish('root', 'two');
        await flush();
        f.abort.abort();
        await expect(watching).rejects.toThrow('Root watch failed');
        expect(disposed).toEqual(['one', 'two']);
    });
});
