/**
 * The hub engine now lives in `@vscode/hubrpc-hub` (shared by the CLI, the
 * standalone `hubrpc-hub` server, and the VS Code extension). This module
 * re-exports it for the CLI's existing `./engine/runHub` import sites.
 */
import type {
    ListenerInfo,
    RunHubOptions,
    RunningHub,
} from '@vscode/hubrpc-hub/engine/runHub';

export type { ListenerInfo, RunHubOptions, RunningHub };

export async function runHub(options: RunHubOptions): Promise<RunningHub> {
    const engine = await import('@vscode/hubrpc-hub/engine/runHub');
    return engine.runHub(options);
}
