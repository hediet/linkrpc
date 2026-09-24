import type { Command } from "commander";
import type { CliChannel } from "@hediet/linkrpc-client";
import { discoverViewTargets, resolveViewSelection } from "../views/discovery";
import { getView, views } from "../views/registry";
import { formatCondition } from "../views/types";

export function viewList(json = false): string {
    const rows = views.map(view => ({
        id: view.id, title: view.title, modes: view.modes,
        conditions: view.conditions.map(formatCondition),
    }));
    return json ? JSON.stringify(rows, null, 2)
        : ["VIEW  MODES  TARGET CONDITIONS", ...rows.map(row => `${row.id}  ${row.modes.join(",")}  ${row.conditions.join(" | ")}`)].join("\n");
}

export function registerViewCommands(
    program: Command,
    withChannel: (action: (channel: CliChannel) => Promise<void>) => Promise<void>,
    emit: (text: string) => void = text => { if (text) process.stdout.write(`${text}\n`); },
): void {
    const command = program.command("view").description("Discover and open compiled-in interface and service views");
    command.command("list").description("List views, modes, and target conditions without connecting")
        .option("--json", "JSON output")
        .action(options => { emit(viewList(options.json)); });
    command.command("targets <view>").description("List matching stable targets (no graph watches or object loads)")
        .option("--json", "JSON output")
        .option("--max-depth <number>", "directory recursion bound", nonNegativeInteger)
        .option("--timeout-ms <number>", "reflection deadline in milliseconds", positiveInteger)
        .action(async (id: string, options) => {
            const view = getView(id);
            await withChannel(async channel => {
                const discovery = await discoverViewTargets(channel, view, options);
                emit(options.json ? JSON.stringify(discovery, null, 2)
                    : ["TARGET  KIND  SERVICE  INTERFACE",
                        ...discovery.targets.map(target => `${target.id}  ${target.kind}  ${target.serviceId || "<root>"}  ${target.interfaceId ?? "*"}`),
                        ...discovery.warnings.map(warning => `warning: ${warning}`)].join("\n"));
            });
        });
    const open = command.command("open").description("Open a view; default is noninteractive, --tui is explicit");
    for (const view of views) {
        const child = open.command(view.id).description(view.title)
            .option("--target <id>", "stable ID from view targets (otherwise resolve exact selectors on this connection)")
            .option("--interface <id>", "exact interface ID; must uniquely resolve without --target")
            .option("--service <id>", "exact service route; narrows --interface or selects a service target")
            .option("--json", "JSON snapshot / JSONL watch output")
            .option("--tui", "interactive terminal renderer")
            .option("--max-depth <number>", "directory recursion bound", nonNegativeInteger)
            .option("--timeout-ms <number>", "reflection and graph call deadline", positiveInteger);
        view.configureCommand(child);
        child.action(async options => {
            if (options.target === undefined && options.interface === undefined && options.service === undefined) {
                throw new Error("Specify --target, or an exact --interface / --service selector");
            }
            await withChannel(async channel => {
                const context = await resolveViewSelection(channel, view, options);
                emit(await view.open(context, options));
            });
        });
    }
}

function nonNegativeInteger(value: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error("Expected a non-negative integer");
    return result;
}
function positiveInteger(value: string): number {
    const result = nonNegativeInteger(value);
    if (result === 0) throw new Error("Expected a positive integer");
    return result;
}
