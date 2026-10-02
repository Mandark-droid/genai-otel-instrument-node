import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Builds dist/ once; tests/e2e runs the examples against it.
    globalSetup: ['tests/global-setup.ts'],
    environment: 'node',
    testTimeout: 20000,
    // tests/instrumentors/no-leaked-spans.test.ts forces garbage collections.
    execArgv: ['--expose-gc'],
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
