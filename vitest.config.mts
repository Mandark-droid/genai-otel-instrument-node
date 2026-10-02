import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.generated.ts', 'src/register.ts', 'src/register.esm.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        'src/config.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/cost/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/metrics.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
