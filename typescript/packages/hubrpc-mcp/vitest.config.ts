import { defineConfig } from "vitest/config";
import { esmUrlPlugin } from "@vscode/rollup-plugin-esm-url";

export default defineConfig({
    plugins: [esmUrlPlugin()],
    test: {
        // QuickJS WASM init on the first sandbox test plus a few real-time
        // (small) budgets mean tests need more than the default 5s ceiling.
        testTimeout: 15_000,
        hookTimeout: 15_000,
    },
});
