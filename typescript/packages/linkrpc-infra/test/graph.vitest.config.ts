import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: { conditions: ['@hediet/source'] },
    test: {
        include: ['src/graph/**/*.test.ts', 'test/graphBoundary.test.ts'],
        server: { deps: { inline: ['@hediet/linkrpc', '@hediet/linkrpc-infra'] } },
    },
});
