/**
 * `linkrpc serve <config>` — run a hub from a declarative `HubConfig` file and
 * block until interrupted. Thin CLI face over the shared `@hediet/linkrpc-hub`
 * engine, so one config format drives the CLI hub, the server hub, and the
 * VS Code extension.
 */
import { loadHubConfig, printHubConfigSchema } from '@hediet/linkrpc-hub/config-file';

export { loadHubConfig, printHubConfigSchema };

export interface ServeOptions {
    /** Path to the JSON config file. */
    readonly configPath: string;
    /** Forward this process's stdin to the single cmd endpoint, if any. */
    readonly cmdInteractive?: boolean;
    /** Log every JSON-RPC message routed through the hub to stderr. */
    readonly logMessages?: boolean;
}

/** Run a hub from `configPath` and resolve only when interrupted (SIGINT/SIGTERM). */
export async function serveCommand(opts: ServeOptions): Promise<void> {
    const { serveHub } = await import('@hediet/linkrpc-hub/serve');
    await serveHub({
        configPath: opts.configPath,
        cmdInteractive: opts.cmdInteractive,
        logMessages: opts.logMessages,
        log: (line) => process.stderr.write(`linkrpc: ${line}\n`),
    });
}
