import type { Context } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { instrument, instrumentorsReady, uninstrument, type InstrumentOptions } from '../../src/auto-instrument';
import { setLogger } from '../../src/logger';
import { collect, ManualMetricReader, type CollectedMetric } from './metrics';
import { closedPort } from './otlp-receiver';

/** Counts span starts and ends, so a test can prove nothing was left open. */
class OpenSpanTracker implements SpanProcessor {
  private readonly open = new Map<string, string>();

  onStart(span: Span, _parentContext: Context): void {
    this.open.set(span.spanContext().spanId, span.name);
  }

  onEnd(span: ReadableSpan): void {
    this.open.delete(span.spanContext().spanId);
  }

  openSpanNames(): string[] {
    return [...this.open.values()];
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export interface Harness {
  spans(): ReadableSpan[];
  span(name: string): ReadableSpan;
  /** Names of spans that were started and have not ended. */
  openSpans(): string[];
  metrics(): Promise<CollectedMetric[]>;
  metric(name: string): Promise<CollectedMetric | undefined>;
  logs: { warn: string[]; error: string[] };
  reset(): void;
  stop(): Promise<void>;
}

/**
 * Run the real `instrument()` with an in-memory span exporter and a manual
 * metric reader attached, and nothing listening on the OTLP endpoint.
 */
export async function startHarness(options: InstrumentOptions = {}): Promise<Harness> {
  const logs = { warn: [] as string[], error: [] as string[] };
  setLogger({
    debug: () => {},
    info: () => {},
    warn: (message) => logs.warn.push(String(message)),
    error: (message) => logs.error.push(String(message)),
  });
  process.env.GENAI_SKIP_COLLECTOR_CHECK = 'true';

  const exporter = new InMemorySpanExporter();
  const tracker = new OpenSpanTracker();
  const reader = new ManualMetricReader();
  const handle = instrument({
    endpoint: `http://127.0.0.1:${await closedPort()}`,
    serviceName: 'instrumentor-tests',
    ...options,
    spanProcessors: [tracker, new SimpleSpanProcessor(exporter), ...(options.spanProcessors ?? [])],
    metricReaders: [reader, ...(options.metricReaders ?? [])],
  });
  if (!handle) throw new Error(`instrument() failed: ${logs.error.join('; ')}`);
  await instrumentorsReady();

  return {
    spans: () => exporter.getFinishedSpans(),
    span: (name) => {
      const found = exporter.getFinishedSpans().filter((span) => span.name === name);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly one finished span named ${name}, found ${found.length} (finished: ${exporter
            .getFinishedSpans()
            .map((span) => span.name)
            .join(', ')})`,
        );
      }
      return found[0] as ReadableSpan;
    },
    openSpans: () => tracker.openSpanNames(),
    metrics: () => collect(reader),
    metric: async (name) => (await collect(reader)).find((metric) => metric.name === name),
    logs,
    reset: () => exporter.reset(),
    stop: async () => {
      await uninstrument(0.2);
      delete process.env.GENAI_SKIP_COLLECTOR_CHECK;
      setLogger(undefined);
    },
  };
}

/** Wait until `check` stops throwing. */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 5));
    }
  }
}
