import * as fs from "node:fs/promises";
import { loadOrCreateIdentity } from "@vscode/hubrpc/node";

/**
 * Stable slot id for the on-disk keypair used by the managed-with-fallback
 * default (and `--principal user:hubrpc-cli`). The same slot always loads the
 * same keypair so persistent caps issued by the hub keep working across CLI
 * invocations.
 */
const CLI_IDENTITY_SLOT = "hubrpc-cli";

/**
 * Delete the CLI's persistent identity keypair and its cached caps. The
 * next CLI command will mint a fresh keypair and trigger a new consent
 * modal. Returns the files that were removed (empty when there was no
 * stored state).
 */
export async function logoutCliIdentity(): Promise<string[]> {
    // `loadOrCreateIdentity` is the only API that knows the on-disk
    // path for the slot; calling it here just to discover the path may
    // briefly create a fresh keypair if one didn't exist, which we then
    // delete on the line below. Net effect: end state is empty either
    // way, and the cost is one wasted keygen on the no-op path.
    const identity = await loadOrCreateIdentity({ id: CLI_IDENTITY_SLOT });
    const capsFile = _capsFile(identity.file);
    const removed: string[] = [];
    for (const f of [identity.file, capsFile]) {
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
    return identityFile.replace(/\.json$/, ".caps.json");
}
