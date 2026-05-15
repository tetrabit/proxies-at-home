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
        exclude: ['node_modules', 'dist'],
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
