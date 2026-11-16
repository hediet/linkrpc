import { defineInterface, LinkRpcConnection, requestType, TransportPair } from '@hediet/linkrpc';
import { number, object, string } from 'zod/mini';
import { describe, expect, it, vi } from 'vitest';
import {
    OBSERVABLE_VALUE_INTERFACE_TAG,
    OBSERVABLE_VALUE_TEMPLATE_ID,
    ObservableValueTemplate,
    observableValueHandlers,
    type ObservableValueSource,
} from './index';

class Counter implements ObservableValueSource<number> {
    private readonly _listeners = new Set<() => void>();
    constructor(private _value: number) { }
    get(): number { return this._value; }
    set(value: number): void {
        this._value = value;
        for (const listener of this._listeners) listener();
    }
    get listenerCount(): number { return this._listeners.size; }
    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }
}

const metricsInterface = defineInterface({ id: 'test.metrics' }, {
    name: requestType(object({}), string()),
    rate: ObservableValueTemplate({ value: number() }),
});

function setup(source: Counter, minIntervalMs?: number) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    server.register(metricsInterface, {
        name: () => 'metrics',
        rate: observableValueHandlers(source, { minIntervalMs }),
    }, { serviceId: 'test/metrics' });
    return client.get(metricsInterface, { serviceId: 'test/metrics' });
}

describe('ObservableValueTemplate', () => {
    it('instantiates as get/watch wire methods and tags the interface', () => {
        const schema = metricsInterface.toSchema();
        expect({
            methods: Object.keys(schema.methods).sort(),
            tags: metricsInterface.info.tags,
            instances: (schema['x-interface-templates'] as { instances: unknown[] }).instances,
        }).toEqual({
            methods: ['name', 'rate$get', 'rate$watch'],
            tags: [OBSERVABLE_VALUE_INTERFACE_TAG],
            instances: [expect.objectContaining({ template: OBSERVABLE_VALUE_TEMPLATE_ID, members: { get: 'rate$get', watch: 'rate$watch' } })],
        });
    });

    it('reads the value and streams the current value, then changes, until cancelled', async () => {
        const source = new Counter(1);
        const metrics = setup(source);
        expect(await metrics.rate.get({})).toEqual({ value: 1 });
        const values: number[] = [];
        const call = metrics.rate.watch({}, { onMessage: ({ value }) => { values.push(value); } });
        const settled = Promise.resolve(call).catch(() => 'cancelled');
        await vi.waitFor(() => expect(values).toEqual([1]));
        source.set(2);
        source.set(2);
        await vi.waitFor(() => expect(values).toEqual([1, 2]));
        source.set(3);
        await vi.waitFor(() => expect(values).toEqual([1, 2, 3]));
        call.cancel();
        await settled;
        await vi.waitFor(() => expect(source.listenerCount).toBe(0));
    });

    it('coalesces rapid changes to the latest value', async () => {
        const source = new Counter(0);
        const metrics = setup(source, 100);
        const values: number[] = [];
        const call = metrics.rate.watch({}, { onMessage: ({ value }) => { values.push(value); } });
        const settled = Promise.resolve(call).catch(() => 'cancelled');
        await vi.waitFor(() => expect(values).toEqual([0]));
        for (let i = 1; i <= 10; i++) source.set(i);
        await vi.waitFor(() => expect(values).toEqual([0, 10]));
        call.cancel();
        await settled;
    });
});
