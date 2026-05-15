import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['electron/*.{ts,cts}'],
      exclude: ['electron/*.test.ts'],
      reportsDirectory: './coverage/electron',
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
      reportOnFailure: true,
    },
  },
});
