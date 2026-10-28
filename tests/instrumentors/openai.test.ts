/**
 * OpenAI instrumentor, driven through the real `openai` client against a mock
 * provider replaying fixtures. No API key, no network beyond localhost.
 */
import { createRequire } from 'node:module';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { clearBaseUrlClaims, registerBaseUrlClaim, STREAM_CANCELLED } from '../../src/instrumentors/base';
import { OpenAIInstrumentor } from '../../src/instrumentors/openai';
import { withSession } from '../../src/session';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { fixtureJson, startMockLlm, type MockLlm } from '../helpers/mock-llm';

const calculator = getDefaultCostCalculator();
const MESSAGES = [
  { role: 'system' as const, content: 'You are terse.' },
  { role: 'user' as const, content: 'What is the capital of France?' },
];

describe('OpenAI instrumentor', () => {
  let llm: MockLlm;
  let harness: Harness;
  let client: OpenAI;

  beforeAll(async () => {
    llm = await startMockLlm();
  });
  afterAll(async () => {
    await llm.close();
  });

  async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<void> {
    harness = await startHarness({ enabledInstrumentors: ['openai'], ...options });
    client = new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
  }

  afterEach(async () => {
    try {
      // Nothing may be left open, whatever the test did.
      expect(harness.openSpans()).toEqual([]);
    } finally {
      await harness.stop();
      clearBaseUrlClaims();
      llm.requests.length = 0;
    }
  });

  describe('chat completion', () => {
    beforeEach(() => start());

    it('one span with request, response, token and cost attributes', async () => {
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 64,
        seed: 7,
      });
      expect(completion.choices[0]?.message.content).toBe('The capital of France is Paris.');

      const span = harness.span('openai.chat.completion');
      const usage = { prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 };
      const cost = calculator.calculateGranularCost('gpt-4o-mini', usage, 'chat');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toEqual({
        'gen_ai.system': 'openai',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'gpt-4o-mini',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.message_count': 2,
        'gen_ai.request.temperature': 0.2,
        'gen_ai.request.top_p': 0.9,
        'gen_ai.request.max_tokens': 64,
        'gen_ai.request.seed': 7,
        'server.address': '127.0.0.1',
        'server.port': llm.port,
        'gen_ai.response.id': 'chatcmpl-fixture-0001',
        'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.response.finish_reason': 'stop',
        'gen_ai.usage.input_tokens': 19,
        'gen_ai.usage.prompt_tokens': 19,
        'gen_ai.usage.output_tokens': 9,
        'gen_ai.usage.completion_tokens': 9,
        'gen_ai.usage.total_tokens': 28,
        'gen_ai.usage.cost.total': cost?.total,
        'gen_ai.usage.cost.prompt': cost?.prompt,
        'gen_ai.usage.cost.completion': cost?.completion,
        'gen_ai.usage.cost.pricing_source': 'table',
      });
      expect(cost?.total).toBeGreaterThan(0);
      expect(span.events).toEqual([]);
      // Scope and kind as the reference's common wrapper produces them.
      expect(span.instrumentationScope.name).toBe('genai_otel.instrumentors.base');
      expect(span.kind).toBe(SpanKind.INTERNAL);
    });

    it('records request, token, latency and cost metrics', async () => {
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });

      const operation = 'openai.chat.completion';
      expect((await harness.metric('gen_ai.requests'))?.points).toEqual([{ attributes: { operation }, value: 1 }]);
      const tokens = (await harness.metric('gen_ai.client.token.usage'))?.points ?? [];
      expect(tokens.find((point) => point.attributes.token_type === 'prompt')).toMatchObject({ value: 19, attributes: { operation } });
      expect(tokens.find((point) => point.attributes.token_type === 'completion')).toMatchObject({ value: 9 });
      const latency = await harness.metric('gen_ai.client.operation.duration');
      expect(latency?.points[0]?.count).toBe(1);
      expect(latency?.points[0]?.attributes).toEqual({ operation });
      expect((await harness.metric('gen_ai.usage.cost'))?.points[0]).toMatchObject({
        attributes: { model: 'gpt-4o-mini' },
        value: calculator.calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat'),
      });
      // Opt-in instruments stay silent under the standard profile.
      expect(await harness.metric('gen_ai.client.token.usage.prompt')).toBeUndefined();
      expect(await harness.metric('gen_ai.usage.cost.prompt')).toBeUndefined();
      expect(await harness.metric('gen_ai.server.request.finish')).toBeUndefined();
      expect(await harness.metric('gen_ai.client.errors')).toBeUndefined();
    });

    it('does not capture prompt or response content by default', async () => {
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      const span = harness.span('openai.chat.completion');
      expect('gen_ai.request.first_message' in span.attributes).toBe(false);
      expect('gen_ai.response' in span.attributes).toBe(false);
      expect(span.events).toEqual([]);
      expect(JSON.stringify(span.attributes)).not.toContain('France');
    });

    it('tool definitions and tool calls', async () => {
      llm.reply({ fixture: 'openai/chat.completion.tool-calls.json' });
      const tools = [
        {
          type: 'function' as const,
          function: {
            name: 'get_weather',
            description: 'Weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ];
      const completion = await client.chat.completions.create({ model: 'gpt-4o', messages: MESSAGES, tools });
      expect(completion.choices[0]?.message.tool_calls).toHaveLength(2);

      const attributes = harness.span('openai.chat.completion').attributes;
      // json.dumps form: ", " and ": " separators.
      expect(attributes['llm.tools']).toBe(
        '[{"type": "function", "function": {"name": "get_weather", "description": "Weather for a city", ' +
          '"parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]',
      );
      expect(attributes['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
      expect(attributes['llm.output_messages.0.message.tool_calls.0.tool_call.id']).toBe('call_fixture_abc');
      expect(attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name']).toBe('get_weather');
      expect(attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments']).toBe('{"city":"Mumbai"}');
      expect(attributes['llm.output_messages.0.message.tool_calls.1.tool_call.id']).toBe('call_fixture_def');
      expect(attributes['llm.output_messages.0.message.tool_calls.1.tool_call.function.name']).toBe('get_time');
      // Prompt-cache reads reported by the provider.
      expect(attributes['gen_ai.usage.cache_read.input_tokens']).toBe(64);
      expect(attributes['gen_ai.usage.input_tokens']).toBe(82);
    });

    it('reasoning tokens', async () => {
      llm.reply({ fixture: 'openai/chat.completion.reasoning.json' });
      await client.chat.completions.create({ model: 'o1', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['gen_ai.usage.reasoning.output_tokens']).toBe(192);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(210);
    });

    it('the caller gets the SDK promise back: withResponse() and asResponse() still work', async () => {
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const { data, response, request_id } = await client.chat.completions
        .create({ model: 'gpt-4o-mini', messages: MESSAGES })
        .withResponse();
      expect(data.id).toBe('chatcmpl-fixture-0001');
      expect(response.status).toBe(200);
      expect(request_id).toBe('req_fixture');
      expect(harness.span('openai.chat.completion').attributes['gen_ai.usage.total_tokens']).toBe(28);

      harness.reset();
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const raw = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES }).asResponse();
      expect(((await raw.json()) as { id: string }).id).toBe('chatcmpl-fixture-0001');
      // The body was the caller's to read, so usage was not observable - but the span ended.
      await eventually(() => expect(harness.spans()).toHaveLength(1));
      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect('gen_ai.usage.total_tokens' in span.attributes).toBe(false);
      expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    });

    it('a provider error ends the span with ERROR status and no cost, and the caller sees the SDK error', async () => {
      llm.reply({ status: 429, fixture: 'openai/error.429.json' });
      const failure = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OpenAI.RateLimitError);

      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toContain('Rate limit reached');
      expect(span.events.map((event) => event.name)).toEqual(['exception']);
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
      expect(span.attributes['gen_ai.request.model']).toBe('gpt-4o-mini');

      expect((await harness.metric('gen_ai.client.errors'))?.points).toEqual([
        { attributes: { operation: 'openai.chat.completion', error_type: 'RateLimitError' }, value: 1 },
      ]);
      expect(await harness.metric('gen_ai.usage.cost')).toBeUndefined();
      expect(await harness.metric('gen_ai.requests')).toBeUndefined();
    });

    it('an unreachable provider ends the span with ERROR status', async () => {
      const dead = new OpenAI({ apiKey: 'sk-test', baseURL: 'http://127.0.0.1:9/v1', maxRetries: 0 });
      await expect(dead.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES })).rejects.toBeInstanceOf(
        OpenAI.APIConnectionError,
      );
      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['server.port']).toBe(9);
    });
  });

  describe('content capture', () => {
    it('when enabled: first message, prompt and completion events, response text', async () => {
      await start({ enableContentCapture: true });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });

      const span = harness.span('openai.chat.completion');
      expect(span.attributes['gen_ai.request.first_message']).toBe('{"role": "system", "content": "You are terse."}');
      expect(span.attributes['gen_ai.response']).toBe('The capital of France is Paris.');
      expect(span.events.map((event) => [event.name, event.attributes])).toEqual([
        ['gen_ai.prompt.0', { 'gen_ai.prompt.role': 'system', 'gen_ai.prompt.content': 'You are terse.' }],
        ['gen_ai.prompt.1', { 'gen_ai.prompt.role': 'user', 'gen_ai.prompt.content': 'What is the capital of France?' }],
        ['gen_ai.completion.0', { 'gen_ai.completion.role': 'assistant', 'gen_ai.completion.content': 'The capital of France is Paris.' }],
      ]);
    });

    it('is truncated to GENAI_CONTENT_MAX_LENGTH', async () => {
      await start({ enableContentCapture: true, contentMaxLength: 10 });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      const span = harness.span('openai.chat.completion');
      expect(span.attributes['gen_ai.request.first_message']).toBe('{"role": "system", "content": "You are te"}');
      expect(span.attributes['gen_ai.response']).toBe('The capita');
      expect(span.events[1]?.attributes?.['gen_ai.prompt.content']).toBe('What is th');
    });
  });

  describe('streaming', () => {
    beforeEach(() => start());

    it('passes every chunk through, and closes the span when the stream ends with tokens, cost and latency', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
      const stream = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
      });
      // The span covers the generation, not the handshake.
      expect(harness.spans()).toHaveLength(0);
      expect(harness.openSpans()).toEqual(['openai.chat.completion']);

      let text = '';
      let chunks = 0;
      for await (const chunk of stream) {
        chunks += 1;
        text += chunk.choices[0]?.delta?.content ?? '';
      }
      expect(text).toBe('Paris.');
      expect(chunks).toBe(6);

      const span = harness.span('openai.chat.completion');
      const attributes = span.attributes;
      const usage = { prompt_tokens: 19, completion_tokens: 3, total_tokens: 22 };
      const cost = calculator.calculateGranularCost('gpt-4o-mini', usage, 'chat');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(attributes['gen_ai.request.stream']).toBe(true);
      expect(attributes['gen_ai.streaming.token_count']).toBe(6);
      expect(attributes['gen_ai.usage.input_tokens']).toBe(19);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(3);
      expect(attributes['gen_ai.usage.prompt_tokens']).toBe(19);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(22);
      expect(attributes['gen_ai.usage.cost.total']).toBe(cost?.total);
      expect(attributes['gen_ai.usage.cost.pricing_source']).toBe('table');

      const ttft = attributes['gen_ai.server.time_to_first_token'] as number;
      expect(ttft).toBeGreaterThan(0);
      expect(attributes['gen_ai.server.ttft']).toBe(ttft);
      expect(attributes['gen_ai.server.time_per_output_token']).toBeGreaterThanOrEqual(0);
      expect('gen_ai.streaming.tpot_unavailable_reason' in attributes).toBe(false);

      const labels = { model: 'gpt-4o-mini', operation: 'openai.chat.completion' };
      expect((await harness.metric('gen_ai.server.ttft'))?.points[0]).toMatchObject({ count: 1, attributes: labels });
      expect((await harness.metric('gen_ai.server.time_to_first_token'))?.points[0]?.count).toBe(1);
      expect((await harness.metric('gen_ai.server.tbt'))?.points[0]?.count).toBe(5);
      expect((await harness.metric('gen_ai.server.time_per_output_token'))?.points[0]?.count).toBe(1);
      expect((await harness.metric('gen_ai.requests'))?.points[0]?.value).toBe(1);
      expect((await harness.metric('gen_ai.client.operation.duration'))?.points[0]?.count).toBe(1);
      // The streaming path records the token histograms unconditionally, as the reference does.
      expect((await harness.metric('gen_ai.client.token.usage.prompt'))?.points[0]).toMatchObject({ count: 1, value: 19 });
    });

    it('without usage in the stream: no tokens, no cost, and TPOT is marked unavailable rather than guessed', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.no-usage.sse' });
      const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true });
      for await (const _chunk of stream) {
        // drain
      }
      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes['gen_ai.streaming.token_count']).toBe(5);
      expect(span.attributes['gen_ai.streaming.tpot_unavailable_reason']).toBe('output_token_count_unavailable');
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
      expect('gen_ai.server.time_per_output_token' in span.attributes).toBe(false);
      expect(await harness.metric('gen_ai.usage.cost')).toBeUndefined();
    });

    it('a consumer that stops reading ends the span with ERROR status and what was seen', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.sse', eventDelayMs: 15 });
      const stream = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
      });
      let seen = 0;
      for await (const _chunk of stream) {
        seen += 1;
        if (seen === 2) break;
      }

      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('stream cancelled before completion');
      expect(span.attributes['gen_ai.streaming.token_count']).toBe(2);
      expect(span.attributes['gen_ai.server.ttft']).toBeGreaterThan(0);
      // OpenAI reports usage on the last chunk only; none was seen, so none is claimed.
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
      expect((await harness.metric('gen_ai.client.errors'))?.points).toEqual([
        { attributes: { operation: 'openai.chat.completion', error_type: STREAM_CANCELLED }, value: 1 },
      ]);
      expect(await harness.metric('gen_ai.usage.cost')).toBeUndefined();
    });

    it('an aborted stream ends the span with ERROR status', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.sse', stallAfterEvents: 2 });
      const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true });
      setTimeout(() => stream.controller.abort(), 60);
      let seen = 0;
      for await (const _chunk of stream) seen += 1;
      expect(seen).toBe(2);

      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('stream cancelled before completion');
      expect(span.attributes['gen_ai.streaming.token_count']).toBe(2);
    });

    it('an error part-way through the stream ends the span with ERROR status and reaches the caller', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.error.sse' });
      const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true });
      let seen = 0;
      const failure = await (async () => {
        for await (const _chunk of stream) seen += 1;
      })().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OpenAI.APIError);
      expect(seen).toBe(2);

      const span = harness.span('openai.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toContain('server had an error');
      expect(span.events.map((event) => event.name)).toEqual(['exception']);
      expect(span.attributes['gen_ai.streaming.token_count']).toBe(2);
      expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    });

    it('a dropped connection part-way through ends the span with ERROR status', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.sse', dropAfterEvents: 3 });
      const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true });
      const failure = await (async () => {
        for await (const _chunk of stream) {
          // drain
        }
      })().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(harness.span('openai.chat.completion').status.code).toBe(SpanStatusCode.ERROR);
    });

    it('the stream object is the SDK one: tee() works and is measured once', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
      const stream = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(stream.controller).toBeInstanceOf(AbortController);
      const [left, right] = stream.tee();
      const drain = async (branch: AsyncIterable<unknown>): Promise<number> => {
        let count = 0;
        for await (const _chunk of branch) count += 1;
        return count;
      };
      expect(await Promise.all([drain(left), drain(right)])).toEqual([6, 6]);
      const span = harness.span('openai.chat.completion');
      expect(span.attributes['gen_ai.streaming.token_count']).toBe(6);
      expect(span.attributes['gen_ai.usage.total_tokens']).toBe(22);
    });

    it('the streaming helper is traced as one call', async () => {
      llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
      const runner = client.chat.completions.stream({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        stream_options: { include_usage: true },
      });
      const final = await runner.finalChatCompletion();
      expect(final.choices[0]?.message.content).toBe('Paris.');
      await eventually(() => expect(harness.spans()).toHaveLength(1));
      expect(harness.span('openai.chat.completion').attributes['gen_ai.usage.total_tokens']).toBe(22);
    });
  });

  describe('embeddings', () => {
    it('one span with the request shape, the vectors returned and the embedding price', async () => {
      await start();
      llm.reply({ fixture: 'openai/embeddings.float.json' });
      const result = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: ['alpha', 'beta'],
        dimensions: 4,
        encoding_format: 'float',
      });
      expect(result.data).toHaveLength(2);

      const span = harness.span('openai.embeddings');
      const cost = calculator.calculateCost('text-embedding-3-small', { prompt_tokens: 8, total_tokens: 8 }, 'embedding');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toEqual({
        'gen_ai.system': 'openai',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'text-embedding-3-small',
        'gen_ai.operation.name': 'embeddings',
        'gen_ai.request.type': 'embedding',
        'gen_ai.request.input_count': 2,
        'gen_ai.embeddings.dimension.count': 4,
        'gen_ai.request.dimensions': 4,
        // The reference wrapper stringifies a list attribute; this is its str().
        'gen_ai.request.encoding_formats': "['float']",
        'gen_ai.request.encoding_format': 'float',
        'server.address': '127.0.0.1',
        'server.port': llm.port,
        'gen_ai.response.model': 'text-embedding-3-small',
        'gen_ai.response.embedding_count': 2,
        'gen_ai.response.vector_size': 4,
        'gen_ai.usage.input_tokens': 8,
        'gen_ai.usage.prompt_tokens': 8,
        'gen_ai.usage.total_tokens': 8,
        'gen_ai.usage.cost.total': cost,
        // Where the price came from, for every call type (Python 1.46.0).
        'gen_ai.usage.cost.pricing_source': calculator.pricingSource('text-embedding-3-small', 'embedding'),
      });
      expect(cost).toBeGreaterThan(0);
    });

    it('with the SDK default (base64 on the wire) the decoded vector size is recorded', async () => {
      await start();
      llm.reply({ fixture: 'openai/embeddings.base64.json' });
      const result = await client.embeddings.create({ model: 'text-embedding-3-small', input: 'alpha' });
      expect(result.data[0]?.embedding).toEqual([0.25, -0.5, 0.125, 1]);
      const attributes = harness.span('openai.embeddings').attributes;
      expect(attributes['gen_ai.request.input_count']).toBe(1);
      expect(attributes['gen_ai.response.vector_size']).toBe(4);
      expect('gen_ai.request.encoding_formats' in attributes).toBe(false);
    });

    it('a pre-tokenised input is one input, not one per token', async () => {
      await start();
      llm.reply({ fixture: 'openai/embeddings.float.json' });
      await client.embeddings.create({ model: 'text-embedding-3-small', input: [101, 2023, 102], encoding_format: 'float' });
      expect(harness.span('openai.embeddings').attributes['gen_ai.request.input_count']).toBe(1);
    });

    it('with content capture: the embedded text, and the vector only when asked for', async () => {
      await start({ enableContentCapture: true });
      llm.reply({ fixture: 'openai/embeddings.float.json' });
      await client.embeddings.create({ model: 'text-embedding-3-small', input: ['alpha', 'beta'], encoding_format: 'float' });
      let span = harness.span('openai.embeddings');
      expect(span.attributes['embedding.model_name']).toBe('text-embedding-3-small');
      expect(span.attributes['embedding.text']).toBe('alpha');
      expect(span.events.map((event) => [event.name, event.attributes?.['gen_ai.embedding.content']])).toEqual([
        ['gen_ai.embedding.0', 'alpha'],
        ['gen_ai.embedding.1', 'beta'],
      ]);
      expect('embedding.vector' in span.attributes).toBe(false);

      expect(harness.openSpans()).toEqual([]);
      await harness.stop();
      await start({ enableContentCapture: true, captureEmbeddingVectors: true });
      llm.reply({ fixture: 'openai/embeddings.float.json' });
      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'alpha', encoding_format: 'float' });
      span = harness.span('openai.embeddings');
      expect(span.attributes['embedding.vector']).toBe('[0.25, -0.5, 0.125, 1]');
      expect(span.attributes['embedding.vector.dimension']).toBe(4);
    });
  });

  describe('responses API', () => {
    it('one span with the Responses usage shape mapped onto the canonical token names', async () => {
      await start({ enableContentCapture: true });
      llm.reply({ fixture: 'openai/responses.json' });
      const response = await client.responses.create({
        model: 'gpt-4o-mini',
        instructions: 'Be terse.',
        input: 'Capital of France?',
        max_output_tokens: 50,
      });
      expect(response.id).toBe('resp_fixture_0001');

      const span = harness.span('openai.responses');
      const attributes = span.attributes;
      expect(attributes['gen_ai.operation.name']).toBe('chat');
      expect(attributes['gen_ai.request.message_count']).toBe(1);
      expect(attributes['gen_ai.request.max_tokens']).toBe(50);
      expect(attributes['gen_ai.request.instructions']).toBe('Be terse.');
      expect(attributes['gen_ai.request.first_message']).toBe('{"role": "user", "content": "Capital of France?"}');
      expect(attributes['gen_ai.response.id']).toBe('resp_fixture_0001');
      expect(attributes['gen_ai.response.finish_reasons']).toEqual(['completed']);
      expect(attributes['gen_ai.response.finish_reason']).toBe('completed');
      expect(attributes['llm.output_messages.0.message.tool_calls.0.tool_call.id']).toBe('call_fixture_xyz');
      expect(attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name']).toBe('get_weather');
      expect(attributes['gen_ai.usage.input_tokens']).toBe(40);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(22);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(62);
      expect(attributes['gen_ai.usage.cache_read.input_tokens']).toBe(16);
      expect(attributes['gen_ai.usage.reasoning.output_tokens']).toBe(8);
      expect(attributes['gen_ai.response']).toBe('Paris.');
      expect(span.events.map((event) => event.name)).toEqual(['gen_ai.prompt.system', 'gen_ai.prompt.0', 'gen_ai.completion.0']);
    });
  });

  describe('OpenAI-compatible endpoints', () => {
    beforeEach(() => start());

    it('records the endpoint the client points at, never a guessed vendor host', async () => {
      llm.reply({ fixture: 'openai/chat.completion.local.json' });
      const gateway = new OpenAI({ apiKey: 'none', baseURL: `http://localhost:${llm.port}/v1`, maxRetries: 0 });
      await gateway.chat.completions.create({ model: 'acme-llama:7b', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['server.address']).toBe('localhost');
      expect(attributes['server.port']).toBe(llm.port);
      expect(attributes['gen_ai.system']).toBe('openai');
    });

    it('a local model with a size in its name is priced by the size tier and says so', async () => {
      llm.reply({ fixture: 'openai/chat.completion.local.json' });
      await client.chat.completions.create({ model: 'acme-llama:7b', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['gen_ai.usage.cost.pricing_source']).toBe('estimated');
      expect(attributes['gen_ai.usage.cost.total']).toBe(
        calculator.calculateCost('acme-llama:7b', { prompt_tokens: 100, completion_tokens: 20 }, 'chat'),
      );
    });

    it('a model with no price gets NO cost attribute, is marked unpriced, and is counted', async () => {
      llm.reply({ fixture: 'openai/chat.completion.local.json' });
      await client.chat.completions.create({ model: 'acme-internal-llm', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['gen_ai.usage.cost.pricing_source']).toBe('unpriced');
      expect(Object.keys(attributes).filter((key) => key.startsWith('gen_ai.usage.cost.'))).toEqual([
        'gen_ai.usage.cost.pricing_source',
      ]);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(120);
      expect((await harness.metric('gen_ai.usage.cost.pricing_missing'))?.points).toEqual([
        { attributes: { model: 'acme-internal-llm', call_type: 'chat' }, value: 1 },
      ]);
      expect(await harness.metric('gen_ai.usage.cost')).toBeUndefined();
    });

    it('a client whose base URL a dedicated instrumentor has claimed is left to that instrumentor', async () => {
      registerBaseUrlClaim('127.0.0.1', 'some-aggregator');
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const completion = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(completion.id).toBe('chatcmpl-fixture-0001');
      expect(harness.spans()).toEqual([]);
    });
  });

  describe('configuration', () => {
    const CUSTOM_PRICING = '{"chat": {"acme-internal-llm": {"promptPrice": 0.001, "completionPrice": 0.002}}}';

    it('GENAI_CUSTOM_PRICING_JSON prices a model the shipped table does not have', async () => {
      // A deliberate difference from genai_otel v1.30.0, whose OpenAI instrumentor ignores
      // custom pricing (contract/SDK_ADDITIONS.md section 3).
      await start({ customPricingJson: CUSTOM_PRICING });
      llm.reply({ fixture: 'openai/chat.completion.local.json' });
      await client.chat.completions.create({ model: 'acme-internal-llm', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      // 100 prompt and 20 completion tokens at the custom per-1K prices.
      expect(attributes['gen_ai.usage.cost.total']).toBeCloseTo(0.00014, 12);
      expect(attributes['gen_ai.usage.cost.prompt']).toBeCloseTo(0.0001, 12);
      expect(attributes['gen_ai.usage.cost.completion']).toBeCloseTo(0.00004, 12);
      expect(attributes['gen_ai.usage.cost.pricing_source']).toBe('table');
      expect(await harness.metric('gen_ai.usage.cost.pricing_missing')).toBeUndefined();
    });

    it('custom pricing overrides a shipped price', async () => {
      await start({ customPricingJson: '{"chat": {"gpt-4o-mini": {"promptPrice": 1, "completionPrice": 1}}}' });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.span('openai.chat.completion').attributes['gen_ai.usage.cost.total']).toBeCloseTo(0.028, 12);
    });

    it('custom pricing also prices spans from other instrumentation, through the cost-enrichment processor', async () => {
      await start({ customPricingJson: CUSTOM_PRICING });
      trace
        .getTracer('some.other.instrumentation')
        .startSpan('other.chat', {
          attributes: { 'gen_ai.request.model': 'acme-internal-llm', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20 },
        })
        .end();
      expect(harness.span('other.chat').attributes['gen_ai.usage.cost.total']).toBeCloseTo(0.00014, 12);
    });

    it('cost tracking off: tokens are recorded, cost is not', async () => {
      await start({ enableCostTracking: false });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['gen_ai.usage.total_tokens']).toBe(28);
      expect(Object.keys(attributes).filter((key) => key.startsWith('gen_ai.usage.cost'))).toEqual([]);
    });

    it('gen_ai opt-in: current attribute names only', async () => {
      await start({ semconvStabilityOptIn: 'gen_ai' });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['gen_ai.usage.input_tokens']).toBe(19);
      expect('gen_ai.usage.prompt_tokens' in attributes).toBe(false);
      expect('gen_ai.usage.completion_tokens' in attributes).toBe(false);
      expect('gen_ai.response.finish_reason' in attributes).toBe(false);
      expect(attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
      // The instrumentor writes gen_ai.system itself, so it stays; the current name is added.
      expect(attributes['gen_ai.provider.name']).toBe('openai');
      expect(attributes['gen_ai.system']).toBe('openai');
    });

    it('the full metrics profile records the token histograms, granular cost and finish counters', async () => {
      await start({ metricsProfile: 'full' });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect((await harness.metric('gen_ai.client.token.usage.prompt'))?.points[0]).toMatchObject({
        count: 1,
        attributes: { model: 'gpt-4o-mini', operation: 'openai.chat.completion' },
      });
      expect((await harness.metric('gen_ai.usage.cost.prompt'))?.points[0]?.attributes).toEqual({ model: 'gpt-4o-mini' });
      expect((await harness.metric('gen_ai.server.request.finish'))?.points[0]?.attributes).toEqual({
        finish_reason: 'stop',
        model: 'gpt-4o-mini',
      });
      expect((await harness.metric('gen_ai.server.request.success'))?.points[0]?.value).toBe(1);
    });

    it('session and user extractors', async () => {
      await start({
        sessionIdExtractor: (_instance, _args, params) => (params.metadata as { session?: string } | undefined)?.session,
        userIdExtractor: (_instance, _args, params) => params.user as string | undefined,
      });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, user: 'u-17', metadata: { session: 's-42' } });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['session.id']).toBe('s-42');
      expect(attributes['gen_ai.conversation.id']).toBe('s-42');
      expect(attributes['user.id']).toBe('u-17');
    });

    it('withSession puts the session on provider spans; an extractor still wins', async () => {
      await start();
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await withSession('run-7', () => client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES }), { userId: 'u-3' });
      const attributes = harness.span('openai.chat.completion').attributes;
      expect(attributes['session.id']).toBe('run-7');
      expect(attributes['gen_ai.conversation.id']).toBe('run-7');
      expect(attributes['user.id']).toBe('u-3');
      await harness.stop();

      await start({ sessionIdExtractor: () => 'from-extractor' });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await withSession('run-8', () => client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES }));
      expect(harness.span('openai.chat.completion').attributes['session.id']).toBe('from-extractor');
    });

    it('an extractor that throws does not disturb the call', async () => {
      await start({
        sessionIdExtractor: () => {
          throw new Error('bad extractor');
        },
      });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const completion = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(completion.id).toBe('chatcmpl-fixture-0001');
      expect(harness.span('openai.chat.completion').status.code).toBe(SpanStatusCode.OK);
    });

    it('a sampled-out call makes no span and still counts the request and its latency', async () => {
      await start({ samplingRate: 0 });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const completion = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(completion.id).toBe('chatcmpl-fixture-0001');
      expect(harness.spans()).toEqual([]);
      expect((await harness.metric('gen_ai.requests'))?.points[0]?.value).toBe(1);
      expect((await harness.metric('gen_ai.client.operation.duration'))?.points[0]?.count).toBe(1);
      expect(await harness.metric('gen_ai.client.token.usage')).toBeUndefined();
    });
  });

  describe('patching', () => {
    it('patches the CommonJS and the ES-module build of the SDK, which are separate classes', async () => {
      await start();
      const cjs = createRequire(import.meta.url)('openai') as { OpenAI: typeof OpenAI };
      const esm = (await import('openai')) as { OpenAI: typeof OpenAI };
      // Two class objects: instrumenting one would silently miss the other.
      for (const [flavour, Constructor] of [
        ['cjs', cjs.OpenAI],
        ['esm', esm.OpenAI],
      ] as const) {
        harness.reset();
        llm.reply({ fixture: 'openai/chat.completion.json' });
        const flavoured = new Constructor({ apiKey: 'sk-test', baseURL: `${llm.url}/v1`, maxRetries: 0 });
        await flavoured.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
        expect(harness.spans().map((span) => span.name), flavour).toEqual(['openai.chat.completion']);
      }
    });

    it('a client created before instrument() is traced too', async () => {
      const early = new OpenAI({ apiKey: 'sk-test', baseURL: `${llm.url}/v1`, maxRetries: 0 });
      await start();
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await early.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans()).toHaveLength(1);
    });

    it('uninstrument() restores the SDK methods', async () => {
      const before = OpenAI.Chat.Completions.prototype.create;
      await start();
      expect(OpenAI.Chat.Completions.prototype.create).not.toBe(before);
      await harness.stop();
      expect(OpenAI.Chat.Completions.prototype.create).toBe(before);

      // Leave a harness for afterEach to stop.
      await start();
    });

    it('instrumenting twice does not stack wrappers', async () => {
      await start();
      const second = new OpenAIInstrumentor();
      await second.instrument((await import('../../src/config')).loadConfig({}, {}));
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans()).toHaveLength(1);
      second.uninstrument();
    });

    it('an explicit module can be instrumented, for bundled applications', async () => {
      harness = await startHarness({ enabledInstrumentors: [] });
      const instrumentor = new OpenAIInstrumentor();
      instrumentor.instrumentModule({ OpenAI }, (await import('../../src/config')).loadConfig({}, {}));
      client = new OpenAI({ apiKey: 'sk-test', baseURL: `${llm.url}/v1`, maxRetries: 0 });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans()).toHaveLength(1);
      instrumentor.uninstrument();
    });
  });

  it('the fixtures are what the test thinks they are', () => {
    expect(fixtureJson<{ usage: { total_tokens: number } }>('openai/chat.completion.json').usage.total_tokens).toBe(28);
  });
});
