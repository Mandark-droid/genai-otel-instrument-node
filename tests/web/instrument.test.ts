/**
 * The browser and React Native entries: explicit configuration, OTLP over
 * fetch, no default endpoint, the manual-span helper. Runs in the Node test
 * project and in the browser-like one.
 */
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as browserEntry from '../../src/index.browser';
import * as reactNativeEntry from '../../src/index.react-native';
import { getDefaultCostCalculator } from '../../src/cost';
import { setLogger } from '../../src/logger';
import { VERSION } from '../../src/version';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(status = 200): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const impl = async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
    const text = typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as Uint8Array);
    sent.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(text) as Record<string, unknown> });
    return { ok: status >= 200 && status < 300, status } as Response;
  };
  return { fetch: impl as unknown as typeof fetch, sent };
}

type Any = Record<string, any>;
const spansOf = (sent: Sent[]): Any[] =>
  sent
    .filter((request) => request.url.endsWith('/v1/traces'))
    .flatMap((request) => (request.body.resourceSpans as Any[]).flatMap((rs) => rs.scopeSpans.flatMap((ss: Any) => ss.spans)));
const resourceOf = (sent: Sent[]): Record<string, unknown> => {
  const first = sent.find((request) => request.url.endsWith('/v1/traces'));
  const attributes = ((first?.body.resourceSpans as Any[] | undefined)?.[0]?.resource.attributes as Any[] | undefined) ?? [];
  return Object.fromEntries(attributes.map((entry) => [entry.key, entry.value.stringValue ?? entry.value.intValue ?? entry.value]));
};
const attrs = (span: Any): Record<string, unknown> =>
  Object.fromEntries(
    (span.attributes as Any[]).map((entry) => {
      const value = entry.value;
      if ('stringValue' in value) return [entry.key, value.stringValue];
      if ('intValue' in value) return [entry.key, Number(value.intValue)];
      if ('doubleValue' in value) return [entry.key, value.doubleValue];
      if ('boolValue' in value) return [entry.key, value.boolValue];
      return [entry.key, value];
    }),
  );

function quiet(): { warn: string[]; error: string[] } {
  const logs = { warn: [] as string[], error: [] as string[] };
  setLogger({ debug: () => {}, info: () => {}, warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)) });
  return logs;
}

describe.each([
  ['browser', browserEntry],
  ['react-native', reactNativeEntry],
] as const)('%s entry', (_name, sdk) => {
  afterEach(async () => {
    await sdk.uninstrument(0.2);
    trace.disable();
    metrics.disable();
    setLogger(undefined);
  });

  it('exports the runtime-agnostic core', () => {
    for (const name of [
      'instrument',
      'uninstrument',
      'flushTelemetry',
      'traceGenAiCall',
      'loadConfig',
      'CostCalculator',
      'getDefaultCostCalculator',
      'genaiSemconvModes',
      'SemanticConvention',
      'ATTR',
      'METRIC_DEFINITIONS',
      'getSharedMetrics',
      'BaseInstrumentor',
      'VERSION',
    ]) {
      expect(sdk[name as keyof typeof sdk], name).toBeDefined();
    }
    // Module patching and the zero-code hook are Node-only.
    expect('OpenAIInstrumentor' in sdk).toBe(false);
    expect('buildResource' in sdk).toBe(false);
  });

  it('refuses to start without an explicit endpoint: nothing leaves the device unless told where', () => {
    const logs = quiet();
    const { fetch, sent } = fakeFetch();
    expect(sdk.instrument({ serviceName: 'web-app', fetch })).toBeUndefined();
    expect(logs.error.join('\n')).toContain('endpoint');
    expect(sent).toEqual([]);
    expect(() => sdk.instrument({ serviceName: 'web-app', fetch, failOnError: true })).toThrow(/endpoint/);
  });

  it('takes configuration under the environment-variable names, parsed as the environment is', () => {
    quiet();
    const { fetch } = fakeFetch();
    const handle = sdk.instrument({
      OTEL_SERVICE_NAME: 'web-app',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp',
      GENAI_ENABLE_COST_TRACKING: 'false',
      GENAI_CONTENT_MAX_LENGTH: '50',
      OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai',
      fetch,
    });
    expect(handle?.config).toMatchObject({
      serviceName: 'web-app',
      endpoint: 'https://collector.example/otlp',
      enableCostTracking: false,
      contentMaxLength: 50,
      semconvStabilityOptIn: 'gen_ai',
      enableContentCapture: false,
    });
  });

  it('an explicit option beats the same setting given under its environment name', () => {
    quiet();
    const handle = sdk.instrument({ OTEL_SERVICE_NAME: 'from-env-name', serviceName: 'from-option', endpoint: 'https://c.example', fetch: fakeFetch().fetch });
    expect(handle?.config.serviceName).toBe('from-option');
  });

  it('garbage configuration is logged and leaves the app uninstrumented', () => {
    const logs = quiet();
    expect(sdk.instrument({ endpoint: 'https://c.example', GENAI_SAMPLING_RATE: 'abc', fetch: fakeFetch().fetch })).toBeUndefined();
    expect(logs.error.join('\n')).toContain('GENAI_SAMPLING_RATE');
  });

  it('traces a manual GenAI call and exports it as OTLP/HTTP JSON over fetch, with identity, tokens and cost', async () => {
    quiet();
    const { fetch, sent } = fakeFetch();
    sdk.instrument({ serviceName: 'web-app', endpoint: 'https://collector.example/', headers: { 'x-tenant': 't1' }, fetch });

    const answer = await sdk.traceGenAiCall(
      { name: 'transformers.generate', system: 'transformers.js', model: 'gpt-4o-mini', attributes: { 'gen_ai.request.device': 'webgpu' } },
      async () => ({ text: 'Paris', usage: { prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 }, finish_reason: 'stop' }),
    );
    expect(answer.text).toBe('Paris');
    expect(await sdk.flushTelemetry(2)).toBe(true);

    const traces = sent.filter((request) => request.url === 'https://collector.example/v1/traces');
    expect(traces).toHaveLength(1);
    expect(traces[0]?.headers).toMatchObject({ 'content-type': 'application/json', 'x-tenant': 't1' });

    const resource = resourceOf(sent);
    expect(resource['service.name']).toBe('web-app');
    expect(resource['telemetry.distro.name']).toBe('genai-otel-instrument-node');
    expect(resource['telemetry.distro.version']).toBe(VERSION);
    expect(typeof resource['telemetry.sdk.language']).toBe('string');
    expect(String(resource['service.instance.id'])).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing about the host or the process leaves a browser or a phone.
    expect(Object.keys(resource).filter((key) => /^(host|process|os)\./.test(key))).toEqual([]);

    const [span] = spansOf(sent);
    expect(span?.name).toBe('transformers.generate');
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(attrs(span as Any)).toMatchObject({
      'gen_ai.system': 'transformers.js',
      'gen_ai.provider.name': 'transformers.js',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.device': 'webgpu',
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.total_tokens': 28,
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat'),
      'gen_ai.usage.cost.pricing_source': 'table',
      'gen_ai.response.finish_reason': 'stop',
    });

    const metricNames = sent
      .filter((request) => request.url === 'https://collector.example/v1/metrics')
      .flatMap((request) => (request.body.resourceMetrics as Any[]).flatMap((rm) => rm.scopeMetrics.flatMap((sm: Any) => sm.metrics.map((m: Any) => m.name))));
    expect(metricNames).toEqual(expect.arrayContaining(['gen_ai.requests', 'gen_ai.client.token.usage', 'gen_ai.usage.cost']));
  });

  it('an on-device model with a size in its name is priced by the size tier; one without has no cost at all', async () => {
    quiet();
    const { fetch, sent } = fakeFetch();
    sdk.instrument({ serviceName: 'web-app', endpoint: 'https://c.example', fetch });
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    sdk.traceGenAiCall({ name: 'local.generate', system: 'transformers.js', model: 'onnx-community/Qwen2.5-0.5B-Instruct' }, () => ({ usage }));
    sdk.traceGenAiCall({ name: 'local.generate', system: 'transformers.js', model: 'acme-on-device-model' }, () => ({ usage }));
    await sdk.flushTelemetry(2);
    const [sized, unsized] = spansOf(sent).map((span) => attrs(span));
    expect(sized?.['gen_ai.usage.cost.pricing_source']).toBe('estimated');
    expect(sized?.['gen_ai.usage.cost.total']).toBeGreaterThan(0);
    expect(unsized?.['gen_ai.usage.cost.pricing_source']).toBe('unpriced');
    expect('gen_ai.usage.cost.total' in (unsized ?? {})).toBe(false);
  });

  it('a manual call that throws ends its span with ERROR status and rethrows', async () => {
    quiet();
    const { fetch, sent } = fakeFetch();
    sdk.instrument({ serviceName: 'web-app', endpoint: 'https://c.example', fetch });
    await expect(
      sdk.traceGenAiCall({ name: 'local.generate', system: 'transformers.js', model: 'm' }, async () => {
        throw new Error('out of memory');
      }),
    ).rejects.toThrow('out of memory');
    await sdk.flushTelemetry(2);
    const [span] = spansOf(sent);
    expect(span?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'out of memory' });
  });

  it('traceGenAiCall works before instrument(): the function runs, nothing is exported', () => {
    expect(sdk.traceGenAiCall({ name: 'x', system: 's', model: 'm' }, () => 42)).toBe(42);
  });

  it('a collector that rejects or is unreachable never reaches the app; flush reports false', async () => {
    quiet();
    const rejecting = fakeFetch(503);
    sdk.instrument({ serviceName: 'web-app', endpoint: 'https://c.example', fetch: rejecting.fetch });
    expect(() => sdk.traceGenAiCall({ name: 'x', system: 's', model: 'm' }, () => ({}))).not.toThrow();
    expect(await sdk.flushTelemetry(2)).toBe(false);
    await sdk.uninstrument(0.2);

    const throwing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    sdk.instrument({ serviceName: 'web-app', endpoint: 'https://c.example', fetch: throwing });
    sdk.traceGenAiCall({ name: 'x', system: 's', model: 'm' }, () => ({}));
    expect(await sdk.flushTelemetry(2)).toBe(false);
    expect(throwing).toHaveBeenCalled();
  });

  it('a second instrument() returns the first handle; after uninstrument() it can start again', async () => {
    const logs = quiet();
    const first = sdk.instrument({ endpoint: 'https://c.example', fetch: fakeFetch().fetch });
    expect(sdk.instrument({ endpoint: 'https://c.example', fetch: fakeFetch().fetch })).toBe(first);
    expect(logs.warn.join('\n')).toContain('already initialized');
    await sdk.uninstrument(0.2);
    expect(sdk.instrument({ endpoint: 'https://c.example', fetch: fakeFetch().fetch })).not.toBe(first);
  });

  it('flushTelemetry and uninstrument are safe when nothing was instrumented', async () => {
    await expect(sdk.flushTelemetry(1)).resolves.toBe(true);
    await expect(sdk.uninstrument()).resolves.toBeUndefined();
  });
});

describe('react-native entry', () => {
  afterEach(async () => {
    await reactNativeEntry.uninstrument(0.2);
    trace.disable();
    metrics.disable();
    setLogger(undefined);
  });

  it('flushes when the app goes to the background, and stops listening on uninstrument', async () => {
    quiet();
    const { fetch, sent } = fakeFetch();
    const remove = vi.fn();
    let listener: ((state: string) => void) | undefined;
    const appState = {
      addEventListener: vi.fn((_event: 'change', handler: (state: string) => void) => {
        listener = handler;
        return { remove };
      }),
    };
    reactNativeEntry.instrument({ serviceName: 'rn-app', endpoint: 'https://c.example', fetch, appState });
    reactNativeEntry.traceGenAiCall({ name: 'cactus.completion', system: 'cactus', model: 'm' }, () => ({}));
    expect(sent).toEqual([]);

    listener?.('active');
    await new Promise((done) => setTimeout(done, 20));
    expect(sent).toEqual([]);

    listener?.('background');
    await vi.waitFor(() => expect(spansOf(sent).map((span) => span.name)).toEqual(['cactus.completion']));

    await reactNativeEntry.uninstrument(0.2);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
