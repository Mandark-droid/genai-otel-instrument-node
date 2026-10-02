/**
 * Span-emission contract: the spans the Python BaseInstrumentor wrapper
 * produced for a set of scenarios (contract/semconv.json, `span_emission`).
 *
 * Each scenario is reproduced here through this SDK's BaseInstrumentor with the
 * same model, usage and opt-in. The attribute SET and VALUES must match: a cost
 * attribute that is absent in the vector must be absent here.
 */
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import metricsContract from '../../contract/metrics.json';
import contract from '../../contract/semconv.json';
import { loadConfig, type OTelConfig } from '../../src/config';
import { BaseInstrumentor, type UsageDict } from '../../src/instrumentors/base';
import { setLogger } from '../../src/logger';
import { metricViews, resetSharedMetrics } from '../../src/metrics';
import { resetPricingMissingCounter } from '../../src/cost/pricing-missing';
import { installTestMeterProvider, type TestMeter } from '../helpers/metrics';

interface Scenario {
  scenario: string;
  semconv_stability_opt_in: string;
  call_type: string;
  model: string;
  usage: UsageDict | null;
  request_kwargs: Record<string, unknown>;
  enable_cost_tracking: boolean;
  span_name: string;
  status_code: 'OK' | 'ERROR' | 'UNSET';
  status_description: string | null;
  attributes: Attributes;
  event_names: string[];
}

interface ProviderResult {
  id: string;
  model: string;
  usage: UsageDict | null;
  finish_reason: string;
}

/** The same minimal instrumentor the contract generator drives on the Python side. */
class ContractInstrumentor extends BaseInstrumentor {
  instrument(config: OTelConfig): void {
    this.setupConfig(config);
    this.instrumented = true;
  }

  uninstrument(): void {
    this.instrumented = false;
  }

  protected override extractUsage(result: unknown): UsageDict | null {
    return (result as ProviderResult).usage ?? null;
  }

  protected override extractResponseAttributes(result: unknown): Record<string, unknown> {
    const response = result as ProviderResult;
    return { 'gen_ai.response.id': response.id, 'gen_ai.response.model': response.model };
  }

  protected override extractFinishReason(result: unknown): string | null {
    return (result as ProviderResult).finish_reason ?? null;
  }

  wrap<F extends (...args: never[]) => unknown>(
    spanName: string,
    extract: (instance: unknown, args: unknown[], params: Record<string, unknown>) => Record<string, unknown>,
    original: F,
  ): F {
    return this.createSpanWrapper(spanName, extract)(original);
  }

  aliases(attributes: Record<string, unknown>): Record<string, unknown> {
    return this.withProviderAliases(attributes);
  }

  embeddingRequestAttributes(attributes: Record<string, unknown>, dimensions: unknown, encodingFormat: unknown): void {
    this.addEmbeddingRequestAttributes(attributes, dimensions, encodingFormat);
  }
}

const STATUS = { OK: SpanStatusCode.OK, ERROR: SpanStatusCode.ERROR, UNSET: SpanStatusCode.UNSET } as const;
const scenarios = contract.span_emission as unknown as Scenario[];

describe('span emission', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let meter: TestMeter;

  beforeAll(() => {
    setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.disable();
    trace.setGlobalTracerProvider(provider);
    meter = installTestMeterProvider(metricViews());
    resetSharedMetrics();
    resetPricingMissingCounter();
  });

  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
    await meter.shutdown();
    resetSharedMetrics();
    resetPricingMissingCounter();
    setLogger(undefined);
  });

  beforeEach(() => exporter.reset());
  afterEach(() => exporter.reset());

  function run(scenario: Scenario): void {
    const config = loadConfig(
      {
        semconvStabilityOptIn: scenario.semconv_stability_opt_in,
        enableCostTracking: scenario.enable_cost_tracking,
        metricsProfile: 'full',
      },
      {},
    );
    const instrumentor = new ContractInstrumentor();
    instrumentor.instrument(config);

    const extract = (_instance: unknown, _args: unknown[], params: Record<string, unknown>): Record<string, unknown> => {
      const attributes: Record<string, unknown> = {
        'gen_ai.system': 'contract-provider',
        'gen_ai.request.model': params.model,
        'gen_ai.operation.name': scenario.call_type,
        'gen_ai.request.type': scenario.call_type,
      };
      if (scenario.scenario.startsWith('embedding')) instrumentor.embeddingRequestAttributes(attributes, 256, 'float');
      return attributes;
    };
    const providerCall = (params: Record<string, unknown>): ProviderResult => {
      if (scenario.scenario === 'chat_wrapped_call_raises') {
        const error = new Error('contract: provider timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      return { id: 'resp-contract-1', model: String(params.model), usage: scenario.usage, finish_reason: 'stop' };
    };
    const wrapped = instrumentor.wrap('contract.operation', extract, providerCall);
    try {
      wrapped({ ...scenario.request_kwargs });
    } catch (error) {
      if (scenario.status_code !== 'ERROR') throw error;
    }
  }

  it.each(scenarios.map((scenario) => [scenario.scenario, scenario] as const))('%s', (_name, scenario) => {
    run(scenario);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.name).toBe(scenario.span_name);
    expect(span?.status.code).toBe(STATUS[scenario.status_code]);
    expect(span?.status.message ?? null).toBe(scenario.status_description);
    expect(span?.events.map((event) => event.name)).toEqual(scenario.event_names);

    const actual = span?.attributes ?? {};
    expect(Object.keys(actual).sort()).toEqual(Object.keys(scenario.attributes).sort());
    expect(actual).toEqual(scenario.attributes);
  });

  it('metric data points carry the attribute keys the reference implementation was observed to use', async () => {
    for (const scenario of scenarios) run(scenario);
    const collected = await meter.collect();
    const observed = (metricsContract.metrics as { name: string; meter: string; attribute_keys_observed: string[] | null }[]).filter(
      (metric) => metric.meter === 'genai_otel.instrumentors.base' && metric.attribute_keys_observed !== null,
    );
    expect(observed.length).toBeGreaterThan(10);
    for (const expected of observed) {
      const metric = collected.find((candidate) => candidate.name === expected.name);
      expect(metric, `${expected.name} recorded nothing`).toBeDefined();
      const keys = new Set<string>();
      for (const point of metric?.points ?? []) for (const key of Object.keys(point.attributes)) keys.add(key);
      expect([...keys].sort(), expected.name).toEqual(expected.attribute_keys_observed);
    }
  });

  it.each(
    contract.provider_name_alias_probes.map(
      (probe) => [`${probe.instrumentor_sets} under ${probe.semconv_stability_opt_in}`, probe] as const,
    ),
  )('provider name aliasing: %s', (_label, probe) => {
    const instrumentor = new ContractInstrumentor();
    instrumentor.instrument(loadConfig({ semconvStabilityOptIn: probe.semconv_stability_opt_in }, {}));
    const result = instrumentor.aliases({ [probe.instrumentor_sets]: 'contract-provider' });
    expect(Object.keys(result).sort()).toEqual(probe.span_receives);
  });
});
