#!/usr/bin/env node
/**
 * Load the BUILT package the way a consumer does and exercise it.
 *
 * Runs in CI on the minimum supported Node version, where the test toolchain
 * itself cannot run. Checks:
 *
 *   - both module formats load and instrument();
 *   - the two zero-code register hooks: an application that never mentions this
 *     SDK, started with `--require` / `--import`, makes one OpenAI call against
 *     a mock provider, exits, and its span and metrics arrive at a mock
 *     collector - exported by the flush-on-exit hook.
 */
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const dist = join(root, 'dist');

const COMPLETION = {
  id: 'chatcmpl-smoke',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
};

/** One server playing both the model provider and the OTLP collector. */
function startServer() {
  const received = { traces: [], metrics: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(COMPLETION));
      } else if (request.url === '/v1/traces' || request.url === '/v1/metrics') {
        received[request.url === '/v1/traces' ? 'traces' : 'metrics'].push(body);
        response.writeHead(200, { 'content-type': 'application/x-protobuf' });
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function baseEnv(overrides) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(GENAI_|OTEL_)/i.test(name)) env[name] = value;
  }
  return { ...env, GENAI_SKIP_COLLECTOR_CHECK: 'true', ...overrides };
}

const loadCheck = `
const sdk = require(${JSON.stringify(join(dist, 'index.js'))});
const handle = sdk.instrument({ serviceName: 'dist-smoke' });
if (!handle) throw new Error('instrument() returned nothing');
const attrs = handle.resource.attributes;
if (attrs['telemetry.sdk.language'] !== 'nodejs') throw new Error('telemetry.sdk.language');
if (attrs['telemetry.distro.name'] !== 'genai-otel-instrument-node') throw new Error('telemetry.distro.name');
if (attrs['telemetry.distro.version'] !== sdk.VERSION) throw new Error('telemetry.distro.version');
sdk.uninstrument(0.2).then(() => { console.log('cjs ok ' + sdk.VERSION + ' on ' + process.version); process.exit(0); });
`;
const esmLoadCheck = `
import * as sdk from ${JSON.stringify(pathToFileURL(join(dist, 'index.mjs')).href)};
const handle = sdk.instrument({ serviceName: 'dist-smoke' });
if (!handle) throw new Error('instrument() returned nothing');
await sdk.instrumentorsReady();
await sdk.uninstrument(0.2);
console.log('esm ok ' + sdk.VERSION + ' on ' + process.version);
process.exit(0);
`;

async function zeroCode(name, hookArgs, app) {
  const { server, received, url } = await startServer();
  try {
    const outcome = await run(
      [...hookArgs, join(__dirname, 'smoke-apps', app)],
      baseEnv({
        OTEL_SERVICE_NAME: 'dist-smoke-zero-code',
        OTEL_EXPORTER_OTLP_ENDPOINT: url,
        GENAI_ENABLED_INSTRUMENTORS: 'openai',
        SMOKE_LLM_BASE_URL: `${url}/v1`,
      }),
    );
    const traces = Buffer.concat(received.traces).toString('latin1');
    const metrics = Buffer.concat(received.metrics).toString('latin1');
    const problems = [];
    if (outcome.code !== 0) problems.push(`exit code ${outcome.code}`);
    if (!outcome.stdout.includes('answer: pong')) problems.push('the application did not get its answer');
    // Attribute and span names are plain strings inside the protobuf payload.
    for (const expected of ['openai.chat.completion', 'dist-smoke-zero-code', 'genai-otel-instrument-node', 'gen_ai.usage.cost.total']) {
      if (!traces.includes(expected)) problems.push(`trace export lacks "${expected}"`);
    }
    if (!metrics.includes('gen_ai.client.token.usage')) problems.push('metric export lacks gen_ai.client.token.usage');
    return {
      name,
      ok: problems.length === 0,
      detail: problems.length === 0 ? 'span and metrics exported on exit' : problems.join('; '),
      stderr: outcome.stderr,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * The zero-code checks here use the `openai` version this repository develops
 * against. If that version does not support the running Node, say so rather
 * than fail: `scripts/sdk-compat.cjs` covers the SDK versions that do.
 */
function devSdkUnsupportedHere() {
  const manifest = JSON.parse(readFileSync(join(root, 'node_modules', 'openai', 'package.json'), 'utf8'));
  const range = manifest.engines && manifest.engines.node;
  const minimum = /^>=\s*(\d+)/.exec(range || '');
  if (minimum && Number(process.versions.node.split('.')[0]) < Number(minimum[1])) {
    return `openai ${manifest.version} requires Node ${range}; this is Node ${process.versions.node}`;
  }
  return undefined;
}

/** The A2A / A2UI API in the four built entries: Node (both formats), browser and React Native. */
const A2UI_NAMES = ['recordA2uiReceived', 'recordA2uiSent', 'recordA2uiRendererError', 'instrumentA2aClient', 'instrumentA2uiAgent', 'instrumentA2uiWebCore'];
const a2uiCheck = (load) => `
${load}
for (const name of ${JSON.stringify(A2UI_NAMES)}) if (typeof sdk[name] !== 'function') throw new Error(name + ' is not exported');
sdk.recordA2uiReceived({ version: '1.0', createSurface: { surfaceId: 's', catalogId: 'c' } });
console.log('a2ui api ok');
process.exit(0);
`;

async function loads(name, args) {
  const outcome = await run(args, baseEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', OTEL_LOG_LEVEL: 'none' }));
  return { name, ok: outcome.code === 0, detail: outcome.stdout || `exit code ${outcome.code}`, stderr: outcome.stderr };
}

(async () => {
  const results = [
    await loads('load: commonjs', ['-e', loadCheck]),
    await loads('load: es module', ['--input-type=module', '-e', esmLoadCheck]),
  ];
  results.push(
    await loads('a2ui api: commonjs', ['-e', a2uiCheck(`const sdk = require(${JSON.stringify(join(dist, 'index.js'))});`)]),
    await loads('a2ui api: es module', ['--input-type=module', '-e', a2uiCheck(`import * as sdk from ${JSON.stringify(pathToFileURL(join(dist, 'index.mjs')).href)};`)]),
    await loads('a2ui api: browser bundle', ['--input-type=module', '-e', a2uiCheck(`import * as sdk from ${JSON.stringify(pathToFileURL(join(dist, 'index.browser.mjs')).href)};`)]),
    await loads('a2ui api: react-native bundle', ['-e', a2uiCheck(`const sdk = require(${JSON.stringify(join(dist, 'index.react-native.js'))});`)]),
  );
  const unsupported = devSdkUnsupportedHere();
  if (unsupported) {
    results.push({ name: 'zero-code hooks', ok: true, skipped: true, detail: `not exercised here: ${unsupported}` });
  } else {
    results.push(
      await zeroCode('zero-code: --require, CommonJS app', ['--require', join(dist, 'register.js')], 'zero-code.cjs'),
      await zeroCode('zero-code: --import, ES-module app', ['--import', pathToFileURL(join(dist, 'register.mjs')).href], 'zero-code.mjs'),
    );
  }
  let failed = false;
  for (const result of results) {
    console.log(`${result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
    if (!result.ok) {
      failed = true;
      if (result.stderr) console.error(result.stderr);
    }
  }
  process.exit(failed ? 1 : 0);
})();
