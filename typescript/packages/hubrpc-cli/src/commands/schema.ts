import type { MethodSchema, HubRpcInterfaceSchema as SvcInterfaceSchema } from "@vscode/hubrpc";
import { type CliChannel, fetchSchema, findMethodInSchema } from "@vscode/hubrpc-client";
import { formatJson } from "../output";

export interface SchemaCommandOptions {
    readonly interfaceId: string;
    readonly hash?: string;
    readonly method?: string;
    readonly json?: boolean;
    /**
     * Route the schema request to a specific service (form-3). Needed when
     * the interface lives behind a hub participant — the CLI's default
     * (form-2) target is the hub itself.
     */
    readonly serviceId?: string;
}

export async function schemaCommand(channel: CliChannel, opts: SchemaCommandOptions): Promise<string> {
    const schema = await fetchSchema(channel, opts.interfaceId, opts.hash, opts.serviceId);
    if (opts.method !== undefined) {
        const m = findMethodInSchema(schema, opts.method);
        if (!m) throw new Error(`Method "${opts.method}" not found in ${schema.id}@${schema.hash}`);
        if (opts.json) return formatJson(m);
        return renderMethod(m);
    }
    if (opts.json) return formatJson(schema);
    return renderSchema(schema);
}

function renderSchema(schema: SvcInterfaceSchema): string {
    const lines: string[] = [];
    lines.push(`${schema.id}@${schema.hash}`);
    if (schema.description) lines.push(`  ${schema.description}`);
    lines.push("");
    for (const [name, method] of Object.entries(schema.methods)) {
        lines.push(renderMethod(name, method));
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}

function renderMethod(name: string, m: MethodSchema): string {
    const kind = m.result === undefined ? "notify" : "request";
    const lines: string[] = [];
    lines.push(`  ${kind}  ${name}`);
    if (m.summary) lines.push(`    ${m.summary}`);
    if (m.description) lines.push(`    ${m.description}`);
    lines.push(`    params: ${shortSchema(m.params)}`);
    if (m.result) {
        lines.push(`    result: ${shortSchema(m.result)}`);
    }
    return lines.join("\n");
}

function shortSchema(s: unknown): string {
    const str = JSON.stringify(s);
    if (str.length <= 120) return str;
    return str.slice(0, 117) + "...";
}
