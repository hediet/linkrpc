import { defineConfig } from 'tsdown';

// Two entries: the library index and the `linkrpc` / `hub` CLI (bin).
//
// Runtime `dependencies` (react, ink, commander, zod, `@hediet/linkrpc`,
// `@hediet/linkrpc-hub`) stay external and resolve from node_modules. The
// source-only client helper package below is a dev dependency that exposes its
// TypeScript source directly, so it must be bundled into the output.
export default defineConfig({
    entry: {
        index: 'src/index.ts',
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
        alwaysBundle: [
            '@vscode/observables',
            '@hediet/linkrpc-client',
        ],
    },
    outputOptions: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        // Shebang only on the CLI entry — `src/cli.ts` has no shebang of its
        // own, and a shebang in an imported module is a syntax error.
        banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : ''),
    },
});
