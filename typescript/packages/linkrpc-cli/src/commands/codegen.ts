import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateTsContract, generateTsInterface, type GenerateContractOptions } from '@hediet/linkrpc';
import { loadStaticHubSchema } from '../staticHubSchema';

export interface CodegenCommandOptions {
    readonly input: string;
    readonly interfaceId?: string;
    readonly name?: string;
    readonly output: string;
    readonly preserveWireSchema?: boolean;
    readonly check?: boolean;
    readonly names?: string;
}

export async function codegenCommand(options: CodegenCommandOptions): Promise<void> {
    if (/^https?:\/\//i.test(options.input)) {
        throw new Error('codegen --input must be a local offline bundle');
    }
    if (options.name !== undefined && !/^[$A-Z_a-z][$\w]*$/.test(options.name)) {
        throw new Error(`codegen --name must be a valid TypeScript identifier, got '${options.name}'`);
    }

    const bundle = await loadStaticHubSchema(options.input);
    let generated: string;
    if (options.interfaceId === undefined) {
        if (options.name !== undefined) throw new Error('codegen --name requires --interface');
        let naming: GenerateContractOptions = {};
        if (options.names !== undefined) {
            const raw = JSON.parse(await readFile(options.names, 'utf8'));
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
                || Object.keys(raw).some((key) => key !== 'interfaceNames' && key !== 'bindingNames')) {
                throw new Error('codegen --names must contain only interfaceNames and bindingNames maps');
            }
            for (const map of Object.values(raw)) {
                if (map === null || typeof map !== 'object' || Array.isArray(map)
                    || Object.values(map).some((name) => typeof name !== 'string')) {
                    throw new Error('codegen --names values must be string maps');
                }
            }
            naming = raw;
        }
        generated = generateTsContract(bundle, naming);
    } else {
        if (options.name === undefined) throw new Error('codegen --interface requires --name');
        if (options.names !== undefined) throw new Error('codegen --names is only supported for whole contracts');
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

        generated = generateTsInterface(matches[0]!, {
            exportName: options.name,
            preserveWireSchema: options.preserveWireSchema === true,
        });
    }
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
