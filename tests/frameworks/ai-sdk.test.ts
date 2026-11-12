/**
 * Vercel AI SDK. Its functions are module exports and cannot be patched; it
 * emits OpenTelemetry spans itself through `@ai-sdk/otel`. The real SDK runs
 * here with its own mock model, in both of the integration's attribute styles,
 * and what is checked is what this library does to those spans.
 */
import { LegacyOpenTelemetry, OpenTelemetry } from '@ai-sdk/otel';
import { embed, generateText } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { withSession } from '../../src/session';
import { startHarness, type Harness } from '../helpers/harness';

let harness: Harness;

afterEach(async () => {
  await harness.stop();
});

const model = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    provider: 'openai.chat',
    modelId: 'gpt-4o-mini',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Paris.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 19, noCache: 19, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 9, text: 9, reasoning: 0 } },
      warnings: [],
    }),
  });

const expectedCost = getDefaultCostCalculator().calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat');
const SECRET = 'Capital of France?';

describe('Vercel AI SDK spans', () => {
  it('ai.* style: the model-call span is normalised, priced and in the session; the prompt is removed', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const result = await withSession('ai-session-1', () =>
      generateText({ model: model(), prompt: SECRET, telemetry: { integrations: [new LegacyOpenTelemetry()] } }),
    );
    expect(result.text).toBe('Paris.');

    const call = harness.span('ai.generateText.doGenerate');
    expect(call.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.provider.name': 'openai',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.total_tokens': 28,
      'gen_ai.usage.cost.total': expectedCost,
      'session.id': 'ai-session-1',
    });
    const outer = harness.span('ai.generateText');
    // The outer span repeats the tokens of the calls inside it: not priced a second time.
    expect('gen_ai.usage.cost.total' in outer.attributes).toBe(false);
    expect(outer.attributes['session.id']).toBe('ai-session-1');
    // Content capture is off: the SDK's own prompt and response attributes are removed.
    for (const span of [call, outer]) {
      expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
      expect(JSON.stringify(span.attributes)).not.toContain('Paris.');
    }
  });

  it('gen_ai style: the chat span is priced, the agent span over it is not, and messages are removed', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    await generateText({ model: model(), prompt: SECRET, telemetry: { integrations: [new OpenTelemetry()] } });

    const call = harness.span('chat gpt-4o-mini');
    expect(call.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.provider.name': 'openai',
      'gen_ai.usage.total_tokens': 28,
      'gen_ai.usage.cost.total': expectedCost,
    });
    const agent = harness.span('invoke_agent gpt-4o-mini');
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(19);
    expect('gen_ai.usage.cost.total' in agent.attributes).toBe(false);
    for (const span of harness.spans()) {
      expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
      expect(JSON.stringify(span.attributes)).not.toContain('Paris.');
    }
  });

  it('with content capture on, what the SDK recorded is kept', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableContentCapture: true });
    await generateText({ model: model(), prompt: SECRET, telemetry: { integrations: [new OpenTelemetry()] } });
    expect(String(harness.span('chat gpt-4o-mini').attributes['gen_ai.input.messages'])).toContain(SECRET);
  });

  it('embeddings: the embedding call is normalised and the embedded text is removed', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const embedding = new MockEmbeddingModelV4({
      provider: 'openai.embedding',
      modelId: 'text-embedding-3-small',
      doEmbed: async () => ({ embeddings: [[0.1, 0.2, 0.3]], usage: { tokens: 6 }, warnings: [] }),
    });
    await embed({ model: embedding, value: SECRET, telemetry: { integrations: [new LegacyOpenTelemetry()] } });

    const call = harness.span('ai.embed.doEmbed');
    expect(call.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.model': 'text-embedding-3-small',
      'gen_ai.usage.input_tokens': 6,
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('text-embedding-3-small', { prompt_tokens: 6, completion_tokens: 0 }, 'embedding'),
    });
    for (const span of harness.spans()) {
      expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
      expect(JSON.stringify(span.attributes)).not.toContain('0.2');
    }
  });

  it('spans of other libraries are not normalised; their content is removed by the content guard all the same (section 10)', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const { trace } = await import('@opentelemetry/api');
    const span = trace.getTracer('somebody-else').startSpan('work', { attributes: { 'gen_ai.input.messages': 'said', 'ai.prompt': 'said', 'ai.model.id': 'gpt-4o-mini' } });
    span.end();
    expect(harness.span('work').attributes).toEqual({ 'ai.model.id': 'gpt-4o-mini' });
  });
});
