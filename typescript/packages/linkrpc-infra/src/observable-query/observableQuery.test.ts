import { defineInterface, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { number, object, string } from 'zod/mini';
import { describe, expect, it, vi } from 'vitest';
import {
    OBSERVABLE_QUERY_INTERFACE_TAG,
    OBSERVABLE_QUERY_TEMPLATE_ID,
    ObservableQueryTemplate,
    observableQueryHandlers,
    type ObservableQuerySource,
} from './index';

class Scores implements ObservableQuerySource<{ player: string }, number> {
    private readonly _values = new Map<string, number>();
    private readonly _listeners = new Set<{ player: string; listener: () => void }>();
    get({ player }: { player: string }): Promise<number> {
        return Promise.resolve(this._values.get(player) ?? 0);
    }
    set(player: string, value: number): void {
        this._values.set(player, value);
        for (const entry of this._listeners) if (entry.player === player) entry.listener();
    }
    get listenerCount(): number { return this._listeners.size; }
    subscribe({ player }: { player: string }, listener: () => void): () => void {
        const entry = { player, listener };
        this._listeners.add(entry);
        return () => this._listeners.delete(entry);
    }
}

const gameInterface = defineInterface({ id: 'test.game' }, {
    score: ObservableQueryTemplate({ params: object({ player: string() }), value: number() }),
});

function setup(source: Scores) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    server.register(gameInterface, { score: observableQueryHandlers(source) }, { serviceId: 'test/game' });
    return client.get(gameInterface, { serviceId: 'test/game' });
}

describe('ObservableQueryTemplate', () => {
    it('instantiates as get/watch wire methods and tags the interface', () => {
        const schema = gameInterface.toSchema();
        expect({
            methods: Object.keys(schema.methods).sort(),
            tags: gameInterface.info.tags,
            instances: (schema['x-interface-templates'] as { instances: unknown[] }).instances,
        }).toEqual({
            methods: ['score$get', 'score$watch'],
            tags: [OBSERVABLE_QUERY_INTERFACE_TAG],
            instances: [expect.objectContaining({ template: OBSERVABLE_QUERY_TEMPLATE_ID, members: { get: 'score$get', watch: 'score$watch' } })],
        });
    });

    it('reads and streams the value of the given params only, until cancelled', async () => {
        const source = new Scores();
        source.set('ann', 1);
        const game = setup(source);
        expect(await game.score.get({ params: { player: 'ann' } })).toEqual({ value: 1 });
        const values: number[] = [];
        const call = game.score.watch({ params: { player: 'ann' } }, { onMessage: ({ value }) => { values.push(value); } });
        const settled = Promise.resolve(call).catch(() => 'cancelled');
        await vi.waitFor(() => expect(values).toEqual([1]));
        source.set('bob', 5);
        source.set('ann', 1);
        source.set('ann', 2);
        await vi.waitFor(() => expect(values).toEqual([1, 2]));
        call.cancel();
        await settled;
        await vi.waitFor(() => expect(source.listenerCount).toBe(0));
    });
});
