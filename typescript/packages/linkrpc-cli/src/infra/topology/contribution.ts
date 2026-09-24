import type { ViewContribution } from "../../views/types";
import { topologyInterface } from "@hediet/linkrpc/inspection";
import { runViewTui } from "../../views/runViewTui";
import { topologyDocument, topologyJson } from "./diagram";
import { readTopology, resolveTopologyTarget, topologyTimeout, watchTopology } from "./model";
import { TopologySession } from "./session";

export const topologyView: ViewContribution = {
    id: "topology", title: "Topology", modes: ["cli", "tui"],
    conditions: [
        { kind: "interface", interface: { interfaceId: topologyInterface.info.id } },
        { kind: "service", implements: { interfaceId: topologyInterface.info.id } },
    ],
    configureCommand(command) {
        command.option("--mode <mode>", "snapshot or watch (watch --json emits complete snapshots as JSONL)", "snapshot");
    },
    async open(context, options) {
        const target = resolveTopologyTarget(context);
        const timeoutMs = topologyTimeout(options);
        const mode = options.mode ?? "snapshot";
        if (mode !== "snapshot" && mode !== "watch") throw new Error("--mode must be snapshot or watch");
        if (options.interface !== undefined && options.interface !== topologyInterface.info.id) throw new Error("Topology requires hubrpc.topology");
        if (options.tui === true) {
            if (options.json === true || mode !== "snapshot") throw new Error("--tui cannot be combined with --json or --mode watch");
            await runViewTui(new TopologySession(context, target, timeoutMs));
            return "";
        }
        if (mode === "snapshot") {
            const graph = await readTopology(context, target, timeoutMs);
            return options.json ? topologyJson(graph, 2) : topologyDocument(graph).lines.join("\n");
        }
        let release!: () => void;
        const stop = options.stop as Promise<void> | undefined ?? new Promise<void>(resolve => { release = resolve; });
        const onStop = () => release?.();
        const emit = options.emit as ((text: string) => void) | undefined ?? (text => process.stdout.write(`${text}\n`));
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
        try {
            await watchTopology(context, target, timeoutMs,
                graph => emit(options.json ? topologyJson(graph) : topologyDocument(graph).lines.join("\n")), stop);
            return "";
        } finally {
            process.off("SIGINT", onStop);
            process.off("SIGTERM", onStop);
        }
    },
    createSession(context) { return new TopologySession(context, resolveTopologyTarget(context), topologyTimeout({})); },
};
