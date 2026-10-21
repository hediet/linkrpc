import type { TopologyGraph } from '@hediet/linkrpc/inspection';
import { describe, expect, it } from 'vitest';
import { PortTransports } from './portTransports';

/** Shaped like a live daemon hub: a participant behind a root overlay, and the daemon's own attached link. */
const graph: TopologyGraph = {
    observerServiceId: '',
    entryNodeId: 'hub',
    nodes: [
        { nodeId: 'hub', kind: 'hub', ports: [{ portId: 'p-compute', label: 'hediet/pc2/compute' }, { portId: 'p-daemon', label: 'hediet/pc2/daemon' }] },
        { nodeId: 'overlay', kind: 'hub', ports: [{ portId: 'p-compute' }, { portId: 'participant' }, { portId: 'root' }] },
        { nodeId: 'peer', ports: [{ portId: 'peer-port' }] },
        { nodeId: 'root-services', kind: 'endpoint', ports: [{ portId: 'root' }] },
        { nodeId: 'daemon', ports: [{ portId: 'daemon-port' }] },
    ],
    links: [
        { from: { nodeId: 'hub', portId: 'p-compute' }, to: { nodeId: 'overlay', portId: 'p-compute' } },
        { from: { nodeId: 'overlay', portId: 'root' }, to: { nodeId: 'root-services', portId: 'root' } },
        {
            from: { nodeId: 'overlay', portId: 'participant' }, to: { nodeId: 'peer', portId: 'peer-port' },
            transport: { type: 'websocket', remote: { address: '10.0.0.2', port: 5000 }, metadata: { forwardedFor: '198.51.100.4' } },
        },
        { from: { nodeId: 'hub', portId: 'p-daemon' }, to: { nodeId: 'daemon', portId: 'daemon-port' } },
    ],
    routes: [],
};

describe('PortTransports', () => {
    it('finds the transport behind an overlay and remembers it after the port is gone', () => {
        let current = graph;
        let reads = 0;
        const transports = new PortTransports(() => { reads++; return current; });
        transports.observe('p-compute');
        transports.observe('p-daemon');
        current = { ...graph, nodes: [], links: [] };
        transports.observe('p-unknown');
        transports.observe('p-unknown');
        expect({
            compute: transports.describe('p-compute'),
            daemon: transports.describe('p-daemon'),
            unknown: transports.describe('p-unknown'),
            reads,
        }).toMatchInlineSnapshot(`
          {
            "compute": "websocket 10.0.0.2:5000 (for 198.51.100.4)",
            "daemon": undefined,
            "reads": 2,
            "unknown": undefined,
          }
        `);
    });
});
