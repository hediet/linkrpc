import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseStaticHubSchema, type StaticHubSchema } from '@hediet/linkrpc';

export {
    parseStaticHubSchema,
    type StaticHubSchema,
    type StaticHubSchemaDocument,
    type StaticInterfaceReference,
    type StaticService,
} from '@hediet/linkrpc';

export function resolveStaticHubSchemaSource(source: string): string {
    return isHttpUrl(source) ? source : resolve(source);
}

export async function loadStaticHubSchema(source: string): Promise<StaticHubSchema> {
    let raw: unknown;
    try {
        let text: string;
        if (isHttpUrl(source)) {
            const response = await fetch(source);
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trimEnd());
            text = await response.text();
        } else {
            text = await readFile(source, 'utf8');
        }
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`Failed to load hub schema '${source}': ${(error as Error).message}`);
    }
    try {
        return parseStaticHubSchema(raw);
    } catch (error) {
        throw new Error(`Invalid hub schema '${source}': ${(error as Error).message}`);
    }
}

function isHttpUrl(source: string): boolean {
    return /^https?:\/\//i.test(source);
}
