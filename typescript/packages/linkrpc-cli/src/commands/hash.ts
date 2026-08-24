import { readFileSync } from "node:fs";
import { computeInterfaceHash, type LinkRpcInterfaceSchema as SvcInterfaceSchema } from "@hediet/linkrpc";

export interface HashCommandOptions {
    readonly schemaPath: string;
}

export function hashCommand(opts: HashCommandOptions): string {
    const text = readFileSync(opts.schemaPath, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`${opts.schemaPath}: invalid JSON (${(e as Error).message})`);
    }
    if (!isInterfaceSchema(parsed)) {
        throw new Error(`${opts.schemaPath}: not a SvcInterfaceSchema (missing id / methods)`);
    }
    return computeInterfaceHash(parsed);
}

function isInterfaceSchema(v: unknown): v is SvcInterfaceSchema {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return typeof o.id === "string"
        && typeof o.methods === "object"
        && o.methods !== null
        && !Array.isArray(o.methods);
}
