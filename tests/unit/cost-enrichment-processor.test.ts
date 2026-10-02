import type { Attributes } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostCalculator, getDefaultCostCalculator } from '../../src/cost';
import { CostEnrichmentSpanProcessor } from '../../src/cost/enrichment-processor';
import { PRICING_MISSING_METRIC, resetPricingMissingCounter } from '../../src/cost/pricing-missing';
import { setLogger } from '../../src/logger';
import { installTestMeterProvider, type TestMeter } from '../helpers/metrics';

describe('CostEnrichmentSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let meter: TestMeter;
  const calculator = getDefaultCostCalculator();

  beforeEach(() => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    meter = installTestMeterProvider();
    resetPricingMissingCounter();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new CostEnrichmentSpanProcessor(calculator), new SimpleSpanProcessor(exporter)],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
    await meter.shutdown();
    resetPricingMissingCounter();
    setLogger(undefined);
  });

  function finish(attributes: Attributes): Attributes {
    const span = provider.getTracer('third-party-instrumentation').startSpan('llm-call', { attributes });
    span.end();
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    return finished[0]?.attributes ?? {};
  }

  const missing = async (): Promise<{ attributes: Record<string, unknown>; value: number }[]> =>
    (await meter.find(PRICING_MISSING_METRIC))?.points ?? [];

  it('adds total, prompt and completion cost to a GenAI span that has none', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 500 };
    const expected = calculator.calculateGranularCost('gpt-4o', usage, 'chat');
    const attributes = finish({
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    });
    expect(expected?.total).toBeGreaterThan(0);
    expect(attributes['gen_ai.usage.cost.total']).toBe(expected?.total);
    expect(attributes['gen_ai.usage.cost.prompt']).toBe(expected?.prompt);
    expect(attributes['gen_ai.usage.cost.completion']).toBe(expected?.completion);
  });

  it('reads the superseded token names when the current ones are absent', () => {
    const attributes = finish({
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.prompt_tokens': 1000,
      'gen_ai.usage.completion_tokens': 500,
    });
    expect(attributes['gen_ai.usage.cost.total']).toBe(
      calculator.calculateCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 500 }, 'chat'),
    );
  });

  it('reads OpenInference attribute names', () => {
    const attributes = finish({
      'llm.model_name': 'gpt-4o',
      'llm.token_count.prompt': 200,
      'llm.token_count.completion': 100,
      'openinference.span.kind': 'LLM',
    });
    expect(attributes['gen_ai.usage.cost.total']).toBe(
      calculator.calculateCost('gpt-4o', { prompt_tokens: 200, completion_tokens: 100 }, 'chat'),
    );
  });

  it('maps an embeddings operation onto embedding pricing, which has a total only', () => {
    const attributes = finish({
      'gen_ai.request.model': 'text-embedding-3-small',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.usage.input_tokens': 1000,
    });
    expect(attributes['gen_ai.usage.cost.total']).toBe(
      calculator.calculateCost('text-embedding-3-small', { prompt_tokens: 1000 }, 'embedding'),
    );
    expect('gen_ai.usage.cost.prompt' in attributes).toBe(false);
    expect('gen_ai.usage.cost.completion' in attributes).toBe(false);
  });

  it('maps OpenInference kinds: an EMBEDDING span uses the embedding model name', () => {
    const attributes = finish({
      'embedding.model_name': 'text-embedding-3-small',
      'llm.token_count.prompt': 1000,
      'openinference.span.kind': 'EMBEDDING',
    });
    expect(attributes['gen_ai.usage.cost.total']).toBe(
      calculator.calculateCost('text-embedding-3-small', { prompt_tokens: 1000 }, 'embedding'),
    );
  });

  it('an unrecognised operation name is priced as chat', () => {
    const attributes = finish({
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.operation.name': 'something_else',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 10,
    });
    expect(attributes['gen_ai.usage.cost.total']).toBe(
      calculator.calculateCost('gpt-4o', { prompt_tokens: 10, completion_tokens: 10 }, 'chat'),
    );
  });

  it('leaves a span alone when the instrumentor already priced it', () => {
    const attributes = finish({
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
      'gen_ai.usage.cost.total': 123.45,
    });
    expect(attributes['gen_ai.usage.cost.total']).toBe(123.45);
    expect('gen_ai.usage.cost.prompt' in attributes).toBe(false);
  });

  it('leaves a span with no model, or with no tokens, alone', async () => {
    expect(finish({ 'http.method': 'GET' })).toEqual({ 'http.method': 'GET' });
    exporter.reset();
    expect(finish({})).toEqual({});
    exporter.reset();
    const noTokens = finish({ 'gen_ai.request.model': 'totally-unknown-model' });
    expect('gen_ai.usage.cost.total' in noTokens).toBe(false);
    expect(await missing()).toEqual([]);
  });

  it('an unpriced model gets NO cost attribute, and is counted as pricing missing', async () => {
    const attributes = finish({
      'gen_ai.request.model': 'totally-unknown-model',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    });
    expect(Object.keys(attributes).filter((key) => key.startsWith('gen_ai.usage.cost'))).toEqual([]);
    const points = await missing();
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({ model: 'totally-unknown-model', call_type: 'chat' });
  });

  it('a priced model that costs nothing gets no cost attribute and is NOT counted as missing', async () => {
    const free = new CostCalculator({ pricingData: { chat: { 'free-model': { promptPrice: 0, completionPrice: 0 } } } });
    const local = new BasicTracerProvider({
      spanProcessors: [new CostEnrichmentSpanProcessor(free), new SimpleSpanProcessor(exporter)],
    });
    local
      .getTracer('t')
      .startSpan('s', {
        attributes: { 'gen_ai.request.model': 'free-model', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 10 },
      })
      .end();
    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect('gen_ai.usage.cost.total' in attributes).toBe(false);
    expect(await missing()).toEqual([]);
    await local.shutdown();
  });

  it('does not count a span twice when an instrumentor already recorded its pricing source', async () => {
    finish({
      'gen_ai.request.model': 'totally-unknown-model',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
      'gen_ai.usage.cost.pricing_source': 'unpriced',
    });
    expect(await missing()).toEqual([]);
  });

  it("leaves this library's own spans alone: its instrumentors decide their own cost, including none", () => {
    // A cancelled stream carries the tokens it saw and deliberately no cost.
    const span = provider.getTracer('genai_otel.instrumentors.base').startSpan('openai.chat.completion', {
      attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 500 },
    });
    span.end();
    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect('gen_ai.usage.cost.total' in attributes).toBe(false);
  });

  it('a table entry the calculator raises on is counted as pricing missing', async () => {
    finish({ 'gen_ai.request.model': 'nvidia/NV-Embed-v2', 'gen_ai.operation.name': 'embeddings', 'gen_ai.usage.input_tokens': 100 });
    const points = await missing();
    expect(points).toEqual([{ attributes: { model: 'nvidia/NV-Embed-v2', call_type: 'embedding' }, value: 1 }]);
  });

  it('a calculator failure never reaches the span or the host', () => {
    const broken = new CostCalculator({ pricingData: { chat: { 'bad-entry': 'not-an-object' } } });
    vi.spyOn(broken, 'calculateGranularCost').mockImplementation(() => {
      throw new TypeError('boom');
    });
    const local = new BasicTracerProvider({
      spanProcessors: [new CostEnrichmentSpanProcessor(broken), new SimpleSpanProcessor(exporter)],
    });
    expect(() =>
      local
        .getTracer('t')
        .startSpan('s', { attributes: { 'gen_ai.request.model': 'bad-entry', 'gen_ai.usage.input_tokens': 5 } })
        .end(),
    ).not.toThrow();
    expect('gen_ai.usage.cost.total' in (exporter.getFinishedSpans()[0]?.attributes ?? {})).toBe(false);
  });

  it('uses the shared default calculator when none is given, and flushes and shuts down cleanly', async () => {
    const processor = new CostEnrichmentSpanProcessor();
    expect(processor.costCalculator).toBe(getDefaultCostCalculator());
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
