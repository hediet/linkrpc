import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// Library entry and one explicit entry per executable profile.
//
// Runtime dependencies stay external. The daemon and source-only client helpers
// are build dependencies bundled into the CLI package.
export default defineConfig([{
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
    alias: {
        '@hediet/linkrpc-hub-daemon/client': fileURLToPath(new URL('../linkrpc-hub-daemon/src/client.ts', import.meta.url)),
        '@hediet/linkrpc-hub-daemon': fileURLToPath(new URL('../linkrpc-hub-daemon/src/index.ts', import.meta.url)),
        'jsonc-parser': fileURLToPath(new URL('../linkrpc-hub-daemon/node_modules/jsonc-parser/lib/esm/main.js', import.meta.url)),
    },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    deps: {
        alwaysBundle: [
            '@vscode/observables',
            '@hediet/linkrpc-client-internal',
            '@hediet/linkrpc-hub-daemon',
            'cross-spawn',
            'jsonc-parser',
        ],
    },
    outputOptions: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        banner: (chunk) =>
            (['linkrpc', 'rpc', 'hub'].includes(chunk.name) ? '#!/usr/bin/env node' : ''),
    },
}, {
    // Separate compilation keeps daemon CLI side effects out of library chunks.
    entry: { daemon: '../linkrpc-hub-daemon/src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: false,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    alias: {
        'jsonc-parser': fileURLToPath(new URL('../linkrpc-hub-daemon/node_modules/jsonc-parser/lib/esm/main.js', import.meta.url)),
    },
    deps: { alwaysBundle: ['cross-spawn', 'jsonc-parser'] },
    outputOptions: { chunkFileNames: 'chunks/daemon-[name]-[hash].js' },
}]);
