import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateTsInterface } from '@hediet/linkrpc';
import { loadStaticHubSchema } from '../staticHubSchema';

export interface CodegenCommandOptions {
    readonly input: string;
    readonly interfaceId: string;
    readonly name: string;
    readonly output: string;
    readonly preserveWireSchema?: boolean;
    readonly check?: boolean;
}

export async function codegenCommand(options: CodegenCommandOptions): Promise<void> {
    if (/^https?:\/\//i.test(options.input)) {
        throw new Error('codegen --input must be a local offline bundle');
    }
    if (!/^[$A-Z_a-z][$\w]*$/.test(options.name)) {
        throw new Error(`codegen --name must be a valid TypeScript identifier, got '${options.name}'`);
    }

    const bundle = await loadStaticHubSchema(options.input);
    const matches = bundle.interfaceSchemas.filter((schema) => schema.id === options.interfaceId);
    if (matches.length === 0) {
        throw new Error(
            `Interface '${options.interfaceId}' was not found in bundle '${options.input}'`,
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `Interface '${options.interfaceId}' is ambiguous in bundle '${options.input}' `
            + `(${matches.length} schema versions)`,
        );
    }

    const generated = generateTsInterface(matches[0]!, {
        exportName: options.name,
        preserveWireSchema: options.preserveWireSchema === true,
    });
    if (options.check === true) {
        let current: string;
        try {
            current = await readFile(options.output, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`Generated output is missing: ${options.output}`);
            }
            throw error;
        }
        if (current !== generated) {
            throw new Error(`Generated output is stale: ${options.output}`);
        }
        return;
    }

    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, generated, 'utf8');
}
