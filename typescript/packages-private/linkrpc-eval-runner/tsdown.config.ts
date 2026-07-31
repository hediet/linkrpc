import { defineConfig } from "tsdown";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
    },
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    clean: true,
    dts: true,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    deps: { skipNodeModulesBundle: true },
    outputOptions: {
        chunkFileNames: "chunks/[name]-[hash].js",
    },
});