import { esmUrlPlugin } from '@vscode/rollup-plugin-esm-url';
import type { Plugin } from 'rolldown';
import { defineConfig } from 'tsdown';
import { rawString } from './rawStringPlugin.js';

/**
 * The `@vscode/rollup-plugin-esm-url` plugin emits the guest runtime as its own
 * chunk and replaces `new URL("./guest/guestMain.ts?esm", …)` with an
 * `import.meta.ROLLUP_FILE_URL_<id>` placeholder. Under rollup, the plugin's
 * `resolveFileUrl` hook re-appends the `?esm` query when that placeholder is
 * expanded; under rolldown that hook is not invoked, so the placeholder expands
 * to a bare `new URL("…/…guestMain….js", import.meta.url)` without `?esm`.
 *
 * The `?esm` marker is load-bearing for the downstream VS Code extension build:
 * its esbuild esm-url plugin detects `new URL('…?esm', import.meta.url)` to
 * re-bundle/copy the guest chunk next to `extension.js`. `_loadGuestRuntime`
 * itself is unaffected (it reads via `fileURLToPath`, which drops the query).
 * So we re-add `?esm` to the emitted guest reference to preserve parity with
 * the previous rollup output.
 */
const preserveGuestEsmQuery = (): Plugin => ({
    name: 'preserve-guest-esm-query',
    renderChunk(code) {
        const re = /new URL\((["'])((?:\.\.?\/)*[^"']*guestMain[^"']*\.js)\1/g;
        if (!re.test(code)) return null;
        return {
            code: code.replace(re, (_m, q: string, p: string) => `new URL(${q}${p}?esm${q}`),
            map: null,
        };
    },
});

/**
 * The guest chunk is read as text and evaluated by QuickJS as a classic script.
 * Rolldown emits an empty ESM marker (`export {};`) for this otherwise
 * side-effect-only module, which is invalid in script mode.
 */
const emitGuestAsScript = (): Plugin => ({
    name: 'emit-guest-as-script',
    renderChunk(code, chunk) {
        if (!chunk.name.includes('guestMain') || !chunk.fileName.endsWith('.js')) return null;
        const script = code.replace(/\nexport\s*\{\s*\};?\s*$/, '\n');
        if (script === code) {
            throw new Error(`Expected an empty ESM export in guest chunk ${chunk.fileName}`);
        }
        return { code: script, map: null };
    },
});

// Three entries: the library `index` / `node` surfaces and the `linkrpc-mcp`
// CLI (bin). Runtime `dependencies` (@modelcontextprotocol/sdk, quickjs,
// @hediet/linkrpc*, zod) stay external and resolve from node_modules. The
// source-only `@hediet/linkrpc-client` dev dep is bundled in.
//
// The guest runtime (`src/guest/guestMain.ts`) is referenced via
// `new URL("./guest/guestMain.ts?esm", import.meta.url)` in sandbox.ts; the
// esm-url plugin emits it as its own `?esm` chunk (the `?esm` query is
// re-added by `preserveGuestEsmQuery`) so a downstream bundler can detect and
// re-copy it, while `_loadGuestRuntime` reads it via `fileURLToPath`.
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        node: 'src/node.ts',
        cli: 'src/cli.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    dts: true,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    deps: {
        alwaysBundle: ['@hediet/linkrpc-client'],
    },
    plugins: [rawString(), esmUrlPlugin(), preserveGuestEsmQuery(), emitGuestAsScript()],
    outputOptions: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        // `src/cli.ts` already carries its own shebang, so none is added here.
    },
});
