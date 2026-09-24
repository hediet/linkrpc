import { interfaceTemplateArgumentsEquivalent } from "@hediet/linkrpc";
import { GRAPH_INTERFACE_TAG } from "@hediet/linkrpc-infra/graph";
import type { ViewContribution, ViewOpenContext } from "../../views/types";
import { graphDescriptorsFromSchema, inspectGraphCommand, type GraphTarget } from "./inspectGraph";
import { GraphSession, runGraphTui } from "./session";

export function resolveGraphRoots(context: ViewOpenContext): GraphTarget[] {
    return context.interfaces.flatMap(listing => {
        const { roots, stores } = graphDescriptorsFromSchema({ ...listing, hash: listing.hash ?? "" }, listing.schema);
        return roots.map(root => {
            const compatible = stores.filter(store => interfaceTemplateArgumentsEquivalent(store.refArgument, root.refArgument));
            if (compatible.length !== 1) throw new Error(`Root "${root.root}" requires exactly one compatible object store`);
            const store = compatible[0]!;
            const route = (method: string) => listing.isDefault ? method.slice(method.lastIndexOf("::") + 2) : method;
            return {
                ...root, graphInterfaceId: store.interfaceId, watchMethod: route(root.watchMethod),
                batchMethod: route(store.batchMethod), valueArgument: store.valueArgument,
            };
        });
    });
}

export const graphView: ViewContribution = {
    id: "graph", title: "Graph", modes: ["cli", "tui"],
    conditions: [
        { kind: "interface", interface: { tag: GRAPH_INTERFACE_TAG } },
        { kind: "service", implements: { tag: GRAPH_INTERFACE_TAG } },
    ],
    configureCommand(command) {
        command
            .option("--mode <mode>", "roots, snapshot, or watch (watch --json emits one snapshot per JSONL line)", "snapshot")
            .option("--root <name>", "root instance name (required if ambiguous)")
            .option("--params <json>", "root parameters as JSON", "{}")
            .option("--depth <number>", "snapshot traversal depth", nonNegativeInteger)
            .option("--path <pointer>", "graph JSON pointer selector")
            .option("--max-objects <number>", "maximum objects per batch", positiveInteger)
            .option("--max-bytes <number>", "maximum bytes per batch", positiveInteger)
            .option("--max-rounds <number>", "maximum batch rounds", positiveInteger)
            .option("--log-timing", "write graph timing diagnostics to stderr");
    },
    async open(context, options) {
        const mode = options.mode ?? "snapshot";
        if (!["roots", "snapshot", "watch"].includes(String(mode))) throw new Error("--mode must be roots, snapshot, or watch");
        const roots = resolveGraphRoots(context);
        if (roots.length === 0) throw new Error("Selected target has no compatible graph roots; advertised tags are not a contract");
        const selected = roots.filter(root => (options.root === undefined || root.root === options.root)
            && (options.interface === undefined || root.interfaceId === options.interface));
        if (options.tui === true) {
            if (options.json === true || mode !== "snapshot") throw new Error("--tui cannot be combined with --json or --mode roots/watch");
            if (options.path !== undefined || options.depth !== undefined) throw new Error("--tui loads on demand; --path and --depth apply to snapshots/watch");
            if (selected.length === 0) throw new Error("No matching graph root. Use --mode roots.");
            if (options.root !== undefined && selected.length > 1) throw new Error("Graph root is ambiguous; specify --interface");
            await runGraphTui(context, selected, options);
            return "";
        }
        if (mode === "roots") {
            const rows = selected.map(root => ({ interfaceId: root.interfaceId, root: root.root, params: root.paramsArgument }));
            return options.json ? JSON.stringify(rows, null, 2) : rows.map(row => `${row.interfaceId}  ${row.root}  ${JSON.stringify(row.params.schema)}`).join("\n");
        }
        if (selected.length !== 1) throw new Error(selected.length === 0
            ? "No matching graph root. Use --mode roots."
            : "Graph root is ambiguous. Use --mode roots, then --root and optionally --interface.");
        let params: unknown;
        try { params = JSON.parse(String(options.params ?? "{}")); }
        catch { throw new Error("--params must be valid JSON"); }
        let stop!: () => void;
        const stopped = options.stop as Promise<void> | undefined ?? new Promise<void>(resolve => { stop = resolve; });
        const onStop = () => stop?.();
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
        try {
            return await inspectGraphCommand(context.channel, {
                targets: selected, root: selected[0]!.root, params,
                depth: options.depth as number | undefined, path: options.path as string | undefined,
                watch: mode === "watch", json: options.json === true, interactive: false, stop: stopped,
                maxObjects: options.maxObjects as number | undefined,
                maxBytes: options.maxBytes as number | undefined,
                maxRounds: options.maxRounds as number | undefined,
                timeoutMs: options.timeoutMs as number | undefined,
                logTiming: options.logTiming === true,
                emit: options.emit as ((text: string) => void) | undefined,
            });
        } finally {
            process.off("SIGINT", onStop);
            process.off("SIGTERM", onStop);
        }
    },
    createSession(context) { return new GraphSession(context, resolveGraphRoots(context)); },
};

function nonNegativeInteger(value: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("Expected a non-negative integer");
    return number;
}
function positiveInteger(value: string): number {
    const number = nonNegativeInteger(value);
    if (number === 0) throw new Error("Expected a positive integer");
    return number;
}
