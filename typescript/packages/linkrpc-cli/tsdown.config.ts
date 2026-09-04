import { defineConfig } from 'tsdown';

// Library entry and one explicit entry per executable profile.
//
// Runtime `dependencies` (react, ink, commander, zod, `@hediet/linkrpc`,
// `@hediet/linkrpc-hub`) stay external and resolve from node_modules. The
// source-only client helper package below is a dev dependency that exposes its
// TypeScript source directly, so it must be bundled into the output.
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        linkrpc: 'src/linkrpc.ts',
        rpc: 'src/rpc.ts',
        hub: 'src/hub.ts',
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
        banner: (chunk) =>
            (['linkrpc', 'rpc', 'hub'].includes(chunk.name) ? '#!/usr/bin/env node' : ''),
    },
});
