import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      '**/*.d.ts.map',
      '**/*.js',
      '**/*.js.map',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['shared/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/schema.d.ts',
        '**/types.ts',
      ],
      reportsDirectory: './coverage/shared',
      reportOnFailure: true,
    },
  },
});
