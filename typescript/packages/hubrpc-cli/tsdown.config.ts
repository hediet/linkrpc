import { defineConfig } from 'tsdown';

// Two entries: the library index and the `hubrpc` / `hub` CLI (bin).
//
// Runtime `dependencies` (react, ink, commander, zod, `@vscode/hubrpc`,
// `@vscode/hubrpc-hub`) stay external and resolve from node_modules. The three
// source-only workspace packages below are dev dependencies that expose their
// TypeScript source directly — they must NOT be referenced at run time, so we
// bundle them into the output (same policy as the previous rollup build).
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
            '@vscode/hubrpc-node-runner',
            '@vscode/hubrpc-client',
        ],
    },
    outputOptions: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        // Shebang only on the CLI entry — `src/cli.ts` has no shebang of its
        // own, and a shebang in an imported module is a syntax error.
        banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : ''),
    },
});
