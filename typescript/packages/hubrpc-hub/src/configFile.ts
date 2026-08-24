import * as fs from 'node:fs';
import { type HubConfig, hubConfigJsonSchema, parseHubConfig } from './config';

/** Read and validate a hub config file. */
export function loadHubConfig(configPath: string): HubConfig {
    let text: string;
    try {
        text = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        throw new Error(`cannot read config '${configPath}': ${(error as Error).message}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`invalid JSON in '${configPath}': ${(error as Error).message}`);
    }
    return parseHubConfig(raw);
}

/** The config JSON Schema, pretty-printed. */
export function printHubConfigSchema(): string {
    return JSON.stringify(hubConfigJsonSchema(), null, 2);
}
