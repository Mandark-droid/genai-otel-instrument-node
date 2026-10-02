#!/usr/bin/env node
/**
 * Check the BUILT package against several versions of the client libraries.
 *
 * The instrumentors patch the SDKs' resource classes and observe their promise
 * and stream objects, so they depend on SDK internals that are not a public
 * contract. This script installs each listed SDK version into a throwaway
 * directory and runs an application there that never mentions this SDK, started
 * with the zero-code register hook, against a mock provider. It passes when the
 * application gets its answers AND the expected spans arrive at a mock
 * collector, in both module formats.
 *
 *   npm run build && node scripts/sdk-compat.cjs
 *   node scripts/sdk-compat.cjs openai@4.104.0          one target only
 *
 * A version whose own `engines` field excludes the running Node is skipped and
 * reported as skipped, with the reason - not as passed.
 */
const { execSync, spawn } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const dist = join(root, 'dist');

/**
 * The floor of each peer-dependency range in package.json, and the newest of
 * each major since. Keep the first entry of each library equal to that floor:
 * it is what makes the declared range a tested claim.
 */
const TARGETS = [
  'openai@4.0.0',
  'openai@4.104.0',
  'openai@5.23.2',
  'openai@6.49.0',
  'openai@7.27.0',
  '@anthropic-ai/sdk@0.20.0',
  '@anthropic-ai/sdk@0.30.1',
  '@anthropic-ai/sdk@0.60.0',
  '@anthropic-ai/sdk@0.100.1',
  '@anthropic-ai/sdk@0.131.0',
];

const sse = (events) => events.map((event) => `${event}\n\n`).join('');
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', choices: [{ index: 0, delta, finish_reason: finish }] })}`;
const anthropicEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;

const REPLIES = {
  openaiChat: {
    id: 'chatcmpl-compat',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
  },
  openaiStream: sse([
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: 'po' }),
    chunk({ content: 'ng' }),
    chunk({}, 'stop'),
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}`,
    'data: [DONE]',
  ]),
  openaiEmbeddings: {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.5, 0.25, 0.125] }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 3, total_tokens: 3 },
  },
  anthropicMessage: {
    id: 'msg_compat',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 3 },
  },
  anthropicStream: sse([
    anthropicEvent('message_start', {
      message: {
        id: 'msg_compat_s',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    }),
    anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    anthropicEvent('content_block_stop', { index: 0 }),
    anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
    anthropicEvent('message_stop', {}),
  ]),
};

function startServer() {
  const received = { traces: [], metrics: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (part) => chunks.push(part));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const json = (payload) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const stream = (text) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(text);
      };
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        // an OTLP export: not JSON
      }
      if (request.url === '/v1/traces' || request.url === '/v1/metrics') {
        received[request.url === '/v1/traces' ? 'traces' : 'metrics'].push(raw);
        response.writeHead(200, { 'content-type': 'application/x-protobuf' });
        response.end();
      } else if (request.url === '/v1/chat/completions') {
        if (body.stream) stream(REPLIES.openaiStream);
        else json(REPLIES.openaiChat);
      } else if (request.url === '/v1/embeddings') {
        json(REPLIES.openaiEmbeddings);
      } else if (request.url === '/v1/messages') {
        if (body.stream) stream(REPLIES.anthropicStream);
        else json(REPLIES.anthropicMessage);
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

const OPENAI_BODY = `
  const client = new OpenAI({ apiKey: 'sk-compat-not-a-real-key', baseURL: process.env.COMPAT_URL + '/v1', maxRetries: 0 });
  const messages = [{ role: 'user', content: 'ping' }];
  const completion = await client.chat.completions.create({ model: 'gpt-4o-mini', messages });
  const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', messages, stream: true, stream_options: { include_usage: true } });
  let text = '';
  for await (const part of stream) text += (part.choices[0] && part.choices[0].delta && part.choices[0].delta.content) || '';
  const embeddings = await client.embeddings.create({ model: 'text-embedding-3-small', input: 'alpha', encoding_format: 'float' });
  console.log(JSON.stringify({ answer: completion.choices[0].message.content, streamed: text, dimensions: embeddings.data[0].embedding.length }));
`;
const ANTHROPIC_BODY = `
  const client = new Anthropic({ apiKey: 'sk-ant-compat-not-a-real-key', baseURL: process.env.COMPAT_URL, maxRetries: 0 });
  const request = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  const message = await client.messages.create(request);
  const events = await client.messages.create({ ...request, stream: true });
  let count = 0;
  for await (const _event of events) count += 1;
  const final = await client.messages.stream(request).finalMessage();
  console.log(JSON.stringify({ answer: message.content[0].text, events: count, final: final.content[0].text }));
`;

const SPECS = {
  openai: {
    apps: {
      'app.cjs': `const OpenAI = require('openai');\n(async () => {${OPENAI_BODY}})().catch((error) => { console.error(error); process.exit(1); });\n`,
      'app.mjs': `import OpenAI from 'openai';\n${OPENAI_BODY}`,
    },
    stdout: { answer: 'pong', streamed: 'pong', dimensions: 3 },
    // span name -> how many of them the application's calls must produce
    spans: { 'openai.chat.completion': 2, 'openai.embeddings': 1 },
    instrumentor: 'openai',
  },
  '@anthropic-ai/sdk': {
    apps: {
      'app.cjs': `const Anthropic = require('@anthropic-ai/sdk');\n(async () => {${ANTHROPIC_BODY}})().catch((error) => { console.error(error); process.exit(1); });\n`,
      'app.mjs': `import Anthropic from '@anthropic-ai/sdk';\n${ANTHROPIC_BODY}`,
    },
    stdout: { answer: 'pong', events: 6, final: 'pong' },
    spans: { 'anthropic.messages.create': 2, 'anthropic.messages.stream': 1 },
    instrumentor: 'anthropic',
  },
};

function run(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part) => (stdout += part));
    child.stderr.on('data', (part) => (stderr += part));
    const timer = setTimeout(() => child.kill(), 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function count(haystack, needle) {
  let total = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) total += 1;
  return total;
}

/** Does the installed package declare that it supports this Node? */
function engineExcludesThisNode(directory, name) {
  const manifest = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
  const range = manifest.engines && manifest.engines.node;
  const minimum = /^>=\s*(\d+)/.exec(range || '');
  if (minimum && Number(process.versions.node.split('.')[0]) < Number(minimum[1])) return `requires Node ${range}`;
  return undefined;
}

async function check(target) {
  const at = target.lastIndexOf('@');
  const name = target.slice(0, at);
  const spec = SPECS[name];
  if (!spec) return [{ name: target, status: 'FAIL', detail: `no compatibility check is defined for ${name}` }];
  const directory = mkdtempSync(join(tmpdir(), 'sdk-compat-'));
  const results = [];
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'sdk-compat', private: true }));
    // The target goes into a shell command line; accept nothing but name@version.
    if (!/^(@[\w.-]+\/)?[\w.-]+@[\w.-]+$/.test(target)) throw new Error(`not a package@version: ${target}`);
    execSync(`npm install --no-audit --no-fund --silent ${target}`, { cwd: directory, stdio: 'pipe' });
    const excluded = engineExcludesThisNode(directory, name);
    if (excluded) return [{ name: target, status: 'SKIP', detail: `${excluded}; this is Node ${process.versions.node}` }];

    for (const [file, hook] of [
      ['app.cjs', ['--require', join(dist, 'register.js')]],
      ['app.mjs', ['--import', pathToFileURL(join(dist, 'register.mjs')).href]],
    ]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, file), spec.apps[file]);
      const { server, received, url } = await startServer();
      try {
        const env = {};
        for (const [key, value] of Object.entries(process.env)) if (!/^(GENAI_|OTEL_)/i.test(key)) env[key] = value;
        const outcome = await run([...hook, join(directory, file)], directory, {
          ...env,
          COMPAT_URL: url,
          OTEL_EXPORTER_OTLP_ENDPOINT: url,
          OTEL_SERVICE_NAME: 'sdk-compat',
          GENAI_ENABLED_INSTRUMENTORS: spec.instrumentor,
          GENAI_SKIP_COLLECTOR_CHECK: 'true',
        });
        const problems = [];
        if (outcome.code !== 0) problems.push(`exit code ${outcome.code}: ${outcome.stderr.split('\n').slice(0, 3).join(' | ')}`);
        const lastLine = outcome.stdout.split('\n').pop() || '';
        if (lastLine !== JSON.stringify(spec.stdout)) problems.push(`application printed ${lastLine || '(nothing)'}`);
        const traces = Buffer.concat(received.traces).toString('latin1');
        for (const [span, expected] of Object.entries(spec.spans)) {
          // A span name is preceded by its length byte in the protobuf payload; the
          // same text as an attribute VALUE does not occur in a trace export.
          const found = count(traces, span);
          if (found !== expected) problems.push(`${found} "${span}" span(s), expected ${expected}`);
        }
        for (const attribute of ['gen_ai.usage.cost.total', 'gen_ai.usage.input_tokens', 'gen_ai.server.ttft']) {
          if (!traces.includes(attribute)) problems.push(`no span carries ${attribute}`);
        }
        // An error span records an exception event; a cancelled stream is counted as an error metric.
        if (traces.includes('exception.type')) problems.push('a span recorded an exception');
        if (Buffer.concat(received.metrics).toString('latin1').includes('StreamCancelled')) problems.push('a stream was recorded as cancelled');
        results.push({
          name: `${target} ${file === 'app.cjs' ? 'CommonJS (--require)' : 'ES module (--import)'}`,
          status: problems.length === 0 ? 'PASS' : 'FAIL',
          detail: problems.length === 0 ? Object.entries(spec.spans).map(([span, n]) => `${n}x ${span}`).join(', ') : problems.join('; '),
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } catch (error) {
    results.push({ name: target, status: 'FAIL', detail: `could not run: ${error && error.message ? error.message.split('\n')[0] : error}` });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return results;
}

(async () => {
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : TARGETS;
  let failed = false;
  console.log(`Node ${process.versions.node}`);
  for (const target of targets) {
    for (const result of await check(target)) {
      console.log(`${result.status} ${result.name}: ${result.detail}`);
      if (result.status === 'FAIL') failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
})();
