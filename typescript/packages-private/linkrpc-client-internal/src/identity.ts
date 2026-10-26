import * as fs from "node:fs/promises";
import { base64UrlToBytes, principalForPublicKey, type PrincipalId } from "@hediet/linkrpc";
import { identityFilePath } from "@hediet/linkrpc/node";
import { MANAGED_FALLBACK_USER_ID, type PrincipalSpec } from "./principal";

/** The locally stored keypair a {@link PrincipalSpec} signs with. */
export interface CliIdentityTarget {
    /** How the user names it, e.g. `user:hubrpc-cli` or `file:/path/key.json`. */
    readonly label: string;
    readonly file: string;
    readonly capsFile: string;
}

/**
 * The stored keypair `spec` uses, without reading or creating it. `managed`
 * identities are held by the peer, so `managed` names its local fallback slot.
 */
export function cliIdentityTarget(spec: PrincipalSpec): CliIdentityTarget {
    if (spec.kind === "file") {
        return { label: `file:${spec.path}`, file: spec.path, capsFile: _capsFile(spec.path) };
    }
    const id = spec.kind === "user" ? spec.id : MANAGED_FALLBACK_USER_ID;
    const file = identityFilePath({ id });
    return { label: `user:${id}`, file, capsFile: _capsFile(file) };
}

/** The principal stored at `target`, or `undefined` when there is no stored keypair. */
export async function readCliIdentity(target: CliIdentityTarget): Promise<PrincipalId | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(target.file, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
    }
    const { publicKey } = JSON.parse(raw) as { publicKey?: unknown };
    if (typeof publicKey !== "string") throw new Error(`malformed identity file ${target.file}`);
    return principalForPublicKey(base64UrlToBytes(publicKey));
}

/**
 * Delete the keypair and cached capabilities at `target`. The next command
 * signing with it mints a fresh keypair, which hubs that trusted the old key
 * do not accept. Returns the files that were removed.
 */
export async function deleteCliIdentity(target: CliIdentityTarget): Promise<string[]> {
    const removed: string[] = [];
    for (const f of [target.file, target.capsFile]) {
        try {
            await fs.unlink(f);
            removed.push(f);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
    }
    return removed;
}

function _capsFile(identityFile: string): string {
    return identityFile.endsWith(".json") ? identityFile.replace(/\.json$/, ".caps.json") : `${identityFile}.caps.json`;
}
