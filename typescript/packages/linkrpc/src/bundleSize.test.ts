import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { type Plugin, rollup } from 'rollup';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(srcDir, '..');
// Bundle + breakdown land here (gitignored) so they can be opened and inspected
// to figure out what is worth trimming.
const outDir = join(pkgRoot, '.tmp', 'bundleSizeTest');

/**
 * A minimal, real-world 1:1 linkrpc app: an interface, a server that serves it
 * over stdio (`serveOnStdio`), and a client that spawns + talks to that server
 * over stdio (`connectToCmdStdio`). Bundling *this* is what tells us how much
 * code a tiny stdio integration actually drags in after tree-shaking.
 *
 * Kept as a virtual module (never written into `src/`). Its `./index` / `./node`
 * imports are resolved against `src/` by {@link virtualEntry}.
 */
const ENTRY_SOURCE = `
import { object, string } from 'zod/mini';
import { defineInterface, requestType } from './index';
import { connectToCmdStdio, serveOnStdio } from './node';

const greeter = defineInterface(
    { id: 'demo.greeter' },
    {
        hello: requestType(
            object({ name: string() }),
            object({ greeting: string() }),
        ),
    },
);

// Server side: serve the interface over this process's stdin/stdout.
export async function startServer() {
    const conn = await serveOnStdio();
    conn.register(greeter, {
        hello: async ({ name }) => ({ greeting: \`Hi, \${name}!\` }),
    });
    return conn;
}

// Client side: spawn the server and call it over stdio.
export async function callServer(name) {
    const conn = await connectToCmdStdio('node ./server.js');
    return conn.get(greeter).hello({ name });
}
`;

const ENTRY_ID = '\0bundleSizeEntry.js';

/**
 * Serves {@link ENTRY_SOURCE} as a virtual entry module and resolves its
 * relative (`./index`, `./node`) imports against `src/` so nothing has to be
 * written into the source tree.
 */
function virtualEntry(baseDir: string): Plugin {
    return {
        name: 'virtual-bundle-entry',
        resolveId(source, importer) {
            if (source === ENTRY_ID) return ENTRY_ID;
            if (importer === ENTRY_ID && source.startsWith('.')) {
                const rel = source.replace(/^\.\//, '');
                return join(baseDir, `${rel}.ts`);
            }
            return null;
        },
        load(id) {
            return id === ENTRY_ID ? ENTRY_SOURCE : null;
        },
    };
}

/**
 * `@hpke/common` (reachable via the identity/crypto code) has a Node <= 18
 * fallback that does `await import("crypto")`. That bare `crypto` specifier is
 * dead code on every runtime we target, but it trips bundlers that disallow
 * bare Node-builtin specifiers. Inline it away — same shim the production
 * `rollup.config.js` uses.
 */
function emptyCryptoFallback(): Plugin {
    const VIRTUAL = '\0empty-crypto';
    return {
        name: 'empty-crypto-fallback',
        resolveId(id) {
            return id === 'crypto' ? VIRTUAL : null;
        },
        load(id) {
            return id === VIRTUAL ? 'export const webcrypto = undefined;\nexport default {};\n' : null;
        },
    };
}

/**
 * Externalise Node built-ins only. Every npm dependency (zod, ws, @hpke/*, …)
 * that survives tree-shaking is pulled *into* the bundle so the reported size
 * reflects the real on-disk cost of shipping this app without a node_modules.
 */
function isNodeBuiltin(id: string): boolean {
    return id.startsWith('node:');
}

/**
 * Mirror linkrpc's published `"sideEffects": false` (package.json) onto its own
 * `src/` modules during this source-level bundle.
 *
 * `@rollup/plugin-node-resolve` only honours `sideEffects: false` for resolved
 * `node_modules` packages; here our `.ts` files are resolved by
 * `@rollup/plugin-typescript`, so without this rollup conservatively keeps
 * every module's top-level `const x = defineInterface(...)` — even unused ones
 * reachable through a barrel (e.g. the hub interfaces pulled in via `./node`).
 * That over-reports vs. what a real consumer of `dist/` ships. Marking our
 * modules side-effect-free reproduces the published behaviour so the number
 * reflects reality. Returns `null` for everything else (zod, ws, …) to defer
 * to their own `package.json` `sideEffects` — important so genuine top-level
 * effects like zod's `config(en())` are preserved.
 *
 * Ordered AFTER the typescript plugin so `code` is already transpiled JS; we
 * pass it through untouched and only attach the `moduleSideEffects` flag.
 */
function markSrcSideEffectFree(baseDir: string): Plugin {
    const base = baseDir.replace(/\\/g, '/');
    return {
        name: 'mark-src-side-effect-free',
        transform(code, id) {
            const norm = id.replace(/\\/g, '/');
            if (norm.startsWith(base) && norm.endsWith('.ts')) {
                return { code, map: null, moduleSideEffects: false };
            }
            return null;
        },
    };
}

/** Bucket a module id into a human-friendly group (npm package or "src"). */
function groupOf(id: string): string {
    const m = id.replace(/\\/g, '/');
    if (m.includes('zod/v4/locales/')) return 'zod (locales)';
    if (/zod\/v4\/.*json-schema/.test(m)) return 'zod (json-schema)';
    const nm = m.lastIndexOf('node_modules/');
    if (nm === -1) {
        if (m.includes('/src/')) return 'src (linkrpc)';
        if (m.startsWith('\0')) return '(virtual)';
        return 'other';
    }
    const rest = m.slice(nm + 'node_modules/'.length);
    const parts = rest.split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

interface BundleResult {
    totalBytes: number;
    perModule: { id: string; bytes: number; }[];
}

/**
 * Bundle the stdio app (tree-shaking on, no minify, only `node:` builtins
 * external), write it + a size breakdown to {@link outDir}, and return the
 * per-module sizes.
 */
async function bundleStdioApp(): Promise<BundleResult> {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const bundle = await rollup({
        input: ENTRY_ID,
        external: isNodeBuiltin,
        treeshake: true,
        onwarn() { /* third-party deps emit circular-dep / this-undefined noise */ },
        plugins: [
            virtualEntry(srcDir),
            emptyCryptoFallback(),
            resolve(),
            typescript({
                tsconfig: join(pkgRoot, 'tsconfig.json'),
                noEmit: false,
                declaration: false,
                declarationMap: false,
                sourceMap: false,
                rootDir: srcDir,
                outDir,
                exclude: ['**/*.test.ts', 'scripts/**'],
            }),
            // After typescript so it sees transpiled JS; mirrors the package's
            // published `sideEffects: false` onto our own src modules.
            markSrcSideEffectFree(srcDir),
        ],
    });
    try {
        // No minification — only tree-shaking — per the requirement. The bundle
        // is written to disk so it can be opened and inspected.
        const { output } = await bundle.write({
            dir: outDir,
            format: 'esm',
            entryFileNames: 'bundle.js',
            sourcemap: false,
        });

        const perModule: { id: string; bytes: number; }[] = [];
        let totalBytes = 0;
        for (const chunk of output) {
            if (chunk.type !== 'chunk') continue;
            for (const [id, info] of Object.entries(chunk.modules)) {
                const bytes = info.renderedLength ?? 0;
                if (bytes <= 0) continue;
                perModule.push({ id, bytes });
                totalBytes += bytes;
            }
        }
        writeFileSync(join(outDir, 'breakdown.txt'), renderBreakdown(perModule, totalBytes));
        return { totalBytes, perModule };
    } finally {
        await bundle.close();
    }
}

/** A grouped + per-module size report, written next to the bundle. */
function renderBreakdown(perModule: { id: string; bytes: number; }[], total: number): string {
    const kib = (b: number) => `${(b / 1024).toFixed(1)} KiB`.padStart(11);
    const pct = (b: number) => `${((b / total) * 100).toFixed(1)}%`.padStart(6);

    const byGroup = new Map<string, number>();
    for (const { id, bytes } of perModule) {
        byGroup.set(groupOf(id), (byGroup.get(groupOf(id)) ?? 0) + bytes);
    }

    const lines: string[] = [];
    lines.push(`Bundle total: ${kib(total)}  (tree-shaken, no minify)`);
    lines.push('');
    lines.push('By package:');
    for (const [g, bytes] of [...byGroup].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${kib(bytes)} ${pct(bytes)}  ${g}`);
    }
    lines.push('');
    lines.push('By module (largest first):');
    for (const { id, bytes } of [...perModule].sort((a, b) => b.bytes - a.bytes)) {
        const short = id.replace(/\\/g, '/').replace(/.*node_modules\//, '').replace(/.*\/src\//, 'src/');
        lines.push(`  ${kib(bytes)} ${pct(bytes)}  ${short}`);
    }
    return `${lines.join('\n')}\n`;
}

describe('bundle size', () => {
    it('a 1:1 stdio client+server bundles under the size budget', async () => {
        const { totalBytes } = await bundleStdioApp();
        const kib = totalBytes / 1024;
        const bundledCode = readFileSync(join(outDir, 'bundle.js'), 'utf8');

        // Regression guard: hub-only interface declarations must not leak into
        // the stdio-only scenario.
        expect(bundledCode).not.toContain('hubAccess');
        expect(bundledCode).not.toContain('hubGrantedServiceId');

        // Visible in test output so regressions are easy to eyeball; the full
        // bundle + breakdown.txt live in .tmp/bundleSizeTest/ for inspection.
        // eslint-disable-next-line no-console
        console.log(`stdio client+server bundle (tree-shaken, no minify): ${kib.toFixed(1)} KiB`);
        // eslint-disable-next-line no-console
        console.log(`  written to ${outDir}`);

        // Upper bound (current real size ≈ 182 KiB). The example authors with
        // `zod/mini` and linkrpc's internals do too, so only zod's shared *core*
        // (parsing + json-schema, ~75 KiB) is pulled — the classic schema
        // façade is gone. The bundle honours the package's `sideEffects: false`,
        // so it reflects what a real consumer of dist/ ships, except zod is
        // bundled in here (a consumer already has it installed). The crypto/@hpke
        // stack is lazy and tree-shaken out of the stdio path. This is a
        // regression guard, not a target — bump it deliberately when a
        // dependency genuinely grows, and investigate sudden jumps.
        const BUDGET_KIB = 185;
        expect(kib).toBeLessThanOrEqual(BUDGET_KIB);
    }, 60_000);
});
