/// <reference types="vitest" />

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@tetrabit/scryfall-cache-client': fileURLToPath(new URL('../shared/scryfall-client/index.ts', import.meta.url)),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Live Scryfall coverage has its own opt-in config and must never be
        // selected by the default offline unit-test suite.
        exclude: ['node_modules', 'dist', 'src/utils/scryfallContract.optin.test.ts'],
        testTimeout: 60000,
        retry: 5,
        coverage: {
            reportOnFailure: true,
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['**/*.test.ts'],
            reportsDirectory: './coverage',
            thresholds: {
                lines: 100,
                branches: 100,
                functions: 100,
                statements: 100,
            },
        },
    },
});
