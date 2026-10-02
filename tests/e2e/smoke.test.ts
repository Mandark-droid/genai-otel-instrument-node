/**
 * Runs `examples/e2e/smoke/smoke.mjs` - the script that will be pointed at the
 * platform - as a child process against the BUILT package, a mock model server
 * and a local OTLP receiver, and asserts on what the receiver was sent.
 *
 * This is the closest thing to the real end-to-end run that can be done without
 * the platform: real `openai` client, real OTLP http/protobuf exporter, the
 * bytes decoded on the other side of a socket.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { getDefaultCostCalculator } from '../../src/cost';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { closedPort, startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(ROOT, 'examples/e2e/smoke/smoke.mjs');

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSmoke(env: Record<string, string>): Promise<Outcome> {
  // Asynchronous: the mock servers live in this process and must keep answering.
  return new Promise((done) => {
    const scrubbed: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(GENAI_|OTEL_|E2E_)/i.test(name)) scrubbed[name] = value;
    }
    const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: { ...scrubbed, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('examples/e2e/smoke against a mock model server and a local OTLP receiver', () => {
  let llm: MockLlm;
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    llm = await startMockLlm();
    receiver = await startOtlpReceiver();
  });
  afterEach(async () => {
    await llm.close();
    await receiver.close();
  });

  it('exports one chat span with the identity attributes, token counts and cost, and the metrics', async () => {
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const outcome = await runSmoke({
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_API_KEY: 'sk-e2e-not-a-real-key',
      E2E_LLM_MODEL: 'gpt-4o-mini',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, outcome.stderr || outcome.stdout).toBe(0);

    // What the model server was asked.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.path).toBe('/v1/chat/completions');
    expect(llm.requests[0]?.body.model).toBe('gpt-4o-mini');
    expect(llm.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-not-a-real-key');

    // What the SDK says it measured.
    const summary = JSON.parse(outcome.stdout) as {
      service_name: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      sdk_cost_usd: number | null;
      pricing_source: string;
      trace_id: string;
      session_id: string;
      telemetry_flushed: boolean;
      exporter: string;
    };
    const expectedCost = getDefaultCostCalculator().calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat');
    expect(summary.service_name).toBe('genai-sdk-e2e-node');
    expect(summary.exporter).toBe('otlp-http');
    expect(summary.usage).toEqual({ prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 });
    expect(summary.sdk_cost_usd).toBe(expectedCost);
    expect(summary.telemetry_flushed).toBe(true);
    expect(summary.trace_id).toMatch(/^[0-9a-f]{32}$/);
    // Every span of the run carries the session id the summary prints.
    expect(summary.session_id).toMatch(/^genai-sdk-e2e-node-\d+$/);
    expect(receiver.spans.length).toBeGreaterThan(0);
    for (const exported of receiver.spans) expect(exported.attributes['session.id'], exported.name).toBe(summary.session_id);

    // What actually crossed the wire to the collector.
    const span = receiver.spans.find((candidate) => candidate.name === 'openai.chat.completion');
    expect(span, `spans received: ${receiver.spans.map((s) => s.name).join(', ')}`).toBeDefined();
    expect(span?.resource['service.name']).toBe('genai-sdk-e2e-node');
    expect(span?.resource['telemetry.sdk.language']).toBe('nodejs');
    expect(span?.resource['telemetry.distro.name']).toBe('genai-otel-instrument-node');
    expect(span?.resource['telemetry.distro.version']).toBe(pkg.version);
    expect(typeof span?.resource['service.instance.id']).toBe('string');
    expect(span?.statusCode).toBe(1);

    expect(span?.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.provider.name': 'openai',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
      'gen_ai.response.id': 'chatcmpl-fixture-0001',
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.prompt_tokens': 19,
      'gen_ai.usage.completion_tokens': 9,
      'gen_ai.usage.total_tokens': 28,
      'gen_ai.usage.cost.total': expectedCost,
      'gen_ai.usage.cost.pricing_source': 'table',
      'gen_ai.response.finish_reasons': ['stop'],
      'server.address': '127.0.0.1',
      'server.port': llm.port,
    });
    // Integers stay integers on the wire: a backend typing token fields as integer must accept them.
    expect(Number.isInteger(span?.attributes['gen_ai.usage.input_tokens'])).toBe(true);
    expect(summary.sdk_cost_usd).toBe(span?.attributes['gen_ai.usage.cost.total']);

    // The chat span is a child of the script's own root span: one trace.
    expect(receiver.spans.map((candidate) => candidate.name).sort()).toEqual(['e2e.smoke', 'openai.chat.completion']);

    // Metrics, over the same exporter.
    const metric = (name: string) => receiver.metrics.find((candidate) => candidate.name === name);
    expect(metric('gen_ai.requests')?.kind).toBe('sum');
    expect(metric('gen_ai.client.token.usage')?.kind).toBe('sum');
    expect(metric('gen_ai.client.operation.duration')).toMatchObject({ kind: 'histogram', unit: 's' });
    expect(metric('gen_ai.usage.cost')).toMatchObject({ kind: 'sum', unit: 'USD' });
    // Traces once; metrics at the flush and again, cumulatively, at shutdown.
    expect([...new Set(receiver.requests.map((request) => request.path))].sort()).toEqual(['/v1/metrics', '/v1/traces']);
    expect(receiver.requests.filter((request) => request.path === '/v1/traces')).toHaveLength(1);
    expect(new Set(receiver.requests.map((request) => request.contentType))).toEqual(new Set(['application/x-protobuf']));
  }, 60000);

  it('a model with no price: the span has no cost attribute, and the summary says null, not 0', async () => {
    llm.reply({ fixture: 'openai/chat.completion.local.json' });
    const outcome = await runSmoke({
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'acme-internal-llm',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
      OTEL_SERVICE_NAME: 'genai-sdk-e2e-node-custom',
    });
    expect(outcome.code, outcome.stderr || outcome.stdout).toBe(0);
    const summary = JSON.parse(outcome.stdout) as { sdk_cost_usd: number | null; pricing_source: string; service_name: string };
    expect(summary.sdk_cost_usd).toBeNull();
    expect(summary.pricing_source).toBe('unpriced');
    expect(summary.service_name).toBe('genai-sdk-e2e-node-custom');

    const span = receiver.spans.find((candidate) => candidate.name === 'openai.chat.completion');
    expect(span?.resource['service.name']).toBe('genai-sdk-e2e-node-custom');
    expect('gen_ai.usage.cost.total' in (span?.attributes ?? {})).toBe(false);
    expect(span?.attributes['gen_ai.usage.cost.pricing_source']).toBe('unpriced');
    expect(span?.attributes['gen_ai.usage.total_tokens']).toBe(120);
    expect(receiver.metrics.map((metric) => metric.name)).toContain('gen_ai.usage.cost.pricing_missing');
    expect(receiver.metrics.map((metric) => metric.name)).not.toContain('gen_ai.usage.cost');
  }, 60000);

  it('with the collector unreachable the call still succeeds, and the script says the telemetry was not delivered', async () => {
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const outcome = await runSmoke({
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'gpt-4o-mini',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${await closedPort()}`,
      OTEL_LOG_LEVEL: 'none',
    });
    expect(outcome.code, outcome.stderr).toBe(2);
    const summary = JSON.parse(outcome.stdout) as { telemetry_flushed: boolean; answer: string };
    expect(summary.telemetry_flushed).toBe(false);
    expect(summary.answer).toBe('The capital of France is Paris.');
    expect(outcome.stderr).toContain('NOT accepted');
  }, 60000);

  it('a failing model endpoint exits 1 and still exports the error span', async () => {
    llm.reply({ status: 500, fixture: 'openai/error.500.json' });
    const outcome = await runSmoke({
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'gpt-4o-mini',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, outcome.stderr).toBe(1);
    const span = receiver.spans.find((candidate) => candidate.name === 'openai.chat.completion');
    expect(span?.statusCode).toBe(2);
    expect(span?.events.map((event) => event.name)).toEqual(['exception']);
    expect('gen_ai.usage.cost.total' in (span?.attributes ?? {})).toBe(false);
  }, 60000);

  it('refuses to run with a required variable missing', async () => {
    const outcome = await runSmoke({ E2E_LLM_BASE_URL: `${llm.url}/v1`, OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url });
    expect(outcome.code).toBe(64);
    expect(outcome.stderr).toContain('E2E_LLM_MODEL');
    expect(llm.requests).toHaveLength(0);
  }, 60000);

  it('with no base URL given it talks to a local Ollama', async () => {
    // Nothing need be listening there: the summary is printed only on success, so
    // read the endpoint off the error span the receiver gets.
    const outcome = await runSmoke({ E2E_LLM_MODEL: 'gemma3:1b', OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url });
    expect([0, 1]).toContain(outcome.code);
    expect(llm.requests).toHaveLength(0);
    const span = receiver.spans.find((candidate) => candidate.name === 'openai.chat.completion');
    expect(span?.attributes['server.address']).toBe('localhost');
    expect(span?.attributes['server.port']).toBe(11434);
  }, 60000);
});
