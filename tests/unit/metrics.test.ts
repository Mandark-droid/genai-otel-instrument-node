import { metrics } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrument, uninstrument } from '../../src/auto-instrument';
import { setLogger } from '../../src/logger';
import {
  createCounter,
  createHistogram,
  getSharedMetrics,
  METRIC_DEFINITIONS,
  metricViews,
  resetSharedMetrics,
  SHARED_METRIC_NAMES,
} from '../../src/metrics';
import { installTestMeterProvider, ManualMetricReader, collect, type TestMeter } from '../helpers/metrics';
import { closedPort } from '../helpers/otlp-receiver';

describe('shared metrics', () => {
  let meter: TestMeter;

  beforeEach(() => {
    meter = installTestMeterProvider(metricViews());
    resetSharedMetrics();
  });

  afterEach(async () => {
    resetSharedMetrics();
    await meter.shutdown();
  });

  it('are created once and reused', () => {
    expect(getSharedMetrics()).toBe(getSharedMetrics());
  });

  it('after a reset, bind to the meter provider that is global now', async () => {
    const first = getSharedMetrics();
    first.counters.requests.add(1, { operation: 'a' });
    expect((await meter.find('gen_ai.requests'))?.points[0]?.value).toBe(1);

    await meter.shutdown();
    const second = installTestMeterProvider(metricViews());
    try {
      // Still bound to the provider that is gone: nothing arrives on the new one.
      first.counters.requests.add(1, { operation: 'a' });
      expect(await second.find('gen_ai.requests')).toBeUndefined();

      resetSharedMetrics();
      const rebound = getSharedMetrics();
      expect(rebound).not.toBe(first);
      rebound.counters.requests.add(2, { operation: 'b' });
      expect((await second.find('gen_ai.requests'))?.points[0]?.value).toBe(2);
    } finally {
      await second.shutdown();
    }
  });

  it('has one instrument per shared metric name', () => {
    const shared = getSharedMetrics();
    const count = Object.keys(shared.counters).length + Object.keys(shared.histograms).length;
    expect(count).toBe(SHARED_METRIC_NAMES.length);
    expect(new Set(SHARED_METRIC_NAMES).size).toBe(SHARED_METRIC_NAMES.length);
  });

  it('records values with their attributes', async () => {
    const shared = getSharedMetrics();
    shared.counters.tokens.add(120, { token_type: 'prompt', operation: 'openai.chat.completion' });
    shared.counters.tokens.add(30, { token_type: 'completion', operation: 'openai.chat.completion' });
    shared.counters.cost.add(0.0125, { model: 'gpt-4o' });
    shared.histograms.latency.record(0.5, { operation: 'openai.chat.completion' });

    const tokens = await meter.find('gen_ai.client.token.usage');
    expect(tokens?.points.map((point) => [point.attributes.token_type, point.value]).sort()).toEqual([
      ['completion', 30],
      ['prompt', 120],
    ]);
    expect((await meter.find('gen_ai.usage.cost'))?.points[0]).toMatchObject({ value: 0.0125, attributes: { model: 'gpt-4o' } });
    const latency = await meter.find('gen_ai.client.operation.duration');
    expect(latency?.points[0]?.count).toBe(1);
    expect(latency?.points[0]?.value).toBe(0.5);
  });
});

describe('instrument factories', () => {
  it('refuse to create an instrument of the wrong kind', () => {
    const meter = metrics.getMeter('test');
    expect(() => createCounter(meter, 'gen_ai.client.operation.duration')).toThrow(/histogram, not a counter/);
    expect(() => createHistogram(meter, 'gen_ai.requests')).toThrow(/counter, not a histogram/);
  });

  it('pass a unit only when the definition has one', () => {
    const calls: unknown[][] = [];
    const meter = {
      createCounter: (...args: unknown[]) => {
        calls.push(args);
        return { add: () => {} };
      },
      createHistogram: (...args: unknown[]) => {
        calls.push(args);
        return { record: () => {} };
      },
    } as unknown as ReturnType<typeof metrics.getMeter>;
    createCounter(meter, 'gen_ai.requests');
    createCounter(meter, 'gen_ai.usage.cost');
    createHistogram(meter, 'gen_ai.server.ttft');
    expect(calls[0]).toEqual(['gen_ai.requests', { description: METRIC_DEFINITIONS['gen_ai.requests'].description }]);
    expect(calls[1]).toEqual(['gen_ai.usage.cost', { description: 'Cost of GenAI operations', unit: 'USD' }]);
    expect(calls[2]).toEqual(['gen_ai.server.ttft', { description: 'Time to first token in seconds', unit: 's' }]);
  });
});

describe('instrument() applies the histogram views', () => {
  afterEach(async () => {
    await uninstrument(0.2);
    setLogger(undefined);
    delete process.env.GENAI_SKIP_COLLECTOR_CHECK;
  });

  it('the latency histogram exported by the configured meter provider has the contract boundaries', async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    process.env.GENAI_SKIP_COLLECTOR_CHECK = 'true';
    metrics.disable();
    const reader = new ManualMetricReader();
    instrument({ endpoint: `http://127.0.0.1:${await closedPort()}`, enabledInstrumentors: [], metricReaders: [reader] });

    getSharedMetrics().histograms.latency.record(0.3, { operation: 'x' });
    getSharedMetrics().histograms.ttft.record(0.05, { model: 'm', operation: 'x' });
    const collected = await collect(reader);
    for (const name of ['gen_ai.client.operation.duration', 'gen_ai.server.ttft'] as const) {
      expect(collected.find((metric) => metric.name === name)?.points[0]?.boundaries, name).toEqual(
        METRIC_DEFINITIONS[name].bucketBoundaries,
      );
    }
  });

  it('instruments created before uninstrument() are not reused by the next instrument()', async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    process.env.GENAI_SKIP_COLLECTOR_CHECK = 'true';
    metrics.disable();
    const endpoint = `http://127.0.0.1:${await closedPort()}`;
    instrument({ endpoint, enabledInstrumentors: [] });
    const first = getSharedMetrics();
    await uninstrument(0.2);

    const reader = new ManualMetricReader();
    instrument({ endpoint, enabledInstrumentors: [], metricReaders: [reader] });
    const second = getSharedMetrics();
    expect(second).not.toBe(first);
    second.counters.requests.add(1, { operation: 'x' });
    expect((await collect(reader)).find((metric) => metric.name === 'gen_ai.requests')?.points[0]?.value).toBe(1);
  });
});
