import { metrics } from '@opentelemetry/api';
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type MetricData,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';

/** A reader collected on demand, for tests. */
export class ManualMetricReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

export interface CollectedPoint {
  attributes: Record<string, unknown>;
  /** Sum / gauge value, or the histogram's sum. */
  value: number;
  /** Histograms only. */
  count?: number;
  boundaries?: number[];
}

export interface CollectedMetric {
  name: string;
  unit: string;
  description: string;
  kind: 'sum' | 'gauge' | 'histogram' | 'exponential_histogram';
  monotonic?: boolean;
  scope: string;
  points: CollectedPoint[];
}

function describeMetric(metric: MetricData, scope: string): CollectedMetric {
  const base = {
    name: metric.descriptor.name,
    unit: metric.descriptor.unit,
    description: metric.descriptor.description,
    scope,
  };
  if (metric.dataPointType === DataPointType.HISTOGRAM) {
    return {
      ...base,
      kind: 'histogram',
      points: metric.dataPoints.map((point) => ({
        attributes: { ...point.attributes },
        value: point.value.sum ?? 0,
        count: point.value.count,
        boundaries: [...point.value.buckets.boundaries],
      })),
    };
  }
  if (metric.dataPointType === DataPointType.SUM) {
    return {
      ...base,
      kind: 'sum',
      monotonic: metric.isMonotonic,
      points: metric.dataPoints.map((point) => ({ attributes: { ...point.attributes }, value: point.value })),
    };
  }
  if (metric.dataPointType === DataPointType.GAUGE) {
    return {
      ...base,
      kind: 'gauge',
      points: metric.dataPoints.map((point) => ({ attributes: { ...point.attributes }, value: point.value })),
    };
  }
  return { ...base, kind: 'exponential_histogram', points: [] };
}

export async function collect(reader: MetricReader): Promise<CollectedMetric[]> {
  const { resourceMetrics, errors } = await reader.collect();
  if (errors.length > 0) throw new Error(`metric collection failed: ${errors.map(String).join('; ')}`);
  const out: CollectedMetric[] = [];
  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) out.push(describeMetric(metric, scopeMetrics.scope.name));
  }
  return out;
}

export interface TestMeter {
  reader: ManualMetricReader;
  provider: MeterProvider;
  collect(): Promise<CollectedMetric[]>;
  find(name: string): Promise<CollectedMetric | undefined>;
  shutdown(): Promise<void>;
}

/** Install a global meter provider that a test can read back. */
export function installTestMeterProvider(views: ViewOptions[] = []): TestMeter {
  const reader = new ManualMetricReader();
  const provider = new MeterProvider({ readers: [reader], views });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  return {
    reader,
    provider,
    collect: () => collect(reader),
    find: async (name) => (await collect(reader)).find((metric) => metric.name === name),
    shutdown: async () => {
      metrics.disable();
      await provider.shutdown();
    },
  };
}
