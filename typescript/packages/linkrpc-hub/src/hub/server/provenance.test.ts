import { describe, expect, it } from 'vitest';
import { withProvenance } from './provenance';
import type { ConnectionProvenance, ConnectionProvenanceProvider, WithProvenance } from './provenance';
import type { Transport } from '@hediet/linkrpc/hub/common';
import { fakeConnection, FakeTransportServer, flush } from './testUtil';

function provider(
    impl: (t: Transport) => Promise<ConnectionProvenance | { error: string; }>,
    namespace = 'docker',
): ConnectionProvenanceProvider<Transport> {
    return { identityNamespace: namespace, resolve: (t) => impl(t) };
}

describe('withProvenance', () => {
    it('annotates the transport with verified provenance', async () => {
        const source = new FakeTransportServer<Transport>();
        const attested = withProvenance(
            source,
            provider(async () => ({ identityKey: 'docker/echo-provider', attributes: { pid: 7 } })),
        );

        const received: WithProvenance<Transport>[] = [];
        attested.setConnectionHandler((t) => received.push(t));
        source.emit(fakeConnection().server);
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0].provenance?.identityKey).toBe('docker/echo-provider');
        expect(received[0].provenance?.attributes).toEqual({ pid: 7 });
    });

    it('treats a key outside the provider namespace as un-attested', async () => {
        const source = new FakeTransportServer<Transport>();
        const attested = withProvenance(
            source,
            // identityKey does NOT start with "docker/".
            provider(async () => ({ identityKey: 'echo-provider', attributes: {} })),
        );

        const received: WithProvenance<Transport>[] = [];
        attested.setConnectionHandler((t) => received.push(t));
        source.emit(fakeConnection().server);
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0].provenance).toBeUndefined();
    });

    it('forwards with undefined provenance on provider error', async () => {
        const source = new FakeTransportServer<Transport>();
        const attested = withProvenance(
            source,
            provider(async () => ({ error: 'no peercred' })),
        );

        const received: WithProvenance<Transport>[] = [];
        attested.setConnectionHandler((t) => received.push(t));
        source.emit(fakeConnection().server);
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0].provenance).toBeUndefined();
    });

    it('drops un-attestable connections when requireProvenance is set', async () => {
        const source = new FakeTransportServer<Transport>();
        const attested = withProvenance(
            source,
            provider(async () => ({ error: 'no peercred' })),
            { requireProvenance: true },
        );

        const received: WithProvenance<Transport>[] = [];
        attested.setConnectionHandler((t) => received.push(t));
        const { server } = fakeConnection();
        let closed = false;
        server.onDidClose(() => { closed = true; });
        source.emit(server);
        await flush();

        expect(received).toHaveLength(0);
        expect(closed).toBe(true); // disposed
    });
});
