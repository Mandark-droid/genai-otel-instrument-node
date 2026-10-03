import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The core's test setup: a scrubbed environment, no GPU or datastore probing.
    setupFiles: ['../tests/setup.ts'],
    testTimeout: 60000,
  },
});
