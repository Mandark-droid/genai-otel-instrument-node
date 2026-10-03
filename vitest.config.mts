import { defineConfig } from 'vitest/config';

/**
 * Two projects over one source tree:
 *
 *  - `node`: everything.
 *  - `browser-like`: the runtime-agnostic core's contract tests and the browser
 *    and React Native entries again, in a DOM environment. What it cannot show
 *    - that no Node built-in is imported - `npm run check:bundles` does.
 */
export default defineConfig({
  test: {
    // Builds dist/ once; tests/e2e runs the examples against it.
    globalSetup: ['tests/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.generated.ts', 'src/register.ts', 'src/register.esm.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        'src/config.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/cost/**': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/metrics.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/evaluation/**': { statements: 95, branches: 95, functions: 95, lines: 95 },
      },
    },
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          setupFiles: ['tests/setup.ts'],
          environment: 'node',
          // Generous: a worker's first instrument() imports the client libraries it is
          // given, and a development machine running a VM and a model server is slow.
          testTimeout: 60000,
          // tests/instrumentors/no-leaked-spans.test.ts forces garbage collections.
          execArgv: ['--expose-gc'],
        },
      },
      {
        test: {
          name: 'browser-like',
          include: [
            'tests/contract/config.contract.test.ts',
            'tests/contract/cost.contract.test.ts',
            'tests/contract/semconv.contract.test.ts',
            'tests/contract/metrics.contract.test.ts',
            'tests/web/**/*.test.ts',
          ],
          setupFiles: ['tests/setup.ts'],
          environment: 'happy-dom',
          testTimeout: 20000,
        },
      },
    ],
  },
});
