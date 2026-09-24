import { renderMermaidASCII } from "beautiful-mermaid";
import type { TopologyGraph } from "@hediet/linkrpc/inspection";
import { safeTerminalText } from "../../ui/terminalText";

export interface TopologyDocument {
    readonly lines: readonly string[];
    readonly mermaid: string;
    readonly warnings: readonly string[];
}

/** JSON-compatible escaping also neutralizes terminal C1 and bidi controls. */
export function topologyJson(value: unknown, indent?: number): string {
    return JSON.stringify(value, null, indent).replace(/[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu,
        character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

function boxHint(label: string): string {
    const text = label.replace(/[^a-zA-Z0-9 ._-]/gu, "_");
    return text.length > 26 ? `${text.slice(0, 23)}...` : text;
}

/** Only generated IDs and a bounded, allowlisted label alphabet enter Mermaid syntax. */
export function topologyDocument(graph: TopologyGraph): TopologyDocument {
    const identifiers = new Map<string, number>();
    const warnings: string[] = [];
    for (const node of graph.nodes) {
        if (identifiers.has(node.nodeId)) throw new Error(`Duplicate topology node ID: ${safeTerminalText(JSON.stringify(node.nodeId))}`);
        identifiers.set(node.nodeId, identifiers.size);
    }
    const declared = identifiers.size;
    const include = (nodeId: string) => {
        if (!identifiers.has(nodeId)) {
            identifiers.set(nodeId, identifiers.size);
            warnings.push(`Unlisted node referenced by the result: ${topologyJson(nodeId)}`);
        }
    };
    include(graph.entryNodeId);
    for (const link of graph.links) { include(link.from.nodeId); include(link.to.nodeId); }
    for (const route of graph.routes) include(route.nodeId);
    const key = (id: string) => `N${identifiers.get(id)! + 1}`;
    const definitions = [...identifiers].map(([id, index]) =>
        `n${index}["${key(id)}${index >= declared ? " unlisted" : ""}${id === graph.entryNodeId ? " entry" : ""}`
        + (index < declared ? ` - ${boxHint(graph.nodes[index]!.label ?? id)}` : "") + '"]');
    const pairs = new Set<string>();
    for (const link of graph.links) {
        const from = identifiers.get(link.from.nodeId)!, to = identifiers.get(link.to.nodeId)!;
        pairs.add(`n${Math.min(from, to)} --- n${Math.max(from, to)}`);
    }
    const mermaid = ["graph LR", ...definitions, ...pairs].join("\n");
    let diagram: string;
    if (identifiers.size > 200 || pairs.size > 400) {
        diagram = "Diagram omitted: layout exceeds 200 nodes or 400 distinct connections. Complete records follow.";
    } else {
        try {
            diagram = identifiers.size === 0 ? "(empty topology)" : renderMermaidASCII(mermaid, {
                useAscii: false, colorMode: "none", paddingX: 3, paddingY: 2, boxBorderPadding: 0,
            });
        } catch (error) {
            diagram = `Diagram unavailable: ${String(error)}. Complete records follow.`;
        }
    }
    const lines = [
        `TOPOLOGY — observer ${topologyJson(graph.observerServiceId)}; entry ${key(graph.entryNodeId)}`,
        "One service's observed graph. Lines are connections, not RPC direction.",
        "Parallel links share a diagram line; LINKS below preserves every endpoint and transport record.",
        "Box labels are abbreviated ASCII-safe hints; NODES preserves complete Unicode labels.",
        "",
        ...diagram.split("\n").map(line => line.trimEnd()),
        "",
        `NODES (${graph.nodes.length}) — complete records, including ports and descriptors`,
        ...graph.nodes.map(node => `${key(node.nodeId)} ${topologyJson(node)}`),
        ...[...identifiers].filter(([, index]) => index >= declared).map(([id]) => `${key(id)} unlisted node ${topologyJson(id)}`),
        "",
        `LINKS (${graph.links.length}) — from/to are transport endpoint roles, not RPC arrows`,
        ...graph.links.map((link, index) => `L${index + 1} ${key(link.from.nodeId)} -- ${key(link.to.nodeId)} ${topologyJson(link)}`),
        "",
        `ROUTES (${graph.routes.length}) — claims from this result only`,
        ...graph.routes.map((route, index) => `R${index + 1} ${key(route.nodeId)} ${topologyJson(route)}`),
        ...warnings.length ? ["", "WARNINGS", ...warnings] : [],
    ].map(safeTerminalText);
    return { lines, mermaid, warnings };
}
