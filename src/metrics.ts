/**
 * Metric instruments and histogram views.
 *
 * Names, units, kinds, descriptions and bucket boundaries come from
 * `metrics.generated.ts`, which is generated from the vendored contract - that
 * is, from what the Python library's own meter setup was observed to create.
 * Nothing about an instrument is typed by hand here except which ones this SDK
 * uses.
 *
 * The shared instruments are those of the Python `BaseInstrumentor`
 * (`_ensure_shared_metrics_created`): created once and used by every
 * instrumentor, under the same instrumentation scope name.
 */
import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import { AggregationType, type ViewOptions } from '@opentelemetry/sdk-metrics';
import { PRICING_MISSING_METRIC } from './cost/pricing-missing';
import { logger } from './logger';
import { METRIC_DEFINITIONS, type MetricDefinition, type MetricName } from './metrics.generated';
import { clearStateSlot, stateSlot } from './state';

export { METRIC_DEFINITIONS, SDK_DEFAULT_BUCKET_BOUNDARIES } from './metrics.generated';
export type { MetricDefinition, MetricKind, MetricName } from './metrics.generated';

/** Instrumentation scope of the GenAI client metrics (the Python module that creates them). */
export const BASE_METER_NAME = 'genai_otel.instrumentors.base';

/** Metrics this SDK emits that the reference implementation does not. */
export const NODE_ONLY_METRICS: readonly string[] = Object.freeze([PRICING_MISSING_METRIC]);

const COUNTERS = {
  /** Number of GenAI requests. */
  requests: 'gen_ai.requests',
  /** Token usage, by `token_type`. */
  tokens: 'gen_ai.client.token.usage',
  /** Total cost. */
  cost: 'gen_ai.usage.cost',
  costPrompt: 'gen_ai.usage.cost.prompt',
  costCompletion: 'gen_ai.usage.cost.completion',
  costReasoning: 'gen_ai.usage.cost.reasoning',
  costCacheRead: 'gen_ai.usage.cost.cache_read',
  costCacheWrite: 'gen_ai.usage.cost.cache_write',
  errors: 'gen_ai.client.errors',
  requestFinish: 'gen_ai.server.request.finish',
  requestSuccess: 'gen_ai.server.request.success',
  requestFailure: 'gen_ai.server.request.failure',
} as const satisfies Record<string, MetricName>;

const HISTOGRAMS = {
  /** Client operation duration, seconds. */
  latency: 'gen_ai.client.operation.duration',
  tokenBudgetUtilization: 'gen_ai.invoke_agent.token_budget.utilization',
  /** Time to first token, under this library's older abbreviation. */
  ttft: 'gen_ai.server.ttft',
  /** Time between tokens. */
  tbt: 'gen_ai.server.tbt',
  /** Time to first token, under the upstream name. */
  timeToFirstToken: 'gen_ai.server.time_to_first_token',
  timePerOutputToken: 'gen_ai.server.time_per_output_token',
  promptTokens: 'gen_ai.client.token.usage.prompt',
  completionTokens: 'gen_ai.client.token.usage.completion',
} as const satisfies Record<string, MetricName>;

export const SHARED_METRIC_NAMES: readonly MetricName[] = Object.freeze([
  ...Object.values(COUNTERS),
  ...Object.values(HISTOGRAMS),
]);

export interface SharedMetrics {
  readonly counters: { readonly [K in keyof typeof COUNTERS]: Counter };
  readonly histograms: { readonly [K in keyof typeof HISTOGRAMS]: Histogram };
}

const SLOT = 'sharedMetrics';

function options(definition: MetricDefinition): { description: string; unit?: string } {
  return definition.unit ? { description: definition.description, unit: definition.unit } : { description: definition.description };
}

/** Create one contract instrument on a meter. The definition decides the kind. */
export function createCounter(meter: Meter, name: MetricName): Counter {
  const definition: MetricDefinition = METRIC_DEFINITIONS[name];
  if (definition.kind !== 'counter') throw new Error(`${name} is a ${definition.kind}, not a counter`);
  return meter.createCounter(definition.name, options(definition));
}

export function createHistogram(meter: Meter, name: MetricName): Histogram {
  const definition: MetricDefinition = METRIC_DEFINITIONS[name];
  if (definition.kind !== 'histogram') throw new Error(`${name} is a ${definition.kind}, not a histogram`);
  return meter.createHistogram(definition.name, options(definition));
}

function build(): SharedMetrics {
  const meter = metrics.getMeter(BASE_METER_NAME);
  const counters = {} as { -readonly [K in keyof typeof COUNTERS]: Counter };
  for (const key of Object.keys(COUNTERS) as (keyof typeof COUNTERS)[]) counters[key] = createCounter(meter, COUNTERS[key]);
  const histograms = {} as { -readonly [K in keyof typeof HISTOGRAMS]: Histogram };
  for (const key of Object.keys(HISTOGRAMS) as (keyof typeof HISTOGRAMS)[]) {
    histograms[key] = createHistogram(meter, HISTOGRAMS[key]);
  }
  logger.debug('Shared metrics created successfully');
  return { counters, histograms };
}

/**
 * The shared GenAI client instruments, created on first use against the
 * current global meter provider.
 */
export function getSharedMetrics(): SharedMetrics {
  return stateSlot(SLOT, build);
}

/**
 * Forget the instruments, so the next use binds to the current meter provider.
 * An instrument stays bound to the provider that created it; this is called
 * whenever the global provider is replaced.
 */
export function resetSharedMetrics(): void {
  clearStateSlot(SLOT);
}

/**
 * Explicit-bucket views for every histogram whose boundaries the reference
 * implementation sets through a View - all of them, whichever meter owns the
 * instrument, exactly as its `_setup_meter_provider` registers them.
 */
export function metricViews(): ViewOptions[] {
  const views: ViewOptions[] = [];
  for (const definition of Object.values(METRIC_DEFINITIONS) as MetricDefinition[]) {
    if (definition.bucketSource !== 'view' || definition.bucketBoundaries === null) continue;
    views.push({
      instrumentName: definition.name,
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: [...definition.bucketBoundaries] },
      },
    });
  }
  return views;
}
