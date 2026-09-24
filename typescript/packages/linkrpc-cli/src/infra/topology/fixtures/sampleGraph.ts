import type { TopologyGraph } from "@hediet/linkrpc/inspection";

export const sampleTopology: TopologyGraph = {
    observerServiceId: "demo",
    entryNodeId: "hub",
    nodes: [
        { nodeId: "hub", kind: "hub", label: "Explorer", ports: [{ portId: "ui", label: "Browser" }, { portId: "agent" }, { portId: "loop" }] },
        { nodeId: "ui", kind: "endpoint", label: 'Browser 漢字 😀 "\nnext"; n999["INJECTED"]', ports: [{ portId: "rpc" }, { portId: "side" }],
            descriptors: [{ source: "self", descriptor: { processType: "browser", metadata: { online: true } } }] },
        { nodeId: "agent", kind: "endpoint", label: "Agent", ports: [{ portId: "rpc" }, { portId: "side" }] },
        { nodeId: "idle", label: "Disconnected endpoint", ports: [] },
    ],
    links: [
        { from: { nodeId: "hub", portId: "ui" }, to: { nodeId: "ui", portId: "rpc" }, label: "primary",
            transport: { type: "websocket", local: { address: "127.0.0.1", port: 8080 }, remote: { address: "::1", port: 49000 } } },
        { from: { nodeId: "hub", portId: "ui" }, to: { nodeId: "ui", portId: "rpc" }, label: "parallel", peerState: "pending" },
        { from: { nodeId: "hub", portId: "agent" }, to: { nodeId: "agent", portId: "rpc" }, transport: { type: "stdio", metadata: { pid: 42 } } },
        { from: { nodeId: "agent", portId: "side" }, to: { nodeId: "ui", portId: "side" }, label: "cycle" },
        { from: { nodeId: "hub", portId: "loop" }, to: { nodeId: "hub", portId: "loop" }, label: "self" },
    ],
    routes: [{ serviceId: "agents/", nodeId: "agent", portId: "rpc", match: "prefix" }],
};
