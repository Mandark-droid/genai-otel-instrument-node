/**
 * Providers reached through the `openai` (or `@anthropic-ai/sdk`) client at a
 * base URL of their own: OpenRouter, CometAPI, Hyperbolic, SambaNova, Anyscale,
 * and Azure OpenAI. Real clients, mock provider, no network beyond localhost.
 */
import Anthropic from '@anthropic-ai/sdk';
import { SpanStatusCode } from '@opentelemetry/api';
import OpenAI, { AzureOpenAI } from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { availableInstrumentors } from '../../src/instrumentors';
import { clearBaseUrlClaims, findBaseUrlClaim } from '../../src/instrumentors/base';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const MESSAGES = [{ role: 'user' as const, content: 'What is the capital of France?' }];
const USAGE = { prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 };

describe('OpenAI-compatible providers', () => {
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
      clearBaseUrlClaims();
      llm.requests.length = 0;
    }
  });

  /** A client whose base URL carries the provider's domain and still reaches the mock. */
  const openaiAt = (domain: string): OpenAI =>
    new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/${domain}/v1`, maxRetries: 0 });
  const plainOpenAI = (): OpenAI => new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });

  it('every name is registered', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    expect(availableInstrumentors()).toEqual(expect.arrayContaining(['openrouter', 'cometapi', 'hyperbolic', 'sambanova', 'anyscale']));
  });

  describe('OpenRouter', () => {
    it('a client at openrouter.ai gets ONE span, from the OpenRouter instrumentor, with tokens and cost', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      expect(findBaseUrlClaim('https://openrouter.ai/api/v1')).toBe('openrouter');
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await openaiAt('openrouter.ai').chat.completions.create({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        temperature: 0.2,
        frequency_penalty: 0.1,
        // @ts-expect-error OpenRouter-specific request fields
        provider: { order: ['openai'] },
        route: 'fallback',
      });
      expect(harness.spans().map((span) => span.name)).toEqual(['openrouter.chat.completion']);
      const attributes = harness.span('openrouter.chat.completion').attributes;
      expect(attributes).toMatchObject({
        'gen_ai.system': 'openrouter',
        'gen_ai.provider.name': 'openrouter',
        'gen_ai.request.model': 'gpt-4o-mini',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.message_count': 1,
        'gen_ai.request.temperature': 0.2,
        'gen_ai.request.frequency_penalty': 0.1,
        'openrouter.provider': "{'order': ['openai']}",
        'openrouter.route': 'fallback',
        'gen_ai.response.id': 'chatcmpl-fixture-0001',
        'gen_ai.usage.input_tokens': 19,
        'gen_ai.usage.output_tokens': 9,
        'gen_ai.usage.total_tokens': 28,
        'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', USAGE, 'chat'),
        'gen_ai.response.finish_reasons': ['stop'],
      });
    });

    it('embeddings get their own span', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      llm.reply({ fixture: 'openai/embeddings.float.json' });
      await openaiAt('openrouter.ai').embeddings.create({ model: 'text-embedding-3-small', input: ['a', 'b'] });
      expect(harness.spans().map((span) => span.name)).toEqual(['openrouter.embeddings']);
      expect(harness.span('openrouter.embeddings').attributes).toMatchObject({
        'gen_ai.system': 'openrouter',
        'gen_ai.operation.name': 'embeddings',
        'gen_ai.request.type': 'embedding',
        'gen_ai.request.input_count': 2,
      });
    });

    it('a streamed call is measured and closed', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
      const stream = await openaiAt('openrouter.ai').chat.completions.create({
        model: 'gpt-4o-mini',
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
      });
      let text = '';
      for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
      expect(text.length).toBeGreaterThan(0);
      const span = harness.span('openrouter.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes['gen_ai.usage.total_tokens']).toBeGreaterThan(0);
    });

    it('a client pointed elsewhere is left to the OpenAI instrumentor', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await plainOpenAI().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans().map((span) => span.name)).toEqual(['openai.chat.completion']);
    });

    it('enabled on its own, it traces only its own clients', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openrouter'] });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await plainOpenAI().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans()).toEqual([]);
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await openaiAt('openrouter.ai').chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans().map((span) => span.name)).toEqual(['openrouter.chat.completion']);
    });

    it('a provider error ends the span with ERROR status and no cost', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      llm.reply({ fixture: 'openai/error.429.json', status: 429 });
      await expect(openaiAt('openrouter.ai').chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES })).rejects.toThrow();
      const span = harness.span('openrouter.chat.completion');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
    });

    it('after uninstrument() calls pass straight through', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      await harness.stop();
      llm.reply({ fixture: 'openai/chat.completion.json' });
      const completion = await openaiAt('openrouter.ai').chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(completion.id).toBe('chatcmpl-fixture-0001');
      expect(harness.spans()).toEqual([]);
      harness = await startHarness({ enabledInstrumentors: ['openai', 'openrouter'] });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await openaiAt('openrouter.ai').chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans().map((span) => span.name)).toEqual(['openrouter.chat.completion']);
    });
  });

  describe('CometAPI', () => {
    it('through the OpenAI client', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'cometapi', 'anthropic'] });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await openaiAt('api.cometapi.com').chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
      expect(harness.spans().map((span) => span.name)).toEqual(['cometapi.chat.completion']);
      expect(harness.span('cometapi.chat.completion').attributes).toMatchObject({
        'gen_ai.system': 'cometapi',
        'gen_ai.usage.total_tokens': 28,
        'gen_ai.response.finish_reasons': ['stop'],
      });
    });

    it('through the Anthropic client: Anthropic usage names, cache tokens, stop reason', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', 'cometapi', 'anthropic'] });
      llm.reply({ fixture: 'anthropic/message.json' });
      const client = new Anthropic({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: `${llm.url}/api.cometapi.com`, maxRetries: 0 });
      await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: MESSAGES });
      expect(harness.spans().map((span) => span.name)).toEqual(['cometapi.messages.create']);
      const attributes = harness.span('cometapi.messages.create').attributes;
      expect(attributes['gen_ai.system']).toBe('cometapi');
      expect(attributes['gen_ai.usage.input_tokens']).toBe(25);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(12);
      expect(attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
      expect(attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
    });

    it('an Anthropic client pointed elsewhere is left to the Anthropic instrumentor', async () => {
      harness = await startHarness({ enabledInstrumentors: ['cometapi', 'anthropic'] });
      llm.reply({ fixture: 'anthropic/message.json' });
      const client = new Anthropic({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: llm.url, maxRetries: 0 });
      await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: MESSAGES });
      expect(harness.spans().map((span) => span.name)).toEqual(['anthropic.messages.create']);
    });
  });

  describe.each([
    ['hyperbolic', 'api.hyperbolic.xyz', 'hyperbolic.chat.completion'],
    ['sambanova', 'api.sambanova.ai', 'sambanova.chat.completion'],
  ])('%s', (name, domain, spanName) => {
    it('a client at its endpoint gets one span under its own name, with tokens and cost', async () => {
      harness = await startHarness({ enabledInstrumentors: ['openai', name] });
      llm.reply({ fixture: 'openai/chat.completion.json' });
      await openaiAt(domain).chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, max_tokens: 32 });
      expect(harness.spans().map((span) => span.name)).toEqual([spanName]);
      expect(harness.span(spanName).attributes).toMatchObject({
        'gen_ai.system': name,
        'gen_ai.request.model': 'gpt-4o-mini',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.message_count': 1,
        'gen_ai.request.max_tokens': 32,
        'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
        'gen_ai.usage.total_tokens': 28,
        'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', USAGE, 'chat'),
      });
    });
  });

  it('anyscale is a registered no-op, as in the reference', async () => {
    harness = await startHarness({ enabledInstrumentors: ['anyscale'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await plainOpenAI().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    expect(harness.spans()).toEqual([]);
    expect(harness.logs.warn.join('\n')).not.toContain('anyscale');
  });

  it('Azure OpenAI: the AzureOpenAI client is traced by the OpenAI instrumentor', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const client = new AzureOpenAI({ apiKey: 'azure-test-not-a-real-key', apiVersion: '2024-10-21', endpoint: llm.url, maxRetries: 0 });
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    const span = harness.span('openai.chat.completion');
    expect(span.attributes['gen_ai.system']).toBe('openai');
    expect(span.attributes['server.address']).toBe('127.0.0.1');
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(28);
    expect(llm.requests[0]?.path).toContain('/openai/deployments/gpt-4o-mini/chat/completions');
  });
});
