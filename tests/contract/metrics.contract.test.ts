/**
 * Metrics contract: instrument name, unit, kind, description, scope and
 * histogram bucket boundaries (contract/metrics.json), read back through a real
 * SDK meter provider configured the way instrument() configures it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import contract from '../../contract/metrics.json';
import {
  BASE_METER_NAME,
  getSharedMetrics,
  METRIC_DEFINITIONS,
  metricViews,
  NODE_ONLY_METRICS,
  resetSharedMetrics,
  SHARED_METRIC_NAMES,
} from '../../src/metrics';
import { installTestMeterProvider, type CollectedMetric, type TestMeter } from '../helpers/metrics';

interface ContractMetric {
  name: string;
  kind: string;
  unit: string;
  description: string;
  meter: string;
  bucket_boundaries: number[] | null;
  bucket_source: string | null;
  requires_gpu_device: boolean;
}

const all = contract.metrics as ContractMetric[];
const base = all.filter((metric) => metric.meter === 'genai_otel.instrumentors.base');

describe('metric definitions', () => {
  it('cover every metric in the contract, field for field', () => {
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual(all.map((metric) => metric.name).sort());
    for (const metric of all) {
      const definition = METRIC_DEFINITIONS[metric.name as keyof typeof METRIC_DEFINITIONS];
      expect(definition, metric.name).toEqual({
        name: metric.name,
        kind: metric.kind,
        unit: metric.unit,
        description: metric.description,
        meter: metric.meter,
        bucketBoundaries: metric.bucket_boundaries,
        bucketSource: metric.bucket_source,
        requiresGpuDevice: metric.requires_gpu_device,
      });
    }
  });

  it('the shared GenAI client metrics are exactly the base meter of the reference implementation', () => {
    expect(BASE_METER_NAME).toBe('genai_otel.instrumentors.base');
    expect([...SHARED_METRIC_NAMES].sort()).toEqual(base.map((metric) => metric.name).sort());
  });

  it('metrics this SDK adds are named, and are not in the contract', () => {
    const names = new Set(all.map((metric) => metric.name));
    expect(NODE_ONLY_METRICS).toEqual(['gen_ai.usage.cost.pricing_missing']);
    for (const name of NODE_ONLY_METRICS) expect(names.has(name), name).toBe(false);
  });
});

describe('instruments as the SDK reports them', () => {
  let meter: TestMeter;
  let collected: CollectedMetric[];

  beforeEach(async () => {
    meter = installTestMeterProvider(metricViews());
    resetSharedMetrics();
    const shared = getSharedMetrics();
    // One measurement on every instrument, so each shows up in a collection.
    for (const instrument of Object.values(shared.counters)) instrument.add(1, { probe: 'true' });
    for (const instrument of Object.values(shared.histograms)) instrument.record(1, { probe: 'true' });
    collected = await meter.collect();
  });

  afterEach(async () => {
    resetSharedMetrics();
    await meter.shutdown();
  });

  it.each(base.map((metric) => [metric.name, metric] as const))('%s', (_name, expected) => {
    const actual = collected.find((metric) => metric.name === expected.name);
    expect(actual, `${expected.name} was not created`).toBeDefined();
    expect(actual?.unit, 'unit').toBe(expected.unit);
    expect(actual?.description, 'description').toBe(expected.description);
    expect(actual?.scope, 'meter').toBe(expected.meter);
    if (expected.kind === 'counter') {
      expect(actual?.kind, 'kind').toBe('sum');
      expect(actual?.monotonic, 'monotonic').toBe(true);
    } else {
      expect(expected.kind).toBe('histogram');
      expect(actual?.kind, 'kind').toBe('histogram');
      expect(actual?.points[0]?.boundaries, 'bucket boundaries').toEqual(expected.bucket_boundaries);
    }
  });

  it('creates nothing beyond the contract and the documented additions', () => {
    const allowed = new Set([...base.map((metric) => metric.name), ...NODE_ONLY_METRICS]);
    expect(collected.map((metric) => metric.name).filter((name) => !allowed.has(name))).toEqual([]);
  });
});

describe('histogram views', () => {
  const viewBacked = all.filter((metric) => metric.bucket_source === 'view');

  it('there is one view per view-backed histogram in the contract, all meters included', () => {
    expect(
      metricViews()
        .map((view) => view.instrumentName)
        .sort(),
    ).toEqual(viewBacked.map((metric) => metric.name).sort());
  });

  it.each(viewBacked.map((metric) => [metric.name, metric] as const))('%s gets its boundaries from the view', async (_name, expected) => {
    const meter = installTestMeterProvider(metricViews());
    try {
      meter.provider.getMeter(expected.meter).createHistogram(expected.name, { unit: expected.unit }).record(1);
      const metric = await meter.find(expected.name);
      expect(metric?.points[0]?.boundaries).toEqual(expected.bucket_boundaries);
    } finally {
      await meter.shutdown();
    }
  });

  it('a histogram with no view gets the SDK default boundaries the contract recorded', async () => {
    const meter = installTestMeterProvider(metricViews());
    try {
      meter.provider.getMeter('probe').createHistogram('contract.probe').record(1);
      const metric = await meter.find('contract.probe');
      expect(metric?.points[0]?.boundaries).toEqual(contract.sdk_default_bucket_boundaries);
    } finally {
      await meter.shutdown();
    }
  });
});
