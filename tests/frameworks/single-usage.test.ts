/**
 * One model call, one usage record (SDK_ADDITIONS.md section 8). A framework span over a provider call that this SDK also
 * traces carries no tokens, no cost and records no token or cost metrics:
 * the provider span does, once. When nothing beneath it recorded usage, the
 * framework span keeps its own.
 *
 * The framework is LangChain (`@langchain/core`); the provider is the real
 * `openai` client against the mock provider.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let llm: MockLlm;
let harness: Harness | undefined;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  try {
    expect(harness?.openSpans()).toEqual([]);
  } finally {
    await harness?.stop();
    harness = undefined;
    clearBaseUrlClaims();
  }
});

const USAGE_KEYS = (attributes: Record<string, unknown>): string[] => Object.keys(attributes).filter((key) => key.startsWith('gen_ai.usage.') && key !== 'gen_ai.usage.recorded_by');
const calculator = getDefaultCostCalculator();

/** A LangChain chat model that calls the OpenAI client, the way `@langchain/openai` does. */
class ChatOpenAIOverClient extends BaseChatModel {
  model = 'gpt-4o-mini';
  calls = 1;
  constructor(private readonly client: OpenAI) {
    super({});
  }
  _llmType(): string {
    return 'over-openai-client';
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    let text = '';
    let input = 0;
    let output = 0;
    for (let i = 0; i < this.calls; i += 1) {
      const completion = await this.client.chat.completions.create({ model: this.model, messages: messages.map((m) => ({ role: 'user' as const, content: String(m.content) })) });
      text += completion.choices[0]?.message.content ?? '';
      input += completion.usage?.prompt_tokens ?? 0;
      output += completion.usage?.completion_tokens ?? 0;
    }
    // LangChain reports the provider's usage on its message, as @langchain/openai does.
    const message = new AIMessage({ content: text, usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } });
    return { generations: [{ text, message }] };
  }
  override async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: 'user' as const, content: String(m.content) })),
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      const usage = chunk.usage ? { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens, total_tokens: chunk.usage.total_tokens } : undefined;
      yield new ChatGenerationChunk({ text: chunk.choices[0]?.delta?.content ?? '', message: new AIMessageChunk({ content: chunk.choices[0]?.delta?.content ?? '', usage_metadata: usage }) });
    }
  }
}

/** A LangChain chat model whose provider is not instrumented: it answers from memory. */
class UninstrumentedChat extends BaseChatModel {
  model = 'gpt-4o-mini';
  _llmType(): string {
    return 'uninstrumented';
  }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ content: 'Paris.', usage_metadata: { input_tokens: 19, output_tokens: 9, total_tokens: 28 } });
    return { generations: [{ text: 'Paris.', message }] };
  }
}

const openai = (): OpenAI => new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });

/** The sum over every point of a metric. */
async function total(name: string): Promise<number> {
  const metric = await harness?.metric(name);
  return (metric?.points ?? []).reduce((sum, point) => sum + point.value, 0);
}

describe('one model call, one usage record', () => {
  it('buffered: usage, cost and metrics once, on the provider span; the framework span says why it has none', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai', 'langchain'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await new ChatOpenAIOverClient(openai()).invoke([new HumanMessage('Capital of France?')]);

    const provider = harness.span('openai.chat.completion');
    const framework = harness.span('langchain.chat_model.invoke');
    expect(provider.parentSpanContext?.spanId).toBe(framework.spanContext().spanId);
    expect(provider.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 19, 'gen_ai.usage.output_tokens': 9, 'gen_ai.usage.cost.total': calculator.calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat') });
    expect(USAGE_KEYS(framework.attributes)).toEqual([]);
    expect(framework.attributes['gen_ai.usage.recorded_by']).toBe('descendant');

    // The token counter and the cost counter count the call once.
    expect(await total('gen_ai.usage.cost')).toBeCloseTo(calculator.calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat') ?? 0, 12);
    const tokens = (await harness.metric('gen_ai.client.token.usage'))?.points ?? [];
    expect(tokens.reduce((sum, point) => sum + point.value, 0)).toBe(28);
  });

  it('streamed: the same, also while the provider stream is still being read', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai', 'langchain'] });
    llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
    let text = '';
    for await (const chunk of await new ChatOpenAIOverClient(openai()).stream([new HumanMessage('Capital?')])) text += String(chunk.content);
    expect(text.length).toBeGreaterThan(0);
    const provider = harness.span('openai.chat.completion');
    const framework = harness.span('langchain.chat_model.invoke');
    expect(provider.attributes['gen_ai.usage.total_tokens']).toBe(22);
    expect(USAGE_KEYS(framework.attributes)).toEqual([]);
    expect(framework.attributes['gen_ai.usage.recorded_by']).toBe('descendant');
    // Streaming does not change a span's name (SDK_ADDITIONS.md section 7).
    expect(framework.attributes['gen_ai.request.stream'] ?? framework.attributes['langchain.chat_model.operation']).toBeTruthy();
  });

  it('an uninstrumented provider: the framework span keeps its usage', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai', 'langchain'] });
    await new UninstrumentedChat({}).invoke([new HumanMessage('Capital?')]);
    const framework = harness.span('langchain.chat_model.invoke');
    expect(framework.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 19, 'gen_ai.usage.output_tokens': 9 });
    expect('gen_ai.usage.recorded_by' in framework.attributes).toBe(false);
    expect(await total('gen_ai.usage.cost')).toBeCloseTo(calculator.calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat') ?? 0, 12);
  });

  it('two provider calls under one framework span: two records, none on the framework span', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai', 'langchain'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const model = new ChatOpenAIOverClient(openai());
    model.calls = 2;
    await model.invoke([new HumanMessage('Capital?')]);
    const providers = harness.spans().filter((span) => span.name === 'openai.chat.completion');
    expect(providers.map((span) => span.attributes['gen_ai.usage.total_tokens'])).toEqual([28, 28]);
    expect(USAGE_KEYS(harness.span('langchain.chat_model.invoke').attributes)).toEqual([]);
    const tokens = (await harness.metric('gen_ai.client.token.usage'))?.points ?? [];
    expect(tokens.reduce((sum, point) => sum + point.value, 0)).toBe(56);
  });

  it('a provider call that fails with no usage: the framework span keeps the usage it has', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai', 'langchain'] });
    llm.reply({ status: 500, json: { error: { message: 'boom' } } });
    class FallsBack extends UninstrumentedChat {
      override async _generate(): Promise<ChatResult> {
        // The provider fails; the framework answers from elsewhere, with usage of its own.
        await openai().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
        return super._generate();
      }
    }
    await new FallsBack({}).invoke([new HumanMessage('Capital?')]);
    expect(harness.span('openai.chat.completion').status.code).toBe(2);
    expect(harness.span('langchain.chat_model.invoke').attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 19 });
  });
});
