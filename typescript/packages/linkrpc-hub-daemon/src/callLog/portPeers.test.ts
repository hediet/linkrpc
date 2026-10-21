import type { TopologyGraph } from '@hediet/linkrpc/inspection';
import { describe, expect, it } from 'vitest';
import { PortPeers } from './portPeers';

/** Shaped like a live daemon hub: a described participant behind a root overlay, and the daemon's own attached link. */
const graph: TopologyGraph = {
    observerServiceId: '',
    entryNodeId: 'hub',
    nodes: [
        { nodeId: 'hub', kind: 'hub', ports: [{ portId: 'p-compute', label: 'hediet/pc2/compute' }, { portId: 'p-daemon', label: 'hediet/pc2/daemon' }] },
        { nodeId: 'overlay', kind: 'hub', ports: [{ portId: 'p-compute' }, { portId: 'participant' }, { portId: 'root' }] },
        {
            nodeId: 'peer',
            ports: [{ portId: 'peer-port' }],
            descriptors: [{ source: 'attacher', descriptor: { type: 'linkrpc.hubDaemon.service', label: 'compute' } }],
        },
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

describe('PortPeers', () => {
    it('finds the transport and descriptor behind an overlay and remembers them after the port is gone', () => {
        let current = graph;
        let reads = 0;
        const peers = new PortPeers(() => { reads++; return current; });
        peers.observe('p-compute');
        peers.observe('p-daemon');
        current = { ...graph, nodes: [], links: [] };
        peers.observe('p-unknown');
        peers.observe('p-unknown');
        expect({
            compute: peers.describe('p-compute'),
            daemon: peers.describe('p-daemon'),
            unknown: peers.describe('p-unknown'),
            reads,
        }).toMatchInlineSnapshot(`
          {
            "compute": {
              "descriptor": {
                "label": "compute",
                "type": "linkrpc.hubDaemon.service",
              },
              "transport": "websocket 10.0.0.2:5000 (for 198.51.100.4)",
            },
            "daemon": {},
            "reads": 2,
            "unknown": {},
          }
        `);
    });
});
