import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exportStaticHubSchema, type ExportStaticHubSchemaOptions } from '@hediet/linkrpc';
import type { CliChannel } from '@hediet/linkrpc-client';

export async function exportContractCommand(
    channel: CliChannel,
    options: ExportStaticHubSchemaOptions & { output: string },
): Promise<void> {
    const document = await exportStaticHubSchema(channel, options);
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (options.output === '-') {
        process.stdout.write(text);
    } else {
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, text, 'utf8');
    }
}
