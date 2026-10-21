import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: { conditions: ['@hediet/source'] },
    test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 20_000 },
});
