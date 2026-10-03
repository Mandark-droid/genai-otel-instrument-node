/**
 * Groq (`groq-sdk`) and Together (`together-ai`): real clients against the mock
 * provider. Both speak the Chat Completions wire format.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import Groq from 'groq-sdk';
import Together from 'together-ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { STREAM_CANCELLED } from '../../src/instrumentors/base';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const MESSAGES = [{ role: 'user' as const, content: 'What is the capital of France?' }];
const USAGE = { prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 };

let llm: MockLlm;
let harness: Harness;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
    llm.requests.length = 0;
  }
});

describe('Groq instrumentor', () => {
  const client = (): Groq => new Groq({ apiKey: 'gsk-test-not-a-real-key', baseURL: llm.url, maxRetries: 0 });

  it('chat: the reference span name and attributes, tokens, cost, and the response text', async () => {
    harness = await startHarness({ enabledInstrumentors: ['groq'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const completion = await client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    expect(completion.choices[0]?.message.content).toBe('The capital of France is Paris.');
    const span = harness.span('groq.chat.completions');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'groq',
      'gen_ai.provider.name': 'groq',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.total_tokens': 28,
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', USAGE, 'chat'),
      // Not in the reference's Groq spans; every model call names its operation here.
      'gen_ai.operation.name': 'chat',
    });
    // Neither prompt nor response text without content capture; the reference records
    // the response text on every span (SDK_ADDITIONS.md section 5).
    expect('gen_ai.request.first_message' in span.attributes).toBe(false);
    expect('gen_ai.response' in span.attributes).toBe(false);
    expect((await harness.metric('gen_ai.requests'))?.points.map((point) => point.attributes)).toEqual([{ operation: 'groq.chat.completions' }]);
  });

  it('embeddings: `groq.embeddings` (SDK_ADDITIONS.md section 7; the reference traces none)', async () => {
    harness = await startHarness({ enabledInstrumentors: ['groq'] });
    llm.reply({ fixture: 'openai/embeddings.float.json' });
    await client().embeddings.create({ model: 'nomic-embed-text-v1_5', input: 'hello' });
    expect(harness.span('groq.embeddings').attributes).toMatchObject({ 'gen_ai.system': 'groq', 'gen_ai.operation.name': 'embeddings', 'gen_ai.request.model': 'nomic-embed-text-v1_5' });
  });

  it('with content capture on, the first message and the response text are recorded', async () => {
    harness = await startHarness({ enabledInstrumentors: ['groq'], enableContentCapture: true });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    expect(String(harness.span('groq.chat.completions').attributes['gen_ai.request.first_message'])).toContain('capital of France');
    expect(harness.span('groq.chat.completions').attributes['gen_ai.response']).toBe('The capital of France is Paris.');
  });

  it('streaming: time to first token, tokens from the final chunk', async () => {
    harness = await startHarness({ enabledInstrumentors: ['groq'] });
    llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
    const stream = await client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
    expect(text.length).toBeGreaterThan(0);
    const span = harness.span('groq.chat.completions');
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBeGreaterThan(0);
  });

  it('a stream the caller abandons ends with error status and no cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['groq'] });
    llm.reply({ fixture: 'openai/chat.completion.stream.sse', eventDelayMs: 10 });
    const stream = await client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true });
    for await (const _chunk of stream) break;
    await eventually(() => expect(harness.spans()).toHaveLength(1));
    const span = harness.span('groq.chat.completions');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes.error_type).toBe(STREAM_CANCELLED);
  });

  it('a provider error ends the span with ERROR status and no usage', async () => {
    harness = await startHarness({ enabledInstrumentors: ['groq'] });
    llm.reply({ fixture: 'openai/error.429.json', status: 429 });
    await expect(client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES })).rejects.toThrow();
    const span = harness.span('groq.chat.completions');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });
});

describe('Together instrumentor', () => {
  const client = (): Together => new Together({ apiKey: 'tg-test-not-a-real-key', baseURL: llm.url, maxRetries: 0 });

  it('chat: span, request parameters, tokens and cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['together'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, temperature: 0.3, max_tokens: 40 });
    expect(harness.span('together.chat.completion').attributes).toMatchObject({
      'gen_ai.system': 'together',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.message_count': 1,
      'gen_ai.request.temperature': 0.3,
      'gen_ai.request.max_tokens': 40,
      'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
      'gen_ai.usage.total_tokens': 28,
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', USAGE, 'chat'),
    });
  });

  it('embeddings: count and vector size', async () => {
    harness = await startHarness({ enabledInstrumentors: ['together'] });
    llm.reply({ fixture: 'openai/embeddings.float.json' });
    await client().embeddings.create({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    const attributes = harness.span('together.embeddings').attributes;
    expect(attributes).toMatchObject({
      'gen_ai.system': 'together',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 2,
      'gen_ai.response.embedding_count': 2,
    });
    expect(attributes['gen_ai.response.vector_size']).toBeGreaterThan(0);
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['together'] });
    llm.reply({ fixture: 'openai/error.500.json', status: 500 });
    await expect(client().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES })).rejects.toThrow();
    expect(harness.span('together.chat.completion').status.code).toBe(SpanStatusCode.ERROR);
  });
});
