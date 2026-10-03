/**
 * Runs `examples/e2e/full/full.mjs` - the script that is pointed at the
 * platform - as a child process against the BUILT package, a mock model
 * server, a mock Qdrant and a local OTLP receiver, and asserts on what the
 * receiver was sent.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockLlm, type MockLlm, type MockReply } from '../helpers/mock-llm';
import { closedPort, startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';
import type { DecodedSpan } from '../helpers/otlp-decode';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(ROOT, 'examples/e2e/full/full.mjs');

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string>): Promise<Outcome> {
  return new Promise((done) => {
    const scrubbed: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(GENAI_|OTEL_|E2E_|OLLAMA_)/i.test(name)) scrubbed[name] = value;
    }
    // The Ollama poller would look for a server on this machine; not part of this run.
    const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: { ...scrubbed, GENAI_ENABLE_OLLAMA_SERVER_METRICS: 'false', GENAI_ENABLE_GPU_METRICS: 'false', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

const chat = (content: string): MockReply => ({
  json: {
    id: 'chatcmpl-e2e',
    object: 'chat.completion',
    created: 1759400000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  },
});

/** The model replies the script will ask for, in the order it asks. */
const MODEL_REPLIES: MockReply[] = [
  chat('pong'), // chat
  { fixture: 'openai/chat.completion.stream.sse' }, // streaming
  { fixture: 'openai/chat.completion.tool-calls.json' }, // tool call: the model asks for tools
  chat('It is 31°C in Mumbai.'), // tool call: the answer after the tool results; non-ASCII on purpose
  { fixture: 'openai/embeddings.float.json' }, // embeddings
  chat('Paris is the capital of France, a country in Europe.'), // framework: draft
  chat('Paris.'), // framework: shorten
  { json: { models: [{ name: 'gpt-4o-mini' }] } }, // datastore (default: HTTP): GET /api/tags of the model server
  chat('I cannot help with personal data.'), // detector: PII
  chat('I will keep to my instructions.'), // detector: prompt injection
  chat('That is a stereotype.'), // detector: bias
  chat('Please ask a lawyer.'), // detector: restricted topic
  chat('In 2020 the population of France was 67.4 million.'), // detector: hallucination
];

const QDRANT_REPLIES: MockReply[] = [
  { json: { result: { exists: false }, status: 'ok', time: 0 } },
  { json: { result: true, status: 'ok', time: 0 } },
  { json: { result: { operation_id: 1, status: 'completed' }, status: 'ok', time: 0 } },
  { json: { result: { points: [{ id: 1, version: 1, score: 0.99 }] }, status: 'ok', time: 0 } },
];

interface Summary {
  service_name: string;
  session_id: string;
  trace_id: string;
  telemetry_flushed: boolean;
  steps: { name: string; status: 'ok' | 'failed' | 'not_exercised'; reason?: string; detail?: Record<string, unknown> }[];
  totals: { model_calls: number; input_tokens: number; output_tokens: number };
}

describe('examples/e2e/full against mocks', () => {
  let llm: MockLlm;
  let qdrant: MockLlm;
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    llm = await startMockLlm();
    qdrant = await startMockLlm();
    receiver = await startOtlpReceiver();
  });
  afterEach(async () => {
    await llm.close();
    await qdrant.close();
    await receiver.close();
  });

  const named = (name: string): DecodedSpan[] => receiver.spans.filter((span) => span.name === name);
  const stepSpan = (step: string): DecodedSpan => {
    const found = named(`e2e.step.${step}`);
    expect(found, `e2e.step.${step}`).toHaveLength(1);
    return found[0] as DecodedSpan;
  };
  /** The spans made inside a step. */
  const within = (step: string, name: string): DecodedSpan[] => {
    const parent = stepSpan(step);
    const ids = new Set([parent.spanId]);
    // Two levels are enough: a step, a framework span, a model call.
    for (const span of receiver.spans) if (ids.has(span.parentSpanId)) ids.add(span.spanId);
    return receiver.spans.filter((span) => span.name === name && ids.has(span.parentSpanId));
  };

  /** The model replies, without the one the HTTP datastore step consumes. */
  const withoutHttpStep = (): MockReply[] => MODEL_REPLIES.filter((reply) => !(reply.json && 'models' in (reply.json as object)));

  it('default: the datastore step is an HTTP call to the model server, traced by the fetch instrumentor', async () => {
    for (const reply of MODEL_REPLIES) llm.reply(reply);
    const outcome = await run({
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'gpt-4o-mini',
      E2E_EMBEDDING_MODEL: 'text-embedding-3-small',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stderr}\n${outcome.stdout}`).toBe(0);
    const summary = JSON.parse(outcome.stdout) as Summary;
    expect(summary.steps.find((step) => step.name === 'datastore')).toMatchObject({ status: 'ok', detail: { kind: 'http', models: 1 } });
    expect(llm.requests.some((request) => request.path === '/api/tags')).toBe(true);
    const [call] = within('datastore', 'api.call.get.127.0.0.1');
    expect(call?.attributes).toMatchObject({ 'http.method': 'GET', 'net.peer.name': '127.0.0.1' });
    expect(receiver.spans.every((span) => span.attributes['session.id'] === summary.session_id)).toBe(true);
  }, 120_000);

  it('every step runs, under one session and one trace, and each detector fires on its prompt', async () => {
    for (const reply of withoutHttpStep()) llm.reply(reply);
    for (const reply of QDRANT_REPLIES) qdrant.reply(reply);
    const outcome = await run({
      E2E_DATASTORE: 'qdrant',
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'gpt-4o-mini',
      E2E_EMBEDDING_MODEL: 'text-embedding-3-small',
      E2E_QDRANT_URL: qdrant.url,
      E2E_SESSION_ID: 'full-session-under-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stderr}\n${outcome.stdout}`).toBe(0);
    expect(outcome.stderr).toContain('session.id: full-session-under-test');

    const summary = JSON.parse(outcome.stdout) as Summary;
    expect(summary.service_name).toBe('genai-sdk-e2e-node');
    expect(summary.session_id).toBe('full-session-under-test');
    // The model's answer reaches the summary as UTF-8, unchanged: no latin-1 decoding anywhere in the process.
    expect(summary.steps.find((step) => step.name === 'tool_calls')?.detail?.answer).toBe('It is 31°C in Mumbai.');
    expect(summary.telemetry_flushed).toBe(true);
    expect(summary.steps.map((step) => [step.name, step.status])).toEqual([
      ['chat', 'ok'],
      ['streaming', 'ok'],
      ['tool_calls', 'ok'],
      ['embeddings', 'ok'],
      ['framework_langgraph', 'ok'],
      ['datastore', 'ok'],
      ['detector_pii', 'ok'],
      ['detector_prompt_injection', 'ok'],
      ['detector_bias', 'ok'],
      ['detector_restricted_topics', 'ok'],
      ['detector_hallucination', 'ok'],
      ['detector_toxicity', 'not_exercised'],
    ]);
    // Every reply that was queued was asked for.
    expect(llm.requests).toHaveLength(withoutHttpStep().length);
    expect(qdrant.requests).toHaveLength(QDRANT_REPLIES.length);

    // One session, one trace.
    expect(receiver.spans.length).toBeGreaterThan(20);
    for (const span of receiver.spans) expect(span.attributes['session.id'], span.name).toBe('full-session-under-test');
    const [root] = named('e2e.full');
    expect(root?.parentSpanId).toBe('');
    expect(receiver.spans.every((span) => span.resource['service.name'] === 'genai-sdk-e2e-node')).toBe(true);
    expect(receiver.spans[0]?.resource['telemetry.sdk.language']).toBe('nodejs');

    // Chat, streaming, tools, embeddings.
    expect(within('chat', 'openai.chat.completion')[0]?.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 20, 'gen_ai.usage.output_tokens': 10 });
    expect(within('streaming', 'openai.chat.completion')[0]?.attributes['gen_ai.usage.total_tokens']).toBe(22);
    const toolCalls = within('tool_calls', 'openai.chat.completion');
    expect(toolCalls).toHaveLength(2);
    expect(JSON.stringify(toolCalls.map((span) => span.attributes))).toContain('get_weather');
    expect(within('embeddings', 'openai.embeddings')).toHaveLength(1);

    // The framework: a graph span over two model calls, with what the run consumed.
    const [graph] = within('framework_langgraph', 'langgraph.graph.invoke');
    expect(graph?.attributes).toMatchObject({ 'gen_ai.operation.name': 'graph.execution', 'gen_ai.agent.iteration_budget.consumed': 2, 'gen_ai.agent.token_budget.consumed': 60 });
    expect(receiver.spans.filter((span) => span.parentSpanId === graph?.spanId && span.name === 'openai.chat.completion')).toHaveLength(2);

    // The datastore.
    expect(within('datastore', 'qdrant.query_points')[0]?.attributes).toMatchObject({ 'db.system': 'qdrant', 'rag.result.score_max': 0.99 });

    // The detectors, each on the call made for it.
    const evaluated = (step: string): Record<string, unknown> => within(step, 'openai.chat.completion')[0]?.attributes ?? {};
    expect(evaluated('detector_pii')).toMatchObject({ 'evaluation.pii.prompt.detected': true, 'evaluation.pii.prompt.entity_types': ['EMAIL_ADDRESS', 'CREDIT_CARD', 'IN_AADHAAR'] });
    expect(evaluated('detector_prompt_injection')).toMatchObject({ 'evaluation.prompt_injection.detected': true });
    expect(evaluated('detector_bias')).toMatchObject({ 'evaluation.bias.prompt.detected': true });
    expect(evaluated('detector_restricted_topics')).toMatchObject({ 'evaluation.restricted_topics.prompt.detected': true });
    expect(evaluated('detector_hallucination')).toMatchObject({ 'evaluation.hallucination.response.detected': true });
    // The clean chat call is evaluated too, and is clean.
    expect(evaluated('chat')).toMatchObject({ 'evaluation.pii.prompt.detected': false, 'evaluation.prompt_injection.detected': false });
    // Nothing measures toxicity, so nothing is said about it.
    expect(receiver.spans.some((span) => Object.keys(span.attributes).some((key) => key.startsWith('evaluation.toxicity')))).toBe(false);

    // Content capture is off: the prompts that tripped the detectors are not on any span.
    const everything = JSON.stringify(receiver.spans.map((span) => [span.attributes, span.events]));
    expect(everything).not.toContain('4111');
    expect(everything).not.toContain('jane.doe@example.com');

    // The summary agrees with what was exported.
    expect(summary.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(summary.totals.model_calls).toBe(named('openai.chat.completion').length + named('openai.embeddings').length);
    expect(receiver.metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining(['gen_ai.requests', 'gen_ai.client.token.usage', 'genai.evaluation.pii.detections', 'genai.evaluation.prompt_injection.detections', 'mcp.requests']),
    );
  }, 120_000);

  it('E2E_DATASTORE=none: the datastore step is recorded as not exercised, and the run still passes', async () => {
    for (const reply of withoutHttpStep()) llm.reply(reply);
    const outcome = await run({
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'gpt-4o-mini',
      E2E_EMBEDDING_MODEL: 'text-embedding-3-small',
      E2E_DATASTORE: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stderr}\n${outcome.stdout}`).toBe(0);
    const summary = JSON.parse(outcome.stdout) as Summary;
    expect(summary.steps.find((step) => step.name === 'datastore')).toMatchObject({ status: 'not_exercised', reason: 'E2E_DATASTORE=none' });
    // A hex suffix: the platform redacts digit runs shaped like a card number, which an epoch-ms suffix is.
    expect(summary.session_id).toMatch(/^genai-sdk-e2e-node-[0-9a-f]{12}$/);
    expect(named('qdrant.query_points')).toEqual([]);
  }, 120_000);

  it('a datastore that is not there is recorded as not exercised, with the reason', async () => {
    for (const reply of withoutHttpStep()) llm.reply(reply);
    const port = await closedPort();
    const outcome = await run({
      E2E_DATASTORE: 'qdrant',
      E2E_LLM_BASE_URL: `${llm.url}/v1`,
      E2E_LLM_MODEL: 'gpt-4o-mini',
      E2E_EMBEDDING_MODEL: 'text-embedding-3-small',
      E2E_QDRANT_URL: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stderr}\n${outcome.stdout}`).toBe(0);
    const step = (JSON.parse(outcome.stdout) as Summary).steps.find((entry) => entry.name === 'datastore');
    expect(step?.status).toBe('not_exercised');
    expect(step?.reason).toContain(`127.0.0.1:${port}`);
  }, 120_000);

  it('a model server that is not there: every model step fails, the summary says so, exit status 1', async () => {
    const port = await closedPort();
    const outcome = await run({
      E2E_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      E2E_DATASTORE: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code).toBe(1);
    const summary = JSON.parse(outcome.stdout) as Summary;
    expect(summary.steps.find((step) => step.name === 'chat')?.status).toBe('failed');
    expect(summary.steps.filter((step) => step.status === 'ok')).toEqual([]);
    // The failures are telemetry too: the spans are exported, with ERROR status.
    expect(named('openai.chat.completion').every((span) => span.statusCode === 2)).toBe(true);
    expect(named('openai.chat.completion').length).toBeGreaterThan(0);
  }, 120_000);

  it('without a collector endpoint it explains what it needs and exits 64', async () => {
    const outcome = await run({});
    expect(outcome.code).toBe(64);
    expect(outcome.stderr).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});
