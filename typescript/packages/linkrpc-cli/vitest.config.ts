import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { conditions: ["@hediet/source"] },
    ssr: { resolve: { conditions: ["@hediet/source"] } },
    test: {
        server: { deps: { inline: ["@hediet/linkrpc", "@hediet/linkrpc-infra", "@hediet/linkrpc-client"] } },
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
});
