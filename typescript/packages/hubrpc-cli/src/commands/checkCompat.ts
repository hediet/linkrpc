import { readFileSync } from "node:fs";
import {
    isAssignable,
    type HubRpcInterfaceSchema as SvcInterfaceSchema,
    type HubRpcJsonSchema as SvcJsonSchema,
} from "@vscode/hubrpc";
import { type CliChannel, fetchSchema } from "@vscode/hubrpc-client";

export interface CheckCompatOptions {
    readonly interfaceId: string;
    /** Path to a local SvcInterfaceSchema JSON file. */
    readonly localPath: string;
}

export type CompatVerdict =
    | { kind: "identical"; hash: string }
    | { kind: "compatible-subset"; localHash: string; remoteHash: string; details: string }
    | { kind: "incompatible"; localHash: string; remoteHash: string; details: string };

export async function checkCompatCommand(channel: CliChannel, opts: CheckCompatOptions): Promise<CompatVerdict> {
    const local = JSON.parse(readFileSync(opts.localPath, "utf8")) as SvcInterfaceSchema;
    const remote = await fetchSchema(channel, opts.interfaceId, undefined);
    return diffSchemas(local, remote);
}

export function diffSchemas(
    local: SvcInterfaceSchema,
    remote: SvcInterfaceSchema,
): CompatVerdict {
    if (local.hash === remote.hash) return { kind: "identical", hash: local.hash };

    const localComponents = local.components?.schemas ?? {};
    const remoteComponents = remote.components?.schemas ?? {};
    const issues: string[] = [];

    // Direction: a client speaking `local` calls a server speaking `remote`.
    // For that to work, local params must be assignable to remote params
    // (server accepts what client sends) and remote result must be assignable
    // to local result (client accepts what server returns).
    for (const [name, lm] of Object.entries(local.methods)) {
        const rm = remote.methods[name];
        if (!rm) {
            issues.push(`method "${name}" missing on remote`);
            continue;
        }
        if (!safeAssignable(lm.params, rm.params, mergeComponents(localComponents, remoteComponents))) {
            issues.push(`method "${name}": params not assignable (local → remote)`);
        }
        if (lm.result && rm.result) {
            if (!safeAssignable(rm.result, lm.result, mergeComponents(localComponents, remoteComponents))) {
                issues.push(`method "${name}": result not assignable (remote → local)`);
            }
        } else if (lm.result && !rm.result) {
            issues.push(`method "${name}": local expects a result, remote is notification-only`);
        }
    }

    if (issues.length === 0) {
        return {
            kind: "compatible-subset",
            localHash: local.hash,
            remoteHash: remote.hash,
            details: "all local methods are structurally assignable against remote",
        };
    }
    return {
        kind: "incompatible",
        localHash: local.hash,
        remoteHash: remote.hash,
        details: issues.join("; "),
    };
}

function safeAssignable(
    a: SvcJsonSchema,
    b: SvcJsonSchema,
    components: Record<string, SvcJsonSchema>,
): boolean {
    try { return isAssignable(a, b, components); } catch { return false; }
}

function mergeComponents(
    a: Record<string, SvcJsonSchema>,
    b: Record<string, SvcJsonSchema>,
): Record<string, SvcJsonSchema> {
    return { ...a, ...b };
}

export function formatVerdict(v: CompatVerdict): string {
    switch (v.kind) {
        case "identical":
            return `identical (${v.hash})`;
        case "compatible-subset":
            return `compatible-subset\n  local:  ${v.localHash}\n  remote: ${v.remoteHash}\n  ${v.details}`;
        case "incompatible":
            return `incompatible\n  local:  ${v.localHash}\n  remote: ${v.remoteHash}\n  ${v.details}`;
    }
}
