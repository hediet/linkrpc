import { runViewTui } from "../../views/runViewTui";
import type { ViewContribution } from "../../views/types";
import { safeTerminalText } from "../../ui/terminalText";
import { LoggingSession } from "./session";
import { logOptions, readLogSnapshot, resolveLoggingTargets, watchLog, type LogFrame } from "./model";

export function formatLogFrame(value: LogFrame, json: boolean): string {
    if (json) return JSON.stringify({
        revision: value.revision, service: value.document.service,
        startedAt: value.document.startedAt, state: value.document.state,
        entries: value.entries, hidden: value.hidden,
    });
    const lines = value.entries.map(entry => {
        const details = entry.attributes ? ` ${JSON.stringify(entry.attributes)}` : "";
        const error = entry.error ? ` ${entry.error.name ?? "Error"}: ${entry.error.message}${entry.error.stack ? ` ${entry.error.stack}` : ""}` : "";
        return safeTerminalText(`${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}${details}${error}`);
    });
    return [`${safeTerminalText(value.document.service)} revision=${value.revision} (${value.hidden} earlier matching entries hidden)`, ...lines].join("\n");
}

export const loggingView: ViewContribution = {
    id: "logging", title: "Logging", modes: ["cli", "tui"],
    conditions: [
        { kind: "interface", interface: { interfaceId: "linkrpc.logging" } },
        { kind: "service", implements: { interfaceId: "linkrpc.logging" } },
        { kind: "interface", interface: { tag: "linkrpc.logging" } },
        { kind: "service", implements: { tag: "linkrpc.logging" } },
    ],
    configureCommand(command) {
        command
            .option("--mode <mode>", "snapshot (read-only) or watch (one frame per revision)", "snapshot")
            .option("--level <level>", "client-side minimum level: trace, debug, info, warn, error, off", "trace")
            .option("--tail <count>", "maximum displayed matching entries", positiveInteger, 200)
            .option("--max-bytes <bytes>", "maximum in-memory log document size", positiveInteger, 2_000_000);
    },
    async open(context, options) {
        const targets = resolveLoggingTargets(context).filter(target =>
            options.interface === undefined || target.interfaceId === options.interface);
        if (targets.length !== 1) throw new Error(targets.length
            ? "Multiple logging interfaces in this service; use --interface or an interface --target"
            : "Selected target has no canonical logging interface");
        const target = targets[0]!;
        const config = logOptions(options);
        const mode = options.mode ?? "snapshot";
        if (mode !== "snapshot" && mode !== "watch") throw new Error("--mode must be snapshot or watch");
        if (options.tui === true) {
            if (options.json === true || mode !== "snapshot") throw new Error("--tui cannot be combined with --json or --mode watch");
            const session = new LoggingSession(context, target, config);
            await runViewTui(session);
            return "";
        }
        if (mode === "snapshot") return formatLogFrame(await readLogSnapshot(context.channel, target, config), options.json === true);
        let release!: () => void;
        const stop = options.stop as Promise<void> | undefined ?? new Promise<void>(resolve => { release = resolve; });
        const onStop = () => release?.();
        const emit = options.emit as ((text: string) => void) | undefined ?? (text => process.stdout.write(`${text}\n`));
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
        try {
            await watchLog(context.channel, target, config, value => emit(formatLogFrame(value, options.json === true)), stop);
            return "";
        } finally {
            process.off("SIGINT", onStop);
            process.off("SIGTERM", onStop);
        }
    },
    createSession(context) {
        const targets = resolveLoggingTargets(context);
        if (targets.length !== 1) throw new Error("Logging service is ambiguous; select an interface target");
        return new LoggingSession(context, targets[0]!, logOptions({}));
    },
};

function positiveInteger(text: string): number {
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive integer");
    return value;
}
