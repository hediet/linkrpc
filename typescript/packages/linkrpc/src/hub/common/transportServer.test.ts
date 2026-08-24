import { describe, expect, it } from 'vitest';
import { mapTransport } from './transportServer';
import type { Transport } from './transportServer';
import { fakeConnection, FakeTransportServer, flush } from './testUtil';

/** A transport tagged with a value, for asserting the mapped output. */
type Tagged = Transport & { readonly tag: string; };

describe('mapTransport', () => {
    it('applies a synchronous map and forwards the result', async () => {
        const source = new FakeTransportServer<Transport>();
        const mapped = mapTransport(source, (t) => Object.assign(t, { tag: 'x' }) as Tagged);

        const received: Tagged[] = [];
        mapped.setConnectionHandler((t) => received.push(t));

        const { server } = fakeConnection();
        source.emit(server);
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0].tag).toBe('x');
        // Identity is preserved (same reference) so routing keys stay stable.
        expect(received[0]).toBe(server);
    });

    it('awaits an async map before forwarding', async () => {
        const source = new FakeTransportServer<Transport>();
        const mapped = mapTransport(source, async (t) => {
            await Promise.resolve();
            return Object.assign(t, { tag: 'async' }) as Tagged;
        });

        const received: Tagged[] = [];
        mapped.setConnectionHandler((t) => received.push(t));

        const { server } = fakeConnection();
        source.emit(server);
        expect(received).toHaveLength(0); // not yet — map is pending
        await flush();
        expect(received).toHaveLength(1);
        expect(received[0].tag).toBe('async');
    });

    it('drops a connection when the map returns undefined', async () => {
        const source = new FakeTransportServer<Transport>();
        const mapped = mapTransport(source, (t) =>
            ((t as Tagged).tag === 'keep' ? t : undefined),
        );

        const received: Transport[] = [];
        mapped.setConnectionHandler((t) => received.push(t));

        const a = fakeConnection().server;
        const b = Object.assign(fakeConnection().server, { tag: 'keep' });
        source.emit(a);
        source.emit(b);
        await flush();

        expect(received).toEqual([b]);
    });

    it('disposes the source when disposed', () => {
        const source = new FakeTransportServer<Transport>();
        const mapped = mapTransport(source, (t) => t);
        mapped.dispose();
        expect(source.disposed).toBe(true);
    });
});
