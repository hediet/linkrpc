import { describe, expect, it } from "vitest";
import { topologyDocument, topologyJson } from "./diagram";
import { sampleTopology } from "./fixtures/sampleGraph";

describe("topology Unicode diagram", () => {
    it("renders boxes and connections without putting remote text into Mermaid syntax", () => {
        const document = topologyDocument(sampleTopology);
        const text = document.lines.join("\n");
        expect(text).toContain("┌");
        expect(text).toContain("─");
        expect(document.mermaid).toContain('n3["N4 - Disconnected endpoint"]');
        expect(document.mermaid).toContain("n0 --- n0"); // Self-links are not dropped.
        expect(document.mermaid).toContain("n1 --- n2"); // Cycle.
        expect(document.mermaid.match(/n0 --- n1/g)).toHaveLength(1);
        expect(document.mermaid).not.toContain("INJECTED");
        expect(document.mermaid).not.toContain("漢字");
        expect(document.mermaid).not.toContain("-->");
        expect(text).toContain("漢字 😀");
        expect(text).toContain('\\"\\nnext');
        expect(text).toContain("Parallel links share a diagram line");
        const links = document.lines.filter(line => /^L\d+ /.test(line));
        expect(links).toHaveLength(sampleTopology.links.length);
        links.forEach((line, index) => expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual(sampleTopology.links[index]));
        const nodes = document.lines.filter(line => /^N\d+ \{/.test(line));
        nodes.forEach((line, index) => expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual(sampleTopology.nodes[index]));
        expect(text).toContain(JSON.stringify(sampleTopology.routes[0]));
    });
    it("makes unlisted endpoints and diagram limits explicit while retaining full records", () => {
        const missing = topologyDocument({ ...sampleTopology, nodes: sampleTopology.nodes.slice(0, 1) });
        expect(missing.warnings).toHaveLength(2);
        expect(missing.lines.join("\n")).toContain("unlisted node");
        expect(missing.lines.filter(line => /^L\d+ /.test(line))).toHaveLength(5);
        const nodes = Array.from({ length: 201 }, (_, index) => ({ nodeId: String(index), ports: [] }));
        const limited = topologyDocument({ observerServiceId: "", entryNodeId: "0", nodes, links: [], routes: [] });
        expect(limited.lines.join("\n")).toContain("Diagram omitted");
        expect(limited.lines.filter(line => /^N\d+ \{/.test(line))).toHaveLength(201);
    });
    it("does not emit terminal controls supplied by the server", () => {
        const graph = { ...sampleTopology, observerServiceId: "\x1b[2J", nodes: [
            { nodeId: "hub", label: "\x1b[31m\nfake title", ports: [] },
        ] };
        const text = topologyDocument(graph).lines.join("\n");
        expect(text).not.toContain("\x1b");
        expect(text).toContain("\\u001b");
        const controls = { label: "\u009b31m\u202eRTL\n漢字😀" };
        expect(topologyJson(controls)).not.toContain("\u009b");
        expect(topologyJson(controls)).not.toContain("\u202e");
        expect(JSON.parse(topologyJson(controls, 2))).toEqual(controls);
    });
});
