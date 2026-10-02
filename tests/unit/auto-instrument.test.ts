import { metrics, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exporterTimeoutMillis,
  flushTelemetry,
  instrument,
  isInstrumented,
  resolveOtlpProtocol,
  uninstrument,
} from '../../src/auto-instrument';
import { ConfigError } from '../../src/config';
import { setLogger } from '../../src/logger';
import { VERSION } from '../../src/version';
import { closedPort, startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';

const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_SERVICE_NAME',
  'GENAI_SAMPLING_RATE',
  'GENAI_FAIL_ON_ERROR',
  'GENAI_SKIP_COLLECTOR_CHECK',
  'GENAI_ENABLED_INSTRUMENTORS',
  'OTEL_EXPERIMENTAL_RESOURCE_DETECTORS',
];

function quietLogger() {
  const spies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  setLogger(spies);
  return spies;
}

describe('instrument()', () => {
  const saved: Record<string, string | undefined> = {};
  let receiver: OtlpReceiver | undefined;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GENAI_SKIP_COLLECTOR_CHECK = 'true';
  });

  afterEach(async () => {
    await uninstrument(0.5);
    await receiver?.close();
    receiver = undefined;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setLogger(undefined);
  });

  it('with the collector unreachable: returns at once, and the host path neither blocks nor throws', async () => {
    quietLogger();
    const port = await closedPort();

    const started = Date.now();
    const handle = instrument({ serviceName: 'unreachable', endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [] });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(handle).toBeDefined();
    expect(isInstrumented()).toBe(true);

    // The "request path" of a host application: spans and measurements, many of them.
    const tracer = trace.getTracer('host-app');
    const counter = metrics.getMeter('host-app').createCounter('host.work');
    const work = Date.now();
    for (let i = 0; i < 2000; i += 1) {
      const span = tracer.startSpan(`work-${i}`);
      counter.add(1);
      span.end();
    }
    expect(Date.now() - work).toBeLessThan(1000);

    // Draining against a dead collector is bounded and reports failure rather than throwing.
    const flushStarted = Date.now();
    const flushed = await flushTelemetry(1);
    expect(typeof flushed).toBe('boolean');
    expect(Date.now() - flushStarted).toBeLessThan(5000);

    const shutdownStarted = Date.now();
    await expect(uninstrument()).resolves.toBeUndefined();
    expect(Date.now() - shutdownStarted).toBeLessThan(8000);
    expect(isInstrumented()).toBe(false);
  });

  it('exports spans over OTLP http/protobuf with the identity attributes on the resource', async () => {
    quietLogger();
    receiver = await startOtlpReceiver();
    instrument({ serviceName: 'identity-check', endpoint: receiver.url, enabledInstrumentors: [] });

    trace.getTracer('test').startSpan('hello').end();
    expect(await flushTelemetry(5)).toBe(true);

    const span = receiver.spans.find((candidate) => candidate.name === 'hello');
    expect(span, JSON.stringify(receiver.requests)).toBeDefined();
    expect(span?.resource['service.name']).toBe('identity-check');
    expect(span?.resource['telemetry.sdk.language']).toBe('nodejs');
    expect(span?.resource['telemetry.distro.name']).toBe('genai-otel-instrument-node');
    expect(span?.resource['telemetry.distro.version']).toBe(VERSION);
    expect(typeof span?.resource['service.instance.id']).toBe('string');
    const traces = receiver.requests.find((request) => request.path === '/v1/traces');
    expect(traces?.contentType).toBe('application/x-protobuf');
  });

  it('exports metrics to /v1/metrics on flush', async () => {
    quietLogger();
    receiver = await startOtlpReceiver();
    instrument({ serviceName: 'metrics-check', endpoint: receiver.url, enabledInstrumentors: [] });
    metrics.getMeter('test').createCounter('test.counter', { unit: '1' }).add(3);
    expect(await flushTelemetry(5)).toBe(true);
    expect(receiver.metrics.map((metric) => metric.name)).toContain('test.counter');
  });

  it('exports the endpoint for the exporters and leaves the timeout in seconds out of the environment', async () => {
    quietLogger();
    const port = await closedPort();
    instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [] });
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${port}`);
    // The specification reads this variable as milliseconds; ours is seconds (Python). It is passed explicitly.
    expect(process.env.OTEL_EXPORTER_OTLP_TIMEOUT).toBeUndefined();
  });

  it('accepts extra span processors', async () => {
    quietLogger();
    const memory = new InMemorySpanExporter();
    const port = await closedPort();
    instrument({
      endpoint: `http://127.0.0.1:${port}`,
      enabledInstrumentors: [],
      spanProcessors: [new SimpleSpanProcessor(memory)],
    });
    trace.getTracer('test').startSpan('captured').end();
    // Synchronous: the resource carries no attribute that resolves later.
    expect(memory.getFinishedSpans().map((span) => span.name)).toEqual(['captured']);
    expect(memory.getFinishedSpans()[0]?.resource.attributes['telemetry.sdk.language']).toBe('nodejs');
  });

  it('a second call warns and does not initialise again', async () => {
    const log = quietLogger();
    const port = await closedPort();
    const first = instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [] });
    const second = instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [] });
    expect(second).toBe(first);
    expect(log.warn.mock.calls.some(([message]) => String(message).includes('already initialized'))).toBe(true);
  });

  it('can be instrumented again after uninstrument()', async () => {
    quietLogger();
    const port = await closedPort();
    const first = instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [] });
    await uninstrument();
    const second = instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [] });
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('GENAI_SAMPLING_RATE below 1 samples by trace id ratio', async () => {
    quietLogger();
    const memory = new InMemorySpanExporter();
    const port = await closedPort();
    instrument({
      endpoint: `http://127.0.0.1:${port}`,
      samplingRate: 0,
      enabledInstrumentors: [],
      spanProcessors: [new SimpleSpanProcessor(memory)],
    });
    const span = trace.getTracer('test').startSpan('dropped');
    expect(span.isRecording()).toBe(false);
    span.end();
    expect(memory.getFinishedSpans()).toHaveLength(0);
  });

  it('an empty endpoint selects the console exporters', async () => {
    quietLogger();
    const handle = instrument({ endpoint: '', enabledInstrumentors: [] });
    expect(handle?.exporter).toBe('console');
    expect(handle?.config.endpoint).toBe('');
  });

  it('garbage configuration: logs the reason and leaves the application uninstrumented, without throwing', () => {
    const log = quietLogger();
    process.env.GENAI_SAMPLING_RATE = 'abc';
    let handle: unknown = 'unset';
    expect(() => {
      handle = instrument({ enabledInstrumentors: [] });
    }).not.toThrow();
    expect(handle).toBeUndefined();
    expect(isInstrumented()).toBe(false);
    expect(log.error.mock.calls.some(([message]) => String(message).includes('GENAI_SAMPLING_RATE'))).toBe(true);
  });

  it('garbage configuration with GENAI_FAIL_ON_ERROR=true throws, as the Python library does', () => {
    quietLogger();
    process.env.GENAI_SAMPLING_RATE = 'abc';
    process.env.GENAI_FAIL_ON_ERROR = 'true';
    expect(() => instrument({ enabledInstrumentors: [] })).toThrow(ConfigError);
    expect(isInstrumented()).toBe(false);
  });

  it('says so when a setting cannot be honoured yet, instead of ignoring it', async () => {
    const log = quietLogger();
    const port = await closedPort();
    instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: [], enablePiiDetection: true });
    const warned = log.warn.mock.calls.map(([message]) => String(message)).join('\n');
    expect(warned).toContain('GENAI_ENABLE_PII_DETECTION');
  });

  it('an instrumentor name it does not know is reported', async () => {
    const log = quietLogger();
    const port = await closedPort();
    instrument({ endpoint: `http://127.0.0.1:${port}`, enabledInstrumentors: ['no-such-library', 'cohere'] });
    const warned = log.warn.mock.calls.map(([message]) => String(message)).join('\n');
    expect(warned).toContain("Unknown instrumentor 'no-such-library'");
    // Known to the reference implementation, not ported yet: named, not called unknown.
    expect(warned).toContain("'cohere'");
    expect(warned).not.toContain("Unknown instrumentor 'cohere'");
  });

  it('the default instrumentor list does not warn about names that are not ported yet', async () => {
    const log = quietLogger();
    const port = await closedPort();
    instrument({ endpoint: `http://127.0.0.1:${port}` });
    const warned = log.warn.mock.calls.map(([message]) => String(message)).join('\n');
    expect(warned).not.toContain('cohere');
    expect(warned).not.toContain('Unknown instrumentor');
  });

  it('flushTelemetry and uninstrument are safe when nothing was instrumented', async () => {
    await expect(flushTelemetry(1)).resolves.toBe(true);
    await expect(uninstrument()).resolves.toBeUndefined();
  });
});

describe('resolveOtlpProtocol', () => {
  it('OTEL_EXPORTER_OTLP_PROTOCOL wins, lowercased', () => {
    expect(resolveOtlpProtocol('http://c:4318', { OTEL_EXPORTER_OTLP_PROTOCOL: 'GRPC' })).toBe('grpc');
    expect(resolveOtlpProtocol('http://c:4317', { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' })).toBe('http');
  });

  it('falls back to the port: 4317 is gRPC, anything else HTTP', () => {
    expect(resolveOtlpProtocol('http://collector:4317', {})).toBe('grpc');
    expect(resolveOtlpProtocol('http://collector:4318', {})).toBe('http');
    expect(resolveOtlpProtocol('https://collector/otlp', {})).toBe('http');
    expect(resolveOtlpProtocol('not a url', {})).toBe('http');
  });
});

describe('exporterTimeoutMillis', () => {
  it('reads the configured timeout as seconds', () => {
    expect(exporterTimeoutMillis(60)).toBe(60000);
    expect(exporterTimeoutMillis(1)).toBe(1000);
  });
});
