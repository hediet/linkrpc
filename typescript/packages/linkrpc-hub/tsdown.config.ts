import { defineConfig } from 'tsdown';

// Library entries (index + hub/server + hub/server/node) plus the
// `linkrpc-hub` CLI (bin). Runtime deps stay external and resolve from
// node_modules — same policy as the previous esbuild build
// (`packages: "external"`). Declarations are bundled by tsdown, replacing
// the separate `tsc --emitDeclarationOnly` pass.
export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'config': 'src/config.ts',
        'configFile': 'src/configFile.ts',
        'spawn': 'src/spawn.ts',
        'serve': 'src/serve.ts',
        'engine/runHub': 'src/engine/runHub.ts',
        'hub/server/index': 'src/hub/server/index.ts',
        'hub/server/client': 'src/hub/server/client.ts',
        'hub/server/transit': 'src/hub/server/transit.ts',
        'hub/server/connectionTokenBinder': 'src/hub/server/connectionTokenBinder.ts',
        'hub/server/node/index': 'src/hub/server/node/index.ts',
        'cli': 'src/cli.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    dts: true,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    deps: { skipNodeModulesBundle: true },
    outputOptions: {
        chunkFileNames: 'chunks/[name]-[hash].js',
    },
});
