/**
 * `serve` — run a hub from a declarative {@link HubConfig} file and block until
 * interrupted. Shared by the `hubrpc-hub` binary and (re-exported) the CLI.
 */
import { runHub } from './engine/runHub';
import { loadHubConfig } from './configFile';

export { loadHubConfig, printHubConfigSchema } from './configFile';

export interface ServeHubOptions {
    readonly configPath: string;
    readonly cmdInteractive?: boolean;
    readonly log?: (line: string) => void;
    /** Log every JSON-RPC message routed through the hub to {@link log}. */
    readonly logMessages?: boolean;
}

/** Run a hub from `configPath`; resolves only on SIGINT/SIGTERM. */
export async function serveHub(opts: ServeHubOptions): Promise<void> {
    const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
    const config = loadHubConfig(opts.configPath);
    const running = await runHub({
        config,
        log,
        cmdInteractive: opts.cmdInteractive,
        logMessages: opts.logMessages,
    });
    log(`hub running (${running.listeners.length} listener(s)). Ctrl-C to stop.`);

    await new Promise<void>((resolve) => {
        const stop = (): void => {
            running.dispose();
            resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}
