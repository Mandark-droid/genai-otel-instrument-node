#!/usr/bin/env node
/**
 * Load the BUILT package the way a consumer does and exercise it once.
 *
 * Runs on the minimum supported Node version in CI, where the test toolchain
 * itself cannot run. Checks both module formats and both register hooks.
 */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const dist = join(__dirname, '..', 'dist');
const env = {
  ...process.env,
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
  GENAI_SKIP_COLLECTOR_CHECK: 'true',
  GENAI_ENABLED_INSTRUMENTORS: 'openai,anthropic',
  OTEL_LOG_LEVEL: 'none',
};

const cjs = `
const sdk = require(${JSON.stringify(join(dist, 'index.js'))});
const handle = sdk.instrument({ serviceName: 'dist-smoke' });
if (!handle) throw new Error('instrument() returned nothing');
const attrs = handle.resource.attributes;
if (attrs['telemetry.sdk.language'] !== 'nodejs') throw new Error('telemetry.sdk.language');
if (attrs['telemetry.distro.name'] !== 'genai-otel-instrument-node') throw new Error('telemetry.distro.name');
if (attrs['telemetry.distro.version'] !== sdk.VERSION) throw new Error('telemetry.distro.version');
sdk.uninstrument(0.2).then(() => { console.log('cjs ok', sdk.VERSION, process.version); process.exit(0); });
`;
const esm = `
import * as sdk from ${JSON.stringify(pathToFileURL(join(dist, 'index.mjs')).href)};
const handle = sdk.instrument({ serviceName: 'dist-smoke' });
if (!handle) throw new Error('instrument() returned nothing');
await sdk.instrumentorsReady();
await sdk.uninstrument(0.2);
console.log('esm ok', sdk.VERSION, process.version);
process.exit(0);
`;
const hookCheck = (indexPath) => `
const sdk = require(${JSON.stringify(indexPath)});
if (!sdk.isInstrumented()) throw new Error('register hook did not instrument');
sdk.uninstrument(0.2).then(() => { console.log('hook ok'); process.exit(0); });
`;

const runs = [
  ['commonjs', ['-e', cjs]],
  ['esm', ['--input-type=module', '-e', esm]],
  ['--require hook', ['--require', join(dist, 'register.js'), '-e', hookCheck(join(dist, 'index.js'))]],
  [
    '--import hook',
    ['--import', pathToFileURL(join(dist, 'register.mjs')).href, '-e', hookCheck(join(dist, 'index.js'))],
  ],
];

let failed = false;
for (const [name, args] of runs) {
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
  const ok = result.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${(result.stdout || '').trim()}`);
  if (!ok) {
    failed = true;
    console.error(result.stderr);
  }
}
process.exit(failed ? 1 : 0);
