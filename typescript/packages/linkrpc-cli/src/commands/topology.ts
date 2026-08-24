import { LinkRpcConnection } from "@hediet/linkrpc";
import type {
    NetworkTopologyGraph,
    SourcedTopologyLink,
    SourcedTopologyNode,
    TopologyNetworkSnapshot,
} from "@hediet/linkrpc/hub/client";
import { TopologyNetworkClient } from "@hediet/linkrpc/hub/client";
import type { CliChannel } from "@hediet/linkrpc-client";
import { formatJson } from "../output";
import { createDisplayForest, type DisplayForestNode } from "./displayForest";
import { StateJsonlWriter } from "./stateJsonl";

export type TopologyFormat = "pretty" | "json" | "jsonl";

export interface TopologyCommandOptions {
    readonly sources?: readonly string[];
    readonly maxDepth?: number;
    readonly watch?: boolean;
    readonly format?: TopologyFormat;
    readonly nodeId?: string;
    readonly serviceId?: string;
    readonly kind?: "hub" | "endpoint";
    readonly search?: string;
    readonly emitLine?: (line: string) => void | Promise<void>;
    readonly emitFrame?: (frame: string) => void | Promise<void>;
    readonly onState?: (state: TopologyNetworkSnapshot) => void;
    readonly stop?: Promise<void>;
}

export async function topologyCommand(
    channel: CliChannel,
    options: TopologyCommandOptions = {},
): Promise<string> {
    const format = options.format ?? "pretty";
    compileTopologySearch(options.search);
    if (format === "jsonl" && options.emitLine === undefined) {
        throw new Error("JSONL topology output requires an output sink");
    }
    if (options.watch === true && options.stop === undefined) {
        throw new Error("topology watch requires a stop signal");
    }
    if (options.watch === true && format === "pretty" && options.emitFrame === undefined) {
        throw new Error("pretty topology watch requires a frame output sink");
    }

    const connection = new LinkRpcConnection(channel);
    const client = new TopologyNetworkClient(connection);
    const writer = format === "jsonl" ? new StateJsonlWriter(options.emitLine!) : undefined;
    let latest: TopologyNetworkSnapshot | undefined;
    let outputQueue = Promise.resolve();
    const consume = (snapshot: TopologyNetworkSnapshot): void => {
        latest = filterTopologySnapshot(snapshot, options);
        options.onState?.(latest);
        if (writer !== undefined) {
            writer.write(latest, latest.revision);
        } else if (options.watch === true && format === "pretty") {
            const frame = renderTopology(latest);
            outputQueue = outputQueue.then(() => options.emitFrame!(frame));
        }
    };
    const sourceOptions = {
        ...(options.sources !== undefined ? { sourceServiceIds: options.sources } : {}),
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    };

    if (options.watch === true) {
        const watch = client.watch(sourceOptions);
        const unsubscribe = watch.subscribe(consume);
        try {
            await options.stop;
        } finally {
            await watch.cancel("topology CLI stopped");
            unsubscribe();
        }
    } else {
        latest = await client.query(sourceOptions, { onSnapshot: consume });
        latest = filterTopologySnapshot(latest, options);
    }

    await outputQueue;
    await writer?.whenIdle();
    const snapshot = latest ?? filterTopologySnapshot(
        await client.query(sourceOptions),
        options,
    );
    if (format === "json") return formatJson(snapshot);
    if (format === "pretty") return options.watch === true ? "" : renderTopology(snapshot);
    return "";
}

export function filterTopologySnapshot(
    snapshot: TopologyNetworkSnapshot,
    options: Pick<TopologyCommandOptions, "nodeId" | "serviceId" | "kind" | "search">,
): TopologyNetworkSnapshot {
    const hasFilter = options.nodeId !== undefined
        || options.serviceId !== undefined
        || options.kind !== undefined
        || options.search !== undefined;
    if (!hasFilter) return snapshot;
    const search = compileTopologySearch(options.search);
    const graph = snapshot.graph;
    const routesByNode = new Map<string, NetworkTopologyGraph["routes"]>();
    for (const route of graph.routes) {
        const routes = routesByNode.get(route.nodeId) ?? [];
        routesByNode.set(route.nodeId, [...routes, route]);
    }
    const matchingNodeIds = new Set(graph.nodes
        .filter((node) => {
            const routes = routesByNode.get(node.nodeId) ?? [];
            return (options.nodeId === undefined || node.nodeId === options.nodeId)
            && (options.kind === undefined || node.kind === options.kind)
            && (options.serviceId === undefined
                || routes.some((route) => route.serviceId === options.serviceId))
            && (search === undefined || search.test(JSON.stringify({
                node,
                routes,
            })));
        })
        .map((node) => node.nodeId));
    const nodes = graph.nodes.filter((node) => matchingNodeIds.has(node.nodeId));
    const nodeIds = new Set(nodes.map((node) => node.nodeId));
    return {
        ...snapshot,
        graph: {
            ...graph,
            nodes,
            links: graph.links.filter((link) =>
                nodeIds.has(link.from.nodeId) && nodeIds.has(link.to.nodeId)),
            routes: graph.routes.filter((route) =>
                nodeIds.has(route.nodeId)
                && (options.serviceId === undefined || route.serviceId === options.serviceId)),
        },
    };
}

function compileTopologySearch(search: string | undefined): RegExp | undefined {
    if (search === undefined) return undefined;
    try {
        return new RegExp(search, "i");
    } catch (error) {
        throw new Error(
            `Invalid topology search regexp: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

export function renderTopology(snapshot: TopologyNetworkSnapshot): string {
    const sourceLines = snapshot.sources.map((source) => {
        const marker = source.state === "ready" ? "✓" : source.state === "loading" ? "…" : "!";
        return `  ${marker} ${source.serviceId}${source.error ? ` — ${source.error}` : ""}`;
    });
    const forest = createDisplayForest({
        nodes: snapshot.graph.nodes,
        edges: snapshot.graph.links,
        rootIds: snapshot.graph.sources.map((source) => source.entryNodeId),
        nodeId: (node) => node.nodeId,
        edgeKey: topologyLinkKey,
        edgeEndpoints: (link) => [link.from.nodeId, link.to.nodeId],
    });
    const routeMap = new Map<string, NetworkTopologyGraph["routes"]>();
    for (const route of snapshot.graph.routes) {
        const routes = routeMap.get(route.nodeId) ?? [];
        routeMap.set(route.nodeId, [...routes, route]);
    }
    const treeLines: string[] = [];
    for (const root of forest.roots) renderTopologyNode(root, routeMap, treeLines, "");
    if (forest.crossEdges.length > 0) {
        treeLines.push("", "Additional links");
        for (const link of forest.crossEdges) {
            treeLines.push(`  ${formatEndpoint(link.from)} ↔ ${formatEndpoint(link.to)}`);
        }
    }
    const status = snapshot.complete ? "complete" : "loading";
    return [
        `LinkRPC topology (${status}, revision ${snapshot.revision})`,
        "",
        "Sources",
        ...(sourceLines.length > 0 ? sourceLines : ["  (none)"]),
        "",
        "Network",
        ...(treeLines.length > 0 ? treeLines : ["  (empty)"]),
    ].join("\n");
}

function renderTopologyNode(
    item: DisplayForestNode<SourcedTopologyNode, SourcedTopologyLink>,
    routes: ReadonlyMap<string, NetworkTopologyGraph["routes"]>,
    lines: string[],
    prefix: string,
): void {
    const label = participantLabel(item.node);
    lines.push(`${prefix}${label} [${item.node.kind ?? "unknown"}]`);
    for (const route of routes.get(item.node.nodeId) ?? []) {
        lines.push(`${prefix}  ${route.match.padEnd(6)} ${route.serviceId} → ${route.portId}`);
    }
    for (let index = 0; index < item.children.length; index++) {
        const child = item.children[index];
        const last = index === item.children.length - 1;
        const branch = last ? "└─ " : "├─ ";
        const childPrefix = prefix + (last ? "   " : "│  ");
        const childLines: string[] = [];
        renderTopologyNode(child, routes, childLines, childPrefix);
        childLines[0] = `${prefix}${branch}${childLines[0].slice(childPrefix.length)}`;
        lines.push(...childLines);
    }
}

function participantLabel(node: SourcedTopologyNode): string {
    for (const source of node.descriptors ?? []) {
        if (source.descriptor.label !== undefined) return source.descriptor.label;
    }
    return node.label ?? node.nodeId;
}

function topologyLinkKey(link: SourcedTopologyLink): string {
    const endpoints = [formatEndpoint(link.from), formatEndpoint(link.to)].sort();
    return `${endpoints[0]}\0${endpoints[1]}`;
}

function formatEndpoint(endpoint: { readonly nodeId: string; readonly portId: string }): string {
    return `${endpoint.nodeId}:${endpoint.portId}`;
}
