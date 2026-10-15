import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** The daemon's log file (rotated once at startup when large), optionally echoed to stderr. */
export class DaemonLog {
    public static open(file: string, options: { echo: boolean; }): DaemonLog {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        try {
            if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
        } catch { /* no previous log */ }
        return new DaemonLog(fs.createWriteStream(file, { flags: 'a', mode: 0o600 }), options.echo);
    }

    private constructor(
        private readonly _stream: fs.WriteStream,
        private readonly _echo: boolean,
    ) { }

    public line(text: string): void {
        const line = `${new Date().toISOString()} ${text}\n`;
        this._stream.write(line);
        if (this._echo) process.stderr.write(line);
    }

    public close(): Promise<void> {
        return new Promise(resolve => this._stream.end(resolve));
    }
}
