/**
 * Anthropic instrumentor, driven through the real `@anthropic-ai/sdk` client
 * against a mock provider replaying fixtures. No API key, no network beyond
 * localhost.
 */
import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { getDefaultCostCalculator } from '../../src/cost';
import { AnthropicInstrumentor } from '../../src/instrumentors/anthropic';
import { clearBaseUrlClaims, registerBaseUrlClaim, STREAM_CANCELLED } from '../../src/instrumentors/base';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const calculator = getDefaultCostCalculator();
const MODEL = 'claude-sonnet-4-5';
const MESSAGES = [{ role: 'user' as const, content: 'What is the capital of France?' }];

describe('Anthropic instrumentor', () => {
  let llm: MockLlm;
  let harness: Harness;
  let client: Anthropic;

  beforeAll(async () => {
    llm = await startMockLlm();
  });
  afterAll(async () => {
    await llm.close();
  });

  async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<void> {
    harness = await startHarness({ enabledInstrumentors: ['anthropic'], ...options });
    client = new Anthropic({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: llm.url, maxRetries: 0 });
  }

  afterEach(async () => {
    try {
      expect(harness.openSpans()).toEqual([]);
    } finally {
      await harness.stop();
      clearBaseUrlClaims();
      llm.requests.length = 0;
    }
  });

  describe('messages.create', () => {
    beforeEach(() => start());

    it('one span with the reference attribute set, tokens, cache tokens and cost', async () => {
      llm.reply({ fixture: 'anthropic/message.json' });
      const message = await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      expect(message.content[0]).toMatchObject({ type: 'text', text: 'The capital of France is Paris.' });

      const usage = {
        prompt_tokens: 25,
        completion_tokens: 12,
        total_tokens: 37,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 200,
      };
      const cost = calculator.calculateGranularCost(MODEL, usage, 'chat');
      const span = harness.span('anthropic.messages.create');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toEqual({
        'gen_ai.system': 'anthropic',
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': MODEL,
        'gen_ai.request.message_count': 1,
        'server.address': '127.0.0.1',
        'server.port': llm.port,
        'gen_ai.usage.input_tokens': 25,
        'gen_ai.usage.prompt_tokens': 25,
        'gen_ai.usage.output_tokens': 12,
        'gen_ai.usage.completion_tokens': 12,
        'gen_ai.usage.total_tokens': 37,
        'gen_ai.usage.cache_read.input_tokens': 300,
        'gen_ai.usage.cache_write.input_tokens': 200,
        'gen_ai.usage.cache_creation.input_tokens': 200,
        'gen_ai.usage.cost.total': cost?.total,
        'gen_ai.usage.cost.prompt': cost?.prompt,
        'gen_ai.usage.cost.completion': cost?.completion,
        'gen_ai.usage.cost.cache_read': cost?.cache_read,
        'gen_ai.usage.cost.cache_write': cost?.cache_write,
        'gen_ai.usage.cost.pricing_source': 'table',
      });
      expect(cost?.cache_read).toBeGreaterThan(0);
      expect(cost?.cache_write).toBeGreaterThan(0);
      expect(span.events).toEqual([]);

      expect((await harness.metric('gen_ai.requests'))?.points).toEqual([
        { attributes: { operation: 'anthropic.messages.create' }, value: 1 },
      ]);
      expect((await harness.metric('gen_ai.usage.cost'))?.points[0]).toMatchObject({ value: cost?.total, attributes: { model: MODEL } });
    });

    it('a tool-use response is accounted like any other; tokens and cost are recorded', async () => {
      llm.reply({ fixture: 'anthropic/message.tool-use.json' });
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        messages: MESSAGES,
        tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      });
      expect(message.stop_reason).toBe('tool_use');
      const attributes = harness.span('anthropic.messages.create').attributes;
      expect(attributes['gen_ai.usage.input_tokens']).toBe(410);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(58);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(468);
      expect(attributes['gen_ai.usage.cost.total']).toBe(
        calculator.calculateCost(MODEL, { prompt_tokens: 410, completion_tokens: 58 }, 'chat'),
      );
      // The reference Anthropic instrumentor records no tool-call, finish-reason or response-id attributes.
      expect(Object.keys(attributes).filter((key) => key.startsWith('llm.') || key.startsWith('gen_ai.response'))).toEqual([]);
    });

    it('a provider error ends the span with ERROR status and no cost', async () => {
      llm.reply({ status: 529, fixture: 'anthropic/error.529.json' });
      const failure = await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Anthropic.APIError);

      const span = harness.span('anthropic.messages.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toContain('Overloaded');
      expect(span.events.map((event) => event.name)).toEqual(['exception']);
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
      expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes.operation).toBe('anthropic.messages.create');
      expect(await harness.metric('gen_ai.usage.cost')).toBeUndefined();
    });

    it('a bad request is an error span too', async () => {
      llm.reply({ status: 400, fixture: 'anthropic/error.400.json' });
      await expect(client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES })).rejects.toBeInstanceOf(
        Anthropic.BadRequestError,
      );
      const span = harness.span('anthropic.messages.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes.error_type).toBe('BadRequestError');
    });

    it('a claimed base URL is left to the dedicated instrumentor', async () => {
      registerBaseUrlClaim('127.0.0.1', 'some-aggregator');
      llm.reply({ fixture: 'anthropic/message.json' });
      await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      expect(harness.spans()).toEqual([]);
    });
  });

  describe('content capture', () => {
    it('when enabled: first message, prompt and completion events, response text', async () => {
      await start({ enableContentCapture: true });
      llm.reply({ fixture: 'anthropic/message.json' });
      await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      const span = harness.span('anthropic.messages.create');
      expect(span.attributes['gen_ai.request.first_message']).toBe('{"role": "user", "content": "What is the capital of France?"}');
      expect(span.attributes['gen_ai.response']).toBe('The capital of France is Paris.');
      expect(span.events.map((event) => [event.name, event.attributes])).toEqual([
        ['gen_ai.prompt.0', { 'gen_ai.prompt.role': 'user', 'gen_ai.prompt.content': 'What is the capital of France?' }],
        ['gen_ai.completion.0', { 'gen_ai.completion.role': 'assistant', 'gen_ai.completion.content': 'The capital of France is Paris.' }],
      ]);
    });

    it('is off by default', async () => {
      await start();
      llm.reply({ fixture: 'anthropic/message.json' });
      await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      const span = harness.span('anthropic.messages.create');
      expect(span.events).toEqual([]);
      expect(JSON.stringify(span.attributes)).not.toContain('France');
    });
  });

  describe('messages.create with stream: true', () => {
    beforeEach(() => start());

    it('folds usage across message_start and message_delta, and closes the span at message_stop', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.sse' });
      const stream = await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES, stream: true });
      expect(harness.spans()).toHaveLength(0);
      const types: string[] = [];
      for await (const event of stream) types.push(event.type);
      expect(types).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);

      const span = harness.span('anthropic.messages.create');
      const attributes = span.attributes;
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(attributes['gen_ai.request.stream']).toBe(true);
      expect(attributes['gen_ai.streaming.token_count']).toBe(7);
      expect(attributes['gen_ai.usage.input_tokens']).toBe(25);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(9);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(34);
      expect(attributes['gen_ai.usage.cost.total']).toBe(
        calculator.calculateCost(MODEL, { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 }, 'chat'),
      );
      expect(attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
      expect(attributes['gen_ai.server.time_per_output_token']).toBeGreaterThanOrEqual(0);
    });

    it('cumulative message_delta counts are not summed: 5 then 9 is 9', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.tool-use.sse' });
      const stream = await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES, stream: true });
      for await (const _event of stream) {
        // drain
      }
      const attributes = harness.span('anthropic.messages.create').attributes;
      expect(attributes['gen_ai.usage.output_tokens']).toBe(9);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(34);
    });

    it('a cancelled stream ends the span with ERROR status and the input tokens it saw, and no cost', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.sse', eventDelayMs: 15 });
      const stream = await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES, stream: true });
      let seen = 0;
      for await (const _event of stream) {
        seen += 1;
        if (seen === 3) break;
      }
      const span = harness.span('anthropic.messages.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('stream cancelled before completion');
      expect(span.attributes['gen_ai.streaming.token_count']).toBe(3);
      // message_start carried the input tokens (and the first output token).
      expect(span.attributes['gen_ai.usage.input_tokens']).toBe(25);
      expect(span.attributes['gen_ai.usage.output_tokens']).toBe(1);
      expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
      expect('gen_ai.usage.cost.pricing_source' in span.attributes).toBe(false);
      expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes.error_type).toBe(STREAM_CANCELLED);
      expect(await harness.metric('gen_ai.usage.cost')).toBeUndefined();
      const tokens = (await harness.metric('gen_ai.client.token.usage'))?.points ?? [];
      expect(tokens.find((point) => point.attributes.token_type === 'prompt')?.value).toBe(25);
    });

    it('an error event part-way through ends the span with ERROR status and the tokens seen', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.error.sse' });
      const stream = await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES, stream: true });
      const failure = await (async () => {
        for await (const _event of stream) {
          // drain
        }
      })().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Anthropic.APIError);
      const span = harness.span('anthropic.messages.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.map((event) => event.name)).toEqual(['exception']);
      expect(span.attributes['gen_ai.usage.input_tokens']).toBe(25);
      expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    });
  });

  describe('messages.stream()', () => {
    beforeEach(() => start());

    it('one span named anthropic.messages.stream, measured whether or not the caller iterates', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.sse' });
      const stream = client.messages.stream({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      const final = await stream.finalMessage();
      expect(final.content[0]).toMatchObject({ type: 'text', text: 'Paris.' });
      expect(final.usage.output_tokens).toBe(9);

      await eventually(() => expect(harness.spans()).toHaveLength(1));
      // Exactly one span: the helper's inner create() call is not traced a second time.
      const span = harness.span('anthropic.messages.stream');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toMatchObject({
        'gen_ai.system': 'anthropic',
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': MODEL,
        'gen_ai.request.message_count': 1,
        'gen_ai.streaming.token_count': 7,
        'gen_ai.usage.input_tokens': 25,
        'gen_ai.usage.output_tokens': 9,
        'gen_ai.usage.total_tokens': 34,
        'gen_ai.usage.cost.pricing_source': 'table',
      });
      expect(span.attributes['gen_ai.usage.cost.total']).toBe(
        calculator.calculateCost(MODEL, { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 }, 'chat'),
      );
      expect(span.attributes['gen_ai.server.ttft']).toBeGreaterThan(0);
      // The reference does not count messages.stream() in gen_ai.requests.
      expect(await harness.metric('gen_ai.requests')).toBeUndefined();
    });

    it('iteration and event listeners still work', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.tool-use.sse' });
      const stream = client.messages.stream({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      let text = '';
      stream.on('text', (delta) => {
        text += delta;
      });
      let events = 0;
      for await (const _event of stream) events += 1;
      expect(text).toBe('Paris.');
      expect(events).toBe(12);
      await eventually(() => expect(harness.spans()).toHaveLength(1));
      const attributes = harness.span('anthropic.messages.stream').attributes;
      expect(attributes['gen_ai.usage.output_tokens']).toBe(9);
      expect(attributes['gen_ai.streaming.token_count']).toBe(12);
    });

    it('abort() ends the span with ERROR status and the tokens seen', async () => {
      llm.reply({ fixture: 'anthropic/message.stream.sse', stallAfterEvents: 3 });
      const stream = client.messages.stream({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      stream.on('error', () => {});
      setTimeout(() => stream.abort(), 80);
      await stream.done().catch(() => undefined);

      await eventually(() => expect(harness.spans()).toHaveLength(1));
      const span = harness.span('anthropic.messages.stream');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('stream cancelled before completion');
      expect(span.attributes['gen_ai.usage.input_tokens']).toBe(25);
      expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    });

    it('a provider error ends the span with ERROR status and no cost', async () => {
      llm.reply({ status: 529, fixture: 'anthropic/error.529.json' });
      const stream = client.messages.stream({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      await expect(stream.finalMessage()).rejects.toBeInstanceOf(Anthropic.APIError);
      await eventually(() => expect(harness.spans()).toHaveLength(1));
      const span = harness.span('anthropic.messages.stream');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.map((event) => event.name)).toEqual(['exception']);
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
    });
  });

  describe('patching', () => {
    it('patches the CommonJS and the ES-module build of the SDK', async () => {
      await start();
      const cjs = createRequire(import.meta.url)('@anthropic-ai/sdk') as { Anthropic: typeof Anthropic };
      const esm = (await import('@anthropic-ai/sdk')) as { Anthropic: typeof Anthropic };
      for (const [flavour, Constructor] of [
        ['cjs', cjs.Anthropic],
        ['esm', esm.Anthropic],
      ] as const) {
        harness.reset();
        llm.reply({ fixture: 'anthropic/message.json' });
        const flavoured = new Constructor({ apiKey: 'sk-ant-test', baseURL: llm.url, maxRetries: 0 });
        await flavoured.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES });
        expect(harness.spans().map((span) => span.name), flavour).toEqual(['anthropic.messages.create']);
      }
    });

    it('uninstrument() restores the SDK methods', async () => {
      const create = Anthropic.Messages.prototype.create;
      const stream = Anthropic.Messages.prototype.stream;
      await start();
      expect(Anthropic.Messages.prototype.create).not.toBe(create);
      expect(Anthropic.Messages.prototype.stream).not.toBe(stream);
      await harness.stop();
      expect(Anthropic.Messages.prototype.create).toBe(create);
      expect(Anthropic.Messages.prototype.stream).toBe(stream);
      await start();
    });

    it('an explicit module can be instrumented, for bundled applications', async () => {
      harness = await startHarness({ enabledInstrumentors: [] });
      const instrumentor = new AnthropicInstrumentor();
      instrumentor.instrumentModule({ Anthropic }, loadConfig({}, {}));
      client = new Anthropic({ apiKey: 'sk-ant-test', baseURL: llm.url, maxRetries: 0 });
      llm.reply({ fixture: 'anthropic/message.json' });
      await client.messages.create({ model: MODEL, max_tokens: 64, messages: MESSAGES });
      expect(harness.spans()).toHaveLength(1);
      instrumentor.uninstrument();
    });
  });
});
