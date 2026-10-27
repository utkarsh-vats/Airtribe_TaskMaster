import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // Integration tests share one database, so run files one at a time.
        fileParallelism: false,
        pool: 'forks',
        testTimeout: 15_000,
        hookTimeout: 15_000,
    },
});
