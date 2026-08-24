/**
 * `watchHubDirectoryTree` — a recursive "the directory tree may have changed"
 * subscription.
 *
 * The hub directory is a **referral graph**: the root
 * (`<rootTarget>::linkrpc.directory`) lists sub-directories, each of which may
 * list more. A single `linkrpc.directory::watch` only reflects *its own* node —
 * the hub's global directory aggregates local, participant-root, and routing
 * invalidations, while every referred directory remains a separate node with
 * its own watch. To react to a manifest appearing *anywhere* in the tree, a
 * consumer must watch **every** node the walk traverses, and re-subscribe as the
 * set of nodes itself changes.
 *
 * This uses {@link HubDirectoryExplorer} to open
 * `linkrpc.directory::watch` on the root and every discovered sub-directory.
 * A tick re-lists only its source and reconciles affected descendant branches;
 * unchanged siblings are not re-listed or re-watched. Nodes that
 * serve the static {@link directoryWatchNever} handler simply never tick — the
 * watch is a harmless no-op there — while live nodes (the routing-backed root,
 * nested sub-hubs) drive discovery. Reads/watches are forwarded (form-3) calls,
 * so `connection` must carry a capability for `*::linkrpc.directory::*` when it is
 * gated.
 *
 * Returns a teardown that cancels every open watch.
 */
import { type LinkRpcConnection } from '@hediet/linkrpc';
import { HubDirectoryExplorer } from '@hediet/linkrpc/hub/common';

export interface WatchHubDirectoryTreeOptions {
    /** Bound the referral recursion (forwarded to {@link walkHubDetailed}). */
    readonly maxDepth?: number;
    /** Human log sink for watch/reconciliation failures. */
    readonly log?: (line: string) => void;
}

export function watchHubDirectoryTree(
    connection: LinkRpcConnection,
    rootTarget: string,
    onChange: () => void,
    options: WatchHubDirectoryTreeOptions = {},
): () => void {
    const explorer = new HubDirectoryExplorer(connection.channel, {
        rootTarget,
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
        ...(options.log !== undefined ? { log: options.log } : {}),
    });
    let disposed = false;
    let stop: (() => void) | undefined;
    void explorer.watch(() => {
        if (!disposed) onChange();
    }).then((teardown) => {
        if (disposed) teardown();
        else stop = teardown;
    }).catch((error) => {
        options.log?.(`watchHubDirectoryTree: start failed: ${(error as Error).message}`);
    });

    return () => {
        disposed = true;
        stop?.();
        explorer.dispose();
    };
}
