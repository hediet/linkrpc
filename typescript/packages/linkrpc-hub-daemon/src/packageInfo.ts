import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@hediet/linkrpc-hub-daemon';
const CLI_PACKAGE_NAME = '@hediet/linkrpc-cli';

/** The root directory of this package (works from `src/` and bundled `dist/`). */
export function packageRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest)) {
            const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
            if (name === PACKAGE_NAME || name === CLI_PACKAGE_NAME) return dir;
        }
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
    const root = packageRoot();
    const { name } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return path.join(root, 'dist', name === CLI_PACKAGE_NAME ? 'daemon.js' : 'cli.js');
}
