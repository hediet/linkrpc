import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { Plugin } from 'rolldown';
import { defineConfig } from 'tsdown';

const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/`;

/**
 * Import `*.css?raw` as the file's text (default-exported string). Used by the
 * standalone adapter to inline the bundled VS Code theme stylesheets.
 */
const rawCss = (): Plugin => {
    const SUFFIX = '?raw';
    return {
        name: 'raw-css',
        resolveId(id, importer) {
            if (!id.endsWith('.css' + SUFFIX)) return null;
            const clean = id.slice(0, -SUFFIX.length);
            const base = importer ? dirname(importer) : process.cwd();
            return resolvePath(base, clean) + SUFFIX;
        },
        load(id) {
            if (!id.endsWith('.css' + SUFFIX)) return null;
            const css = readFileSync(id.slice(0, -SUFFIX.length), 'utf8');
            return `export default ${JSON.stringify(css)};`;
        },
    };
};

/**
 * `@hpke/common` (pulled in transitively via linkrpc) has a Node <= 18 fallback
 * that does `await import("crypto")`. That bare `crypto` specifier is dead code
 * in browsers and Node >= 19 but trips the app-packager capture. Inline it as
 * an empty module so it disappears from dist/.
 */
const emptyCryptoFallback = (): Plugin => {
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
};

const onwarn: NonNullable<import('rolldown').InputOptions['onwarn']> = (warning, warn) => {
    const fromDeps =
        (warning.id ?? '').includes('node_modules') ||
        (warning.ids ?? []).some((id) => id.includes('node_modules')) ||
        (warning.loc?.file ?? '').includes('node_modules') ||
        (warning.message ?? '').includes('node_modules');
    if (
        fromDeps &&
        (warning.code === 'CIRCULAR_DEPENDENCY' ||
            warning.code === 'THIS_IS_UNDEFINED' ||
            warning.code === 'INVALID_ANNOTATION')
    ) {
        return;
    }
    warn(warning);
};

export default defineConfig([
    {
        // Library entry. `@hediet/linkrpc` (already a zero-dep browser bundle)
        // and `zod` are bundled in so the dist output is a single self-contained
        // ES module an app can import by relative path — no bare specifiers
        // survive for the app-packager to reject. Only node builtins and `ws`
        // stay external.
        entry: { index: 'src/index.ts' },
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        sourcemap: true,
        clean: true,
        // The package's `.` export resolves to `src/` (consumers get types from
        // source), and `dist/index.js` is only imported at runtime as a
        // self-contained module by app-packager-built apps — so no `.d.ts` is
        // needed here. Skipping it also avoids bundling zod's declaration files.
        dts: false,
        outExtensions: () => ({ js: '.js' }),
        deps: {
            alwaysBundle: [/^@hediet\/linkrpc/, /^zod/],
            neverBundle: ['ws'],
        },
        plugins: [emptyCryptoFallback()],
        outputOptions: {
            banner,
            chunkFileNames: 'chunks/[name]-[hash].js',
        },
        inputOptions(inputOptions) {
            inputOptions.onwarn = onwarn;
            return inputOptions;
        },
    },
    {
        // Self-contained IIFE loaded directly from a CDN by a from-source
        // `*.vscode-app.html` via:
        //   <script data-vscode-app-unbundled src=".../standalone-app-adapter.js">
        // It must run as a classic script (no module graph, no bare imports), so
        // everything is bundled in and the output is a single file.
        entry: { 'standalone-app-adapter': 'src/standalone/standaloneAppAdapter.ts' },
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        sourcemap: true,
        clean: false,
        dts: false,
        deps: {
            alwaysBundle: [/^@hediet\/linkrpc/, /^zod/],
        },
        plugins: [rawCss(), emptyCryptoFallback()],
        outputOptions: {
            banner,
            // tsdown emits `[name].iife.js` for IIFE by default; the package's
            // `exports` maps `./standalone-app-adapter.js` to `dist/standalone-app-adapter.js`.
            entryFileNames: '[name].js',
        },
        inputOptions(inputOptions) {
            inputOptions.onwarn = onwarn;
            return inputOptions;
        },
    },
]);
