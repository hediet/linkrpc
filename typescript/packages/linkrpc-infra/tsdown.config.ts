import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'json-document/index': 'src/json-document/index.ts',
        'json-rpc/index': 'src/json-rpc/index.ts',
        'logging/index': 'src/logging/index.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    dts: true,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    deps: { skipNodeModulesBundle: true },
    exports: {
        devExports: '@hediet/source',
    },
    outputOptions: {
        chunkFileNames: 'chunks/[name]-[hash].js',
    },
});
