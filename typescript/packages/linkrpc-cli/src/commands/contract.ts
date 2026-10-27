import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exportStaticHubSchema, type StaticHubSchemaDocument } from '@hediet/linkrpc';
import type { CliChannel } from '@hediet/linkrpc-client-internal';

export interface ExportContractOptions {
    readonly serviceId?: string;
    readonly maxDepth?: number;
}

/** Reflects the endpoint (or one service) into a static contract; shared by `contract export` and `codegen --service`. */
export function exportContract(channel: CliChannel, options: ExportContractOptions): Promise<StaticHubSchemaDocument> {
    return exportStaticHubSchema(channel, { serviceId: options.serviceId, maxDepth: options.maxDepth });
}

export async function exportContractCommand(
    channel: CliChannel,
    options: ExportContractOptions & { output: string },
): Promise<void> {
    const document = await exportContract(channel, options);
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (options.output === '-') {
        process.stdout.write(text);
    } else {
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, text, 'utf8');
    }
}
