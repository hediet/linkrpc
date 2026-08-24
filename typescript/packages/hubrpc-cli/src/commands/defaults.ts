import { type CliChannel, fetchDefaults } from "@vscode/hubrpc-client";
import { formatJson } from "../output";

export interface DefaultsCommandOptions {
    readonly json?: boolean;
}

export async function defaultsCommand(channel: CliChannel, opts: DefaultsCommandOptions = {}): Promise<string> {
    const d = await fetchDefaults(channel);
    if (opts.json) return formatJson(d);
    if (!d.interfaceId && !d.serviceId) return "(no preset)";
    const lines: string[] = [];
    if (d.serviceId) lines.push(`service:    ${d.serviceId}`);
    lines.push(`interface:  ${d.interfaceId ?? "(none)"}`);
    if (d.hash) lines.push(`hash:       ${d.hash}`);
    return lines.join("\n");
}
