/**
 * The hub engine now lives in `@hediet/linkrpc-hub` (shared by the CLI, the
 * standalone `linkrpc-hub` server, and the VS Code extension). This module
 * re-exports it for the CLI's existing `./engine/runHub` import sites.
 */
import type {
    ListenerInfo,
    RunHubOptions,
    RunningHub,
} from '@hediet/linkrpc-hub/engine/runHub';

export type { ListenerInfo, RunHubOptions, RunningHub };

export async function runHub(options: RunHubOptions): Promise<RunningHub> {
    const engine = await import('@hediet/linkrpc-hub/engine/runHub');
    return engine.runHub(options);
}
