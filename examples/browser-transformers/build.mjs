/**
 * Bundles src/main.js for the browser. The SDK is resolved through its
 * `browser` export condition - the same entry any web bundler picks.
 *
 *   npm install && npm run build      (after `npm run build` in the repository root)
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, '../../dist/index.browser.mjs');
if (!existsSync(sdk)) {
  console.error('Build the SDK first: run `npm run build` in the repository root.');
  process.exit(1);
}

await build({
  entryPoints: [resolve(here, 'src/main.js')],
  outfile: resolve(here, 'dist/main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['browser'],
  mainFields: ['browser', 'module', 'main'],
  sourcemap: true,
  // Inside this repository the SDK is the build two directories up; an
  // application installs the package and needs no alias.
  alias: { '@traceverse/genai-otel-instrument': sdk },
  nodePaths: [resolve(here, '../../node_modules')],
  logLevel: 'info',
});
