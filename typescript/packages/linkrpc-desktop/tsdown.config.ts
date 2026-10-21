import { defineConfig } from 'tsdown';

export default defineConfig([{
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    dts: true,
    deps: { neverBundle: true },
}, {
    entry: { browser: 'src/browser.ts' },
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    clean: false,
    dts: true,
    deps: { alwaysBundle: [/^@hediet\//, /^zod/] },
}]);
