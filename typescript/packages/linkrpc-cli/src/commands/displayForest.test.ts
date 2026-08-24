import { describe, expect, it } from "vitest";
import { createDisplayForest, type DisplayForestNode } from "./displayForest";

interface Edge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
}

describe("createDisplayForest", () => {
    it("uses deterministic shortest paths and retains non-tree links", () => {
        const edges: Edge[] = [
            { id: "z-cross", from: "b", to: "c" },
            { id: "b", from: "root", to: "b" },
            { id: "a", from: "root", to: "a" },
            { id: "a-c", from: "a", to: "c" },
        ];
        const forest = createDisplayForest({
            nodes: ["c", "root", "b", "a"],
            edges,
            rootIds: ["root"],
            nodeId: (node) => node,
            edgeKey: (edge) => edge.id,
            edgeEndpoints: (edge) => [edge.from, edge.to],
        });

        expect(flatten(forest.roots)).toEqual(["root", "a", "c", "b"]);
        expect(forest.roots[0].children.map((child) => child.node)).toEqual(["a", "b"]);
        expect(forest.roots[0].children[0].children[0].node).toBe("c");
        expect(forest.crossEdges.map((edge) => edge.id)).toEqual(["z-cross"]);
    });

    it("creates additional roots for disconnected and directed unreachable nodes", () => {
        const forest = createDisplayForest({
            nodes: ["child", "parent", "detached"],
            edges: [{ id: "edge", from: "parent", to: "child" }],
            rootIds: ["child"],
            nodeId: (node) => node,
            edgeKey: (edge) => edge.id,
            edgeEndpoints: (edge) => [edge.from, edge.to],
            directed: true,
        });

        expect(forest.roots.map((root) => root.node)).toEqual(["child", "detached", "parent"]);
        expect(forest.crossEdges.map((edge) => edge.id)).toEqual(["edge"]);
    });
});

function flatten<TNode, TEdge>(
    roots: readonly DisplayForestNode<TNode, TEdge>[],
): readonly TNode[] {
    const result: TNode[] = [];
    const visit = (node: DisplayForestNode<TNode, TEdge>): void => {
        result.push(node.node);
        for (const child of node.children) visit(child);
    };
    for (const root of roots) visit(root);
    return result;
}
