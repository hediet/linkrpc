import { defineConfig } from 'tsdown';

export default defineConfig([
    {
        entry: { main: 'src/main.ts' },
        outDir: 'dist/main',
        format: 'esm',
        platform: 'node',
        target: 'node22',
        sourcemap: true,
        clean: true,
        outExtensions: () => ({ js: '.js' }),
        deps: { neverBundle: true },
    },
    {
        entry: { preload: 'src/preload.ts' },
        outDir: 'dist/preload',
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        clean: true,
        outExtensions: () => ({ js: '.cjs' }),
        deps: { neverBundle: true },
    },
    {
        entry: { renderer: 'src/renderer/renderer.ts' },
        outDir: 'dist/renderer',
        format: 'iife',
        platform: 'browser',
        target: 'chrome130',
        clean: true,
        outExtensions: () => ({ js: '.js' }),
        outputOptions: { entryFileNames: '[name].js' },
        // The sandboxed window cannot load modules: bundle its only runtime dependency.
        deps: { alwaysBundle: ['@hediet/linkrpc-hub-daemon/call-query'] },
        copy: ['src/renderer/index.html', 'src/renderer/styles.css'],
    },
]);
