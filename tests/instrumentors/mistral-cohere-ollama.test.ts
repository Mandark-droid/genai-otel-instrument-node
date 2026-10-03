/**
 * Mistral (`@mistralai/mistralai`), Cohere (`cohere-ai`) and Ollama (`ollama`):
 * real clients against the mock provider.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { Mistral } from '@mistralai/mistralai';
import { CohereClient, CohereClientV2 } from 'cohere-ai';
import { Ollama } from 'ollama';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { STREAM_CANCELLED } from '../../src/instrumentors/base';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const MESSAGES = [{ role: 'user' as const, content: 'What is the capital of France?' }];
const calculator = getDefaultCostCalculator();

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

describe('Mistral instrumentor', () => {
  const client = (): Mistral => new Mistral({ apiKey: 'mistral-test-not-a-real-key', serverURL: llm.url, retryConfig: { strategy: 'none' } });

  it('chat.complete: the span is named with the model, as in the reference; tokens, cost, response text', async () => {
    harness = await startHarness({ enabledInstrumentors: ['mistralai'], enableContentCapture: true });
    llm.reply({ fixture: 'mistral/chat.completion.json' });
    const response = await client().chat.complete({ model: 'mistral-small-latest', messages: MESSAGES, temperature: 0.2, maxTokens: 64 });
    expect(response.choices[0]?.message?.content).toBe('The capital of France is Paris.');
    const span = harness.span('mistralai.chat.complete mistral-small-latest');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'mistralai',
      'gen_ai.provider.name': 'mistralai',
      'gen_ai.request.model': 'mistral-small-latest',
      'gen_ai.request.type': 'chat',
      'gen_ai.request.temperature': 0.2,
      'gen_ai.request.max_tokens': 64,
      'gen_ai.usage.input_tokens': 14,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.usage.total_tokens': 22,
      'gen_ai.usage.cost.total': calculator.calculateCost('mistral-small-latest', { prompt_tokens: 14, completion_tokens: 8 }, 'chat'),
      'gen_ai.response': 'The capital of France is Paris.',
      'server.address': '127.0.0.1',
    });
  });

  it('chat.stream: time to first token, usage from the stream, closed when read to the end', async () => {
    harness = await startHarness({ enabledInstrumentors: ['mistralai'] });
    llm.reply({ fixture: 'mistral/chat.stream.sse' });
    const stream = await client().chat.stream({ model: 'mistral-small-latest', messages: MESSAGES });
    let text = '';
    for await (const event of stream) text += String(event.data.choices[0]?.delta.content ?? '');
    expect(text).toBe('Paris.');
    const span = harness.span('mistralai.chat.stream mistral-small-latest');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(14);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(3);
    expect(span.attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });

  it('a stream the caller abandons ends with error status and no cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['mistralai'] });
    llm.reply({ fixture: 'mistral/chat.stream.sse', eventDelayMs: 10 });
    const stream = await client().chat.stream({ model: 'mistral-small-latest', messages: MESSAGES });
    for await (const _event of stream) break;
    await eventually(() => expect(harness.spans()).toHaveLength(1));
    const span = harness.span('mistralai.chat.stream mistral-small-latest');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes.error_type).toBe(STREAM_CANCELLED);
  });

  it('embeddings.create', async () => {
    harness = await startHarness({ enabledInstrumentors: ['mistralai'] });
    llm.reply({ fixture: 'mistral/embeddings.json' });
    await client().embeddings.create({ model: 'mistral-embed', inputs: ['alpha', 'beta'] });
    expect(harness.span('mistralai.embeddings.create mistral-embed').attributes).toMatchObject({
      'gen_ai.system': 'mistralai',
      'gen_ai.request.model': 'mistral-embed',
      'gen_ai.request.type': 'embedding',
      'gen_ai.usage.input_tokens': 6,
      'gen_ai.usage.cost.total': calculator.calculateCost('mistral-embed', { prompt_tokens: 6 }, 'embedding'),
    });
  });

  it('a provider error ends the span with ERROR status and no usage', async () => {
    harness = await startHarness({ enabledInstrumentors: ['mistralai'] });
    llm.reply({ fixture: 'mistral/error.401.json', status: 401 });
    await expect(client().chat.complete({ model: 'mistral-small-latest', messages: MESSAGES })).rejects.toThrow();
    const span = harness.span('mistralai.chat.complete mistral-small-latest');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });
});

describe('Cohere instrumentor', () => {
  const v1 = (): CohereClient => new CohereClient({ token: 'cohere-test-not-a-real-key', environment: llm.url });
  const v2 = (): CohereClientV2 => new CohereClientV2({ token: 'cohere-test-not-a-real-key', environment: llm.url });
  const noRetry = { maxRetries: 0 };

  it('generate: the reference span, billed tokens, cost, response text', async () => {
    harness = await startHarness({ enabledInstrumentors: ['cohere'], enableContentCapture: true });
    llm.reply({ fixture: 'cohere/generate.json' });
    await v1().generate({ model: 'command', prompt: 'What is the capital of France?' }, noRetry);
    expect(harness.span('cohere.generate').attributes).toMatchObject({
      'gen_ai.system': 'cohere',
      'gen_ai.request.model': 'command',
      'gen_ai.operation.name': 'generate',
      'gen_ai.request.message_count': 1,
      'gen_ai.usage.input_tokens': 9,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.usage.cost.total': calculator.calculateCost('command', { prompt_tokens: 9, completion_tokens: 8 }, 'chat'),
      'gen_ai.response': ' The capital of France is Paris.',
      'server.address': '127.0.0.1',
    });
  });

  it('embed: input count, vector count and size', async () => {
    harness = await startHarness({ enabledInstrumentors: ['cohere'] });
    llm.reply({ fixture: 'cohere/embed.json' });
    await v1().embed({ model: 'embed-english-v3.0', texts: ['alpha', 'beta'], inputType: 'search_document' }, noRetry);
    expect(harness.span('cohere.embeddings').attributes).toMatchObject({
      'gen_ai.system': 'cohere',
      'gen_ai.request.model': 'embed-english-v3.0',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 2,
      'gen_ai.response.embedding_count': 2,
      'gen_ai.response.vector_size': 3,
    });
  });

  it('chat (v1): token counts from meta.tokens', async () => {
    harness = await startHarness({ enabledInstrumentors: ['cohere'] });
    llm.reply({ fixture: 'cohere/chat.v1.json' });
    await v1().chat({ model: 'command-r', message: 'What is the capital of France?' }, noRetry);
    expect(harness.span('cohere.chat').attributes).toMatchObject({
      'gen_ai.system': 'cohere',
      'gen_ai.request.model': 'command-r',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.message_count': 1,
      'gen_ai.usage.input_tokens': 71,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.response.finish_reasons': ['COMPLETE'],
      'gen_ai.usage.cost.total': calculator.calculateCost('command-r', { prompt_tokens: 71, completion_tokens: 8 }, 'chat'),
    });
  });

  it('chat (v2 client): token counts from usage.tokens', async () => {
    harness = await startHarness({ enabledInstrumentors: ['cohere'] });
    llm.reply({ fixture: 'cohere/chat.v2.json' });
    await v2().chat({ model: 'command-r-plus', messages: MESSAGES }, noRetry);
    expect(harness.span('cohere.chat').attributes).toMatchObject({
      'gen_ai.request.model': 'command-r-plus',
      'gen_ai.request.message_count': 1,
      'gen_ai.usage.input_tokens': 204,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.response.id': 'chat-cohere-fixture-0002',
    });
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['cohere'] });
    llm.reply({ fixture: 'cohere/error.401.json', status: 401 });
    await expect(v1().chat({ model: 'command-r', message: 'hi' }, noRetry)).rejects.toThrow();
    expect(harness.span('cohere.chat').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('Ollama instrumentor', () => {
  const client = (): Ollama => new Ollama({ host: llm.url });

  it('chat: tokens from the eval counts, finish reason, response length, cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    llm.reply({ fixture: 'ollama/chat.json' });
    const response = await client().chat({ model: 'qwen3.5:4b', messages: MESSAGES });
    expect(response.message.content).toBe('The capital of France is Paris.');
    const span = harness.span('ollama.chat');
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'ollama',
      'gen_ai.request.model': 'qwen3.5:4b',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.message_count': 1,
      'gen_ai.response.model': 'qwen3.5:4b',
      'gen_ai.response.finish_reason': 'stop',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.length': 31,
      'gen_ai.usage.input_tokens': 17,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.usage.total_tokens': 25,
      'gen_ai.usage.cost.total': calculator.calculateCost('qwen3.5:4b', { prompt_tokens: 17, completion_tokens: 8 }, 'chat'),
      'server.address': '127.0.0.1',
    });
    expect('gen_ai.usage.token_count_estimated' in span.attributes).toBe(false);
  });

  it('chat, streamed: counts arrive on the last line', async () => {
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    llm.reply({ fixture: 'ollama/chat.stream.ndjson' });
    const stream = await client().chat({ model: 'qwen3.5:4b', messages: MESSAGES, stream: true });
    let text = '';
    for await (const part of stream) text += part.message.content;
    expect(text).toBe('Paris.');
    const span = harness.span('ollama.chat');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(17);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(3);
  });

  it('a server that reports no counts: tokens are estimated, and marked as estimated', async () => {
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    llm.reply({ fixture: 'ollama/chat.no-counts.json' });
    await client().chat({ model: 'qwen3.5:4b', messages: MESSAGES });
    const attributes = harness.span('ollama.chat').attributes;
    // ceil(30 / 4) prompt characters, ceil(31 / 4) response characters.
    expect(attributes['gen_ai.usage.input_tokens']).toBe(8);
    expect(attributes['gen_ai.usage.output_tokens']).toBe(8);
    expect(attributes['gen_ai.usage.token_count_estimated']).toBe(true);
  });

  it('generate', async () => {
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    llm.reply({ fixture: 'ollama/generate.json' });
    await client().generate({ model: 'qwen3.5:4b', prompt: 'Capital of France?' });
    expect(harness.span('ollama.generate').attributes).toMatchObject({
      'gen_ai.system': 'ollama',
      'gen_ai.operation.name': 'generate',
      'gen_ai.response.length': 6,
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 3,
    });
  });

  it('embed: input count, vector count and size', async () => {
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    llm.reply({ fixture: 'ollama/embed.json' });
    await client().embed({ model: 'embeddinggemma:300m', input: ['alpha', 'beta'] });
    expect(harness.span('ollama.embeddings').attributes).toMatchObject({
      'gen_ai.system': 'ollama',
      'gen_ai.request.model': 'embeddinggemma:300m',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 2,
      'gen_ai.response.embedding_count': 2,
      'gen_ai.response.vector_size': 4,
    });
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    llm.reply({ fixture: 'ollama/error.404.json', status: 404 });
    await expect(client().chat({ model: 'no-such-model', messages: MESSAGES })).rejects.toThrow();
    expect(harness.span('ollama.chat').status.code).toBe(SpanStatusCode.ERROR);
  });
});
