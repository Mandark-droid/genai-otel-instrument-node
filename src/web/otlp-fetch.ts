/**
 * OTLP/HTTP JSON exporters over `fetch`, for runtimes that have nothing else:
 * browsers and React Native.
 *
 * An export never throws and never rejects into the application: a failure is
 * reported to the SDK's result callback, counted, and logged at debug level.
 */
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { JsonMetricsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { logger } from '../logger';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array | string; signal?: unknown },
) => Promise<{ ok: boolean; status: number }>;

export interface FetchExporterOptions {
  /** Full URL of the signal endpoint, e.g. `https://collector.example/v1/traces`. */
  url: string;
  fetch: FetchLike;
  headers?: Record<string, string>;
  timeoutMillis: number;
}

/** `https://host/base/` + `v1/traces` -> `https://host/base/v1/traces`. */
export function signalUrl(endpoint: string, signalPath: string): string {
  return `${endpoint.replace(/\/+$/, '')}/${signalPath}`;
}

interface Serializer<T> {
  serializeRequest(request: T): Uint8Array | undefined;
}

class FetchExporter<T> {
  /** Exports that did not reach the collector, or that it refused. */
  failures = 0;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly options: FetchExporterOptions,
    private readonly serializer: Serializer<T>,
    private readonly signal: string,
  ) {}

  send(payload: T, resultCallback: (result: ExportResult) => void): void {
    if (this.stopped) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter is shut down') });
      return;
    }
    const work = this.post(payload).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => {
        this.failures += 1;
        // A warning, not debug: a collector that rejects every export (a missing header, a wrong
        // path) otherwise looks exactly like one that accepts them.
        logger.warn(`OTLP ${this.signal} export failed: ${String(error)}`);
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async post(payload: T): Promise<void> {
    const body = this.serializer.serializeRequest(payload);
    if (!body) throw new Error('nothing to serialize');
    // AbortController is in every browser and in React Native; where a runtime
    // lacks it the request simply has no deadline of its own.
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.options.timeoutMillis) : undefined;
    try {
      const response = await this.options.fetch(this.options.url, {
        method: 'POST',
        headers: { ...this.options.headers, 'content-type': 'application/json' },
        body,
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`collector answered HTTP ${response.status}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.forceFlush();
  }
}

export class FetchSpanExporter implements SpanExporter {
  private readonly exporter: FetchExporter<ReadableSpan[]>;

  constructor(options: FetchExporterOptions) {
    this.exporter = new FetchExporter(options, JsonTraceSerializer, 'trace');
  }

  get failures(): number {
    return this.exporter.failures;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.exporter.send(spans, resultCallback);
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }
}

export class FetchMetricExporter implements PushMetricExporter {
  private readonly exporter: FetchExporter<ResourceMetrics>;

  constructor(options: FetchExporterOptions) {
    this.exporter = new FetchExporter(options, JsonMetricsSerializer, 'metric');
  }

  get failures(): number {
    return this.exporter.failures;
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.exporter.send(metrics, resultCallback);
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }
}
