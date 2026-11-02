import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Atomically replace `file` with `data`, durably: after a crash or power loss,
 * the file holds either the old or the new content.
 *
 * A rename alone is not enough: file systems journal the rename (metadata)
 * but may not have written the data yet, which leaves a file of the new size
 * filled with zeros. The data is therefore flushed before the rename, and the
 * directory entry after it (POSIX; Windows cannot open directories as files).
 */
export function writeFileDurably(file: string, data: string, options: { mode?: number; } = {}): void {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        const fd = fs.openSync(tmp, 'w', options.mode);
        try {
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
    if (process.platform !== 'win32') _fsyncDirectory(path.dirname(file));
}

function _fsyncDirectory(dir: string): void {
    const fd = fs.openSync(dir, 'r');
    try {
        fs.fsyncSync(fd);
    } catch (error) {
        // Some file systems do not support syncing directories; the data itself is already durable.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally {
        fs.closeSync(fd);
    }
}
