#!/usr/bin/env node
/**
 * `linkrpc-hub` — run a hub from a declarative config file. This is the standalone
 * server face of the shared hub engine; the same {@link HubConfig} format drives
 * the CLI's `serve`/`-c` and the VS Code extension.
 */
import { Command } from 'commander';
import { printHubConfigSchema, serveHub } from './serve';

async function main(argv: readonly string[]): Promise<void> {
    const program = new Command();
    program
        .name('linkrpc-hub')
        .description(
            'Run a linkrpc hub from a declarative config file. The config format is shared with '
            + 'the `hub`/`linkrpc` CLI (`serve`, `-c`) and the VS Code extension.',
        )
        .argument('[config]', 'JSON config file (see --print-schema)')
        .option('--print-schema', 'print the config JSON Schema and exit', false)
        .option('--cmd-interactive', 'forward stdin to the single cmd endpoint (errors if more than one)', false)
        .showHelpAfterError()
        .action(async (config: string | undefined, opts: { printSchema: boolean; cmdInteractive: boolean; }) => {
            if (opts.printSchema) {
                process.stdout.write(printHubConfigSchema() + '\n');
                return;
            }
            if (config === undefined) {
                program.error('a <config> file is required (or pass --print-schema)');
            }
            await serveHub({
                configPath: config!,
                cmdInteractive: opts.cmdInteractive,
                log: (line) => console.log(`[linkrpc-hub] ${line}`),
            });
        });

    await program.parseAsync(['node', 'linkrpc-hub', ...argv]);
}

main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
