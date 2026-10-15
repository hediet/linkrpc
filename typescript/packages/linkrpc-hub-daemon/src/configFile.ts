import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { daemonConfigJsonSchema, DEFAULT_CONFIG_TEXT, parseDaemonConfigText } from './config';
import type { ConfigDocument } from './managementInterface';

/** Debounce for editors that save via several file operations. */
const WATCH_DEBOUNCE_MS = 150;

export class ConfigConflictError extends Error {
    constructor(file: string) {
        super(`${file} changed since it was read; reload and try again`);
    }
}

/** The daemon config file: revisioned reads, validated atomic writes, and change watching. */
export class ConfigFile {
    constructor(
        public readonly path: string,
        private readonly _schemaPath: string,
    ) { }

    /** Create the config (if missing) and refresh the JSON Schema beside it. */
    public ensureExists(): void {
        fs.mkdirSync(path.dirname(this.path), { recursive: true });
        fs.writeFileSync(this._schemaPath, JSON.stringify(daemonConfigJsonSchema(), null, 2) + '\n');
        try {
            fs.writeFileSync(this.path, DEFAULT_CONFIG_TEXT, { flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    }

    public read(): ConfigDocument {
        let text: string;
        try {
            text = fs.readFileSync(this.path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            text = '';
        }
        return { path: this.path, text, revision: configRevision(text) };
    }

    /**
     * Replace the file if it still has `expectedRevision`. Invalid configs are
     * rejected before anything is written. Returns the new revision.
     */
    public write(text: string, expectedRevision: string): string {
        parseDaemonConfigText(text);
        if (this.read().revision !== expectedRevision) throw new ConfigConflictError(this.path);
        const tmp = `${this.path}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, this.path);
        return configRevision(text);
    }

    /** Invoke `onChange` (debounced) whenever the file may have changed. */
    public watch(onChange: () => void): { dispose(): void; } {
        const name = path.basename(this.path);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watcher = fs.watch(path.dirname(this.path), (_event, filename) => {
            if (filename !== null && filename !== name) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
        });
        watcher.on('error', () => { /* the next explicit reload re-reads the file */ });
        return {
            dispose: () => {
                clearTimeout(timer);
                watcher.close();
            },
        };
    }
}

export function configRevision(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
