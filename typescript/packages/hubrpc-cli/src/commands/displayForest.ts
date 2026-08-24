export interface DisplayForestNode<TNode, TEdge> {
    readonly node: TNode;
    readonly parentEdge?: TEdge;
    readonly children: readonly DisplayForestNode<TNode, TEdge>[];
}

export interface DisplayForest<TNode, TEdge> {
    readonly roots: readonly DisplayForestNode<TNode, TEdge>[];
    readonly crossEdges: readonly TEdge[];
}

export interface DisplayGraph<TNode, TEdge> {
    readonly nodes: readonly TNode[];
    readonly edges: readonly TEdge[];
    readonly rootIds: readonly string[];
    nodeId(node: TNode): string;
    edgeKey(edge: TEdge): string;
    edgeEndpoints(edge: TEdge): readonly [string, string];
    readonly directed?: boolean;
}

/**
 * Projects a graph into a deterministic shortest-path forest. Every node is
 * rendered once; non-tree edges remain available as explicit cross-links.
 */
export function createDisplayForest<TNode, TEdge>(
    graph: DisplayGraph<TNode, TEdge>,
): DisplayForest<TNode, TEdge> {
    const nodes = new Map(graph.nodes.map((node) => [graph.nodeId(node), node]));
    const edges = [...graph.edges].sort((a, b) => graph.edgeKey(a).localeCompare(graph.edgeKey(b)));
    const adjacency = new Map<string, Array<{ edge: TEdge; next: string }>>();
    for (const edge of edges) {
        const [from, to] = graph.edgeEndpoints(edge);
        if (nodes.has(from) && nodes.has(to)) {
            addAdjacent(adjacency, from, edge, to);
            if (graph.directed !== true) addAdjacent(adjacency, to, edge, from);
        }
    }
    for (const entries of adjacency.values()) {
        entries.sort((a, b) =>
            a.next.localeCompare(b.next)
            || graph.edgeKey(a.edge).localeCompare(graph.edgeKey(b.edge)));
    }

    const parent = new Map<string, { parentId: string; edge: TEdge }>();
    const visited = new Set<string>();
    const roots: string[] = [];
    const walk = (rootId: string): void => {
        if (visited.has(rootId) || !nodes.has(rootId)) return;
        roots.push(rootId);
        visited.add(rootId);
        const queue = [rootId];
        for (let index = 0; index < queue.length; index++) {
            const current = queue[index];
            for (const entry of adjacency.get(current) ?? []) {
                if (visited.has(entry.next)) continue;
                visited.add(entry.next);
                parent.set(entry.next, { parentId: current, edge: entry.edge });
                queue.push(entry.next);
            }
        }
    };

    for (const rootId of [...new Set(graph.rootIds)].sort()) walk(rootId);
    for (const nodeId of [...nodes.keys()].sort()) walk(nodeId);

    const children = new Map<string, string[]>();
    for (const [nodeId, value] of parent) {
        const entries = children.get(value.parentId) ?? [];
        entries.push(nodeId);
        children.set(value.parentId, entries);
    }
    for (const entries of children.values()) entries.sort();

    const build = (nodeId: string): DisplayForestNode<TNode, TEdge> => ({
        node: nodes.get(nodeId)!,
        ...(parent.get(nodeId) !== undefined ? { parentEdge: parent.get(nodeId)!.edge } : {}),
        children: (children.get(nodeId) ?? []).map(build),
    });
    const treeEdgeKeys = new Set([...parent.values()].map((value) => graph.edgeKey(value.edge)));
    return {
        roots: roots.map(build),
        crossEdges: edges.filter((edge) => !treeEdgeKeys.has(graph.edgeKey(edge))),
    };
}

function addAdjacent<TEdge>(
    adjacency: Map<string, Array<{ edge: TEdge; next: string }>>,
    from: string,
    edge: TEdge,
    next: string,
): void {
    const entries = adjacency.get(from) ?? [];
    entries.push({ edge, next });
    adjacency.set(from, entries);
}
