import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@hediet/linkrpc-hub-daemon';

/** The root directory of this package (works from `src/` and bundled `dist/`). */
export function packageRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === PACKAGE_NAME) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`cannot locate the ${PACKAGE_NAME} package root`);
        dir = parent;
    }
}

export function packageVersion(): string {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version;
}

/** The daemon CLI script; `node <cliScript> run` runs the daemon. */
export function cliScript(): string {
    return path.join(packageRoot(), 'dist', 'cli.js');
}
