/**
 * Server-side metrics: the collector, its use by instrumented calls, the
 * Ollama poller against a stand-in for `/api/ps`, and the engine latency
 * breakdown.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { llamacppLatencyAttributes, vllmLatencyAttributes } from '../../src/engine-latency';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { getServerMetrics, OllamaServerMetricsPoller, PrometheusServerMetricsPoller } from '../../src/server-metrics';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm } from '../helpers/mock-llm';

let harness: Harness | undefined;
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await harness?.stop();
  harness = undefined;
  clearBaseUrlClaims();
});

const points = async (name: string): Promise<{ attributes: Record<string, unknown>; value: number }[] | undefined> =>
  (await harness?.metric(name))?.points.map((point) => ({ attributes: point.attributes, value: point.value }));

/** A stand-in for an Ollama server: `/api/ps` answers with `body` (which may change between polls). */
async function ollamaServer(body: unknown, status = 200): Promise<{ url: string; hits: () => number; answer: (next: unknown, nextStatus?: number) => void }> {
  let hits = 0;
  let current = body;
  let currentStatus = status;
  const server: Server = createServer((request, response) => {
    if (request.url === '/api/ps') hits += 1;
    response.writeHead(currentStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify(current));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    answer: (next, nextStatus = 200) => {
      current = next;
      currentStatus = nextStatus;
    },
  };
}

/** A stand-in for a vLLM or llama.cpp server: `/metrics` answers with `text`. */
async function metricsServer(text: string, status = 200): Promise<{ url: string; answer: (next: string, nextStatus?: number) => void }> {
  let current = text;
  let currentStatus = status;
  const server: Server = createServer((request, response) => {
    response.writeHead(request.url === '/metrics' ? currentStatus : 404, { 'content-type': 'text/plain; version=0.0.4' });
    response.end(request.url === '/metrics' ? current : '');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    answer: (next, nextStatus = 200) => {
      current = next;
      currentStatus = nextStatus;
    },
  };
}

const capture = (name: string): string => readFileSync(resolve(__dirname, '../fixtures/server-metrics', name), 'utf8');
const ENGINE = { server_metrics_source: 'engine' };
const CLIENT = { server_metrics_source: 'client' };

const GIB = 1024 ** 3;
const TWO_MODELS = {
  models: [
    { name: 'qwen3.5:4b', size: 4 * GIB, size_vram: 3 * GIB, details: { parameter_size: '4B', quantization_level: 'Q4_K_M', format: 'gguf' } },
    { name: 'embeddinggemma:300m', size: GIB, size_vram: 0.5 * GIB },
  ],
};

describe('ServerMetricsCollector', () => {
  it('reports nothing until something was measured; the count of its own calls in flight is measured from the start', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    expect(getServerMetrics()).toBeDefined();
    for (const name of ['gen_ai.server.kv_cache.usage', 'gen_ai.server.requests.waiting', 'gen_ai.server.requests.max', 'gen_ai.server.prefix_cache.queries', 'gen_ai.server.prefix_cache.hits']) {
      expect(await points(name), name).toBeUndefined();
    }
    // SDK_ADDITIONS.md section 12: this SDK's own count is "client", and it knows it is 0.
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: CLIENT, value: 0 }]);
  });

  it('GENAI_ENABLE_CONCURRENCY_METRICS=false: the SDK does not count its own calls', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableConcurrencyMetrics: false });
    expect(await points('gen_ai.server.requests.running')).toBeUndefined();
  });

  it('reports what was set, bounded to its range', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const server = getServerMetrics();
    server?.setKvCacheUsage('model-a', 42.5);
    server?.setKvCacheUsage('model-b', 250);
    server?.setKvCacheUsage('model-c', -3);
    server?.setRequestsRunning(4);
    server?.setRequestsWaiting(-2);
    server?.setRequestsMax(8);
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([
      { attributes: { model: 'model-a' }, value: 42.5 },
      { attributes: { model: 'model-b' }, value: 100 },
      { attributes: { model: 'model-c' }, value: 0 },
    ]);
    // Values the application sets carry no source label (section 12): the platform reads that as unknown.
    expect(await points('gen_ai.server.requests.running')).toEqual([
      { attributes: CLIENT, value: 0 },
      { attributes: {}, value: 4 },
    ]);
    expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: {}, value: 0 }]);
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: {}, value: 8 }]);

    server?.incrementRequestsRunning(2);
    server?.decrementRequestsRunning(10);
    server?.incrementRequestsWaiting();
    server?.incrementRequestsWaiting();
    server?.decrementRequestsWaiting();
    expect(await points('gen_ai.server.requests.running')).toEqual([
      { attributes: CLIENT, value: 0 },
      { attributes: {}, value: 0 },
    ]);
    expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: {}, value: 1 }]);
    expect((await harness.metric('gen_ai.server.kv_cache.usage'))?.unit).toBe('%');
  });

  it('counts the calls in flight through an instrumented client', async () => {
    const llm = await startMockLlm();
    cleanups.push(() => llm.close());
    harness = await startHarness({ enabledInstrumentors: ['openai'] });
    const client = new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
    llm.reply({ fixture: 'openai/chat.completion.json', delayMs: 300 });
    const call = client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    await eventually(() => expect(llm.requests).toHaveLength(1));
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: CLIENT, value: 1 }]);
    await call;
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: CLIENT, value: 0 }]);

    // A failed call is no longer running either.
    llm.reply({ status: 500, json: { error: { message: 'boom' } } });
    await expect(client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: CLIENT, value: 0 }]);
  });
});

describe('Ollama server metrics poller', () => {
  it('reports each loaded model as a share of the known VRAM, and the number of loaded models', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    const poller = new OllamaServerMetricsPoller({ baseUrl: `${ollama.url}/`, maxVramGb: 12 });
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([
      { attributes: { model: 'qwen3.5:4b', ...ENGINE }, value: 25 },
      { attributes: { model: 'embeddinggemma:300m', ...ENGINE }, value: (0.5 / 12) * 100 },
    ]);
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: ENGINE, value: 2 }]);
  });

  it('every poll replaces what the engine reported: an unloaded model disappears, an unreachable engine reports nothing', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    const poller = new OllamaServerMetricsPoller({ baseUrl: ollama.url, maxVramGb: 12 });
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toHaveLength(2);
    ollama.answer({ models: [TWO_MODELS.models[1]] });
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([{ attributes: { model: 'embeddinggemma:300m', ...ENGINE }, value: (0.5 / 12) * 100 }]);
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: ENGINE, value: 1 }]);
    ollama.answer({ models: [] });
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
    expect(await points('gen_ai.server.requests.max')).toBeUndefined();
    ollama.answer(TWO_MODELS);
    await poller.collect();
    ollama.answer({ error: 'down' }, 500);
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
    expect(await points('gen_ai.server.requests.max')).toBeUndefined();
  });

  it('a model larger than the stated VRAM is capped at 100', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, maxVramGb: 2 }).collect();
    expect((await points('gen_ai.server.kv_cache.usage'))?.[0]).toEqual({ attributes: { model: 'qwen3.5:4b', ...ENGINE }, value: 100 });
  });

  it('with the VRAM of the host unknown, no share is reported - the reference assumes 8 GB', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, detectVram: async () => undefined }).collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
    // The count of loaded models needs no VRAM figure.
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: ENGINE, value: 2 }]);
  });

  it('VRAM detected from the host is used when none is configured', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, detectVram: async () => 6 }).collect();
    expect((await points('gen_ai.server.kv_cache.usage'))?.[0]).toEqual({ attributes: { model: 'qwen3.5:4b', ...ENGINE }, value: 50 });
  });

  it('no model loaded: nothing is reported', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer({ models: [] });
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, maxVramGb: 12 }).collect();
    expect(await points('gen_ai.server.requests.max')).toBeUndefined();
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
  });

  it('a server that is down, errors or answers nonsense changes nothing and throws nothing', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const failing = await ollamaServer({ error: 'no' }, 500);
    await expect(new OllamaServerMetricsPoller({ baseUrl: failing.url, maxVramGb: 12 }).collect()).resolves.toBeUndefined();
    const nonsense = await ollamaServer('not an object');
    await expect(new OllamaServerMetricsPoller({ baseUrl: nonsense.url, maxVramGb: 12 }).collect()).resolves.toBeUndefined();
    await expect(new OllamaServerMetricsPoller({ baseUrl: 'http://127.0.0.1:9', maxVramGb: 12 }).collect()).resolves.toBeUndefined();
    expect(await points('gen_ai.server.requests.max')).toBeUndefined();
  });

  it('a URL that is not http(s) is never fetched', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const poller = new OllamaServerMetricsPoller({ baseUrl: 'file:///etc/passwd', maxVramGb: 12 });
    await poller.collect();
    poller.start();
    expect(poller.running).toBe(false);
  });

  it('start polls on the interval until stopped', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    const poller = new OllamaServerMetricsPoller({ baseUrl: ollama.url, intervalSeconds: 0.05, maxVramGb: 12 });
    poller.start();
    poller.start(); // a second start is a no-op
    expect(poller.running).toBe(true);
    await eventually(() => expect(ollama.hits()).toBeGreaterThanOrEqual(3));
    poller.stop();
    const after = ollama.hits();
    await new Promise((done) => setTimeout(done, 200));
    expect(ollama.hits()).toBeLessThanOrEqual(after + 1);
    expect(poller.running).toBe(false);
    poller.stop();
  });
});

describe('vLLM and llama.cpp endpoint poller (GENAI_SERVER_METRICS_ENDPOINTS)', () => {
  it('vLLM (current names, two engines): KV cache per model, waiting summed, prefix cache summed over the engines', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const vllm = await metricsServer(capture('vllm-current.prom'));
    const poller = new PrometheusServerMetricsPoller({ baseUrl: vllm.url });
    await poller.collect();
    expect(poller.engine).toBe('vllm');
    // Fractions as percentages; a model two engines report keeps the larger figure.
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([{ attributes: { model: 'Qwen/Qwen3-0.6B', ...ENGINE }, value: 25 }]);
    expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: ENGINE, value: 7 }]);
    // SDK_ADDITIONS.md section 13: cumulative, summed over the engines; `_created` and the
    // external (KV-connector) prefix cache are other metrics and are not added in.
    expect(await points('gen_ai.server.prefix_cache.queries')).toEqual([{ attributes: { model: 'Qwen/Qwen3-0.6B', ...ENGINE }, value: 20000 }]);
    expect(await points('gen_ai.server.prefix_cache.hits')).toEqual([{ attributes: { model: 'Qwen/Qwen3-0.6B', ...ENGINE }, value: 10000 }]);
    const queries = await harness.metric('gen_ai.server.prefix_cache.queries');
    expect(queries?.unit).toBe('{token}');
    expect(queries?.scope).toBe('genai.server');
    expect(queries?.kind).toBe('gauge');
    // The engine's running count is not this application's calls in flight: not reported.
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: CLIENT, value: 0 }]);
  });

  it('older vLLM (gpu_ names): the same figures', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const vllm = await metricsServer(capture('vllm-0.9.0.prom'));
    await new PrometheusServerMetricsPoller({ baseUrl: vllm.url }).collect();
    const model = { model: 'meta-llama/Llama-3.2-1B-Instruct', ...ENGINE };
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([{ attributes: model, value: 50 }]);
    expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: ENGINE, value: 0 }]);
    expect(await points('gen_ai.server.prefix_cache.queries')).toEqual([{ attributes: model, value: 4096 }]);
    expect(await points('gen_ai.server.prefix_cache.hits')).toEqual([{ attributes: model, value: 1024 }]);
  });

  it('llama.cpp (a real capture): deferred requests as waiting; no KV cache and no prefix cache, because it exports neither', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const llama = await metricsServer(capture('llamacpp-b9151.prom'));
    const poller = new PrometheusServerMetricsPoller({ baseUrl: llama.url });
    await poller.collect();
    expect(poller.engine).toBe('llamacpp');
    expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: ENGINE, value: 0 }]);
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
    expect(await points('gen_ai.server.prefix_cache.queries')).toBeUndefined();
    expect(await points('gen_ai.server.prefix_cache.hits')).toBeUndefined();
  });

  it('a llama.cpp that exports its KV-cache ratio: keyed by the server, since it serves one model', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const llama = await metricsServer('# TYPE llamacpp:kv_cache_usage_ratio gauge\nllamacpp:kv_cache_usage_ratio 0.5\n');
    await new PrometheusServerMetricsPoller({ baseUrl: llama.url }).collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([{ attributes: { model: new URL(llama.url).host, ...ENGINE }, value: 50 }]);
  });

  it('a vLLM without prefix caching: prefix cache absent, never 0; a server that stops answering is forgotten', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const without = capture('vllm-current.prom')
      .split(/\r?\n/)
      .filter((line) => !line.includes('prefix_cache'))
      .join('\n');
    const vllm = await metricsServer(without);
    const poller = new PrometheusServerMetricsPoller({ baseUrl: vllm.url });
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toHaveLength(1);
    expect(await points('gen_ai.server.prefix_cache.queries')).toBeUndefined();
    expect(await points('gen_ai.server.prefix_cache.hits')).toBeUndefined();
    vllm.answer('', 503);
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
    expect(await points('gen_ai.server.requests.waiting')).toBeUndefined();
  });

  it('a URL that is not http(s) is never fetched', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const poller = new PrometheusServerMetricsPoller({ baseUrl: 'file:///etc/passwd' });
    poller.start();
    expect(poller.running).toBe(false);
  });

  it('instrument() polls every endpoint in GENAI_SERVER_METRICS_ENDPOINTS, and stops with uninstrument()', async () => {
    const vllm = await metricsServer(capture('vllm-current.prom'));
    const llama = await metricsServer(capture('llamacpp-b9151.prom'));
    const previous = process.env.GENAI_SERVER_METRICS_ENDPOINTS;
    process.env.GENAI_SERVER_METRICS_ENDPOINTS = ` ${vllm.url} ,${llama.url}/`;
    cleanups.push(() => {
      if (previous === undefined) delete process.env.GENAI_SERVER_METRICS_ENDPOINTS;
      else process.env.GENAI_SERVER_METRICS_ENDPOINTS = previous;
    });
    harness = await startHarness({ enabledInstrumentors: [] });
    // Both engines' waiting counts, summed: 7 (vLLM) + 0 (llama.cpp).
    await vi.waitFor(async () => expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: ENGINE, value: 7 }]));
    await vi.waitFor(async () => expect(await points('gen_ai.server.prefix_cache.hits')).toHaveLength(1));
    await harness.stop();
    harness = undefined;
    expect(getServerMetrics()).toBeUndefined();
  });
});

describe('engine latency', () => {
  it('llama.cpp timings: milliseconds to the latency attributes, in seconds', () => {
    expect(llamacppLatencyAttributes({ prompt_ms: 120, predicted_ms: 880 })).toEqual({
      'gen_ai.latency.time_in_model_prefill': 0.12,
      'gen_ai.latency.time_to_first_token': 0.12,
      'gen_ai.latency.time_in_model_decode': 0.88,
      'gen_ai.latency.time_in_model_inference': 1,
      'gen_ai.latency.e2e': 1,
    });
    expect(llamacppLatencyAttributes({ predicted_ms: 500 })).toEqual({ 'gen_ai.latency.time_in_model_decode': 0.5 });
    expect(llamacppLatencyAttributes({ prompt_ms: -1, predicted_ms: Number.NaN })).toEqual({});
    expect(llamacppLatencyAttributes({ prompt_ms: '120', predicted_ms: true })).toEqual({});
    expect(llamacppLatencyAttributes(undefined)).toEqual({});
    expect(llamacppLatencyAttributes('timings')).toEqual({});
  });

  it('vLLM request metrics: phases from its timestamps; a missing or reversed pair is absent', () => {
    expect(
      vllmLatencyAttributes({
        arrival_time: 100,
        first_scheduled_time: 100.5,
        first_token_time: 101,
        last_token_time: 103,
        finished_time: 103.25,
        time_in_queue: 0.5,
        scheduler_time: 0.01,
        model_execute_time: 2.4,
        model_forward_time: 2300,
      }),
    ).toEqual({
      'gen_ai.latency.time_in_queue': 0.5,
      'gen_ai.latency.time_to_first_token': 1,
      'gen_ai.latency.e2e': 3.25,
      'gen_ai.latency.time_in_model_prefill': 0.5,
      'gen_ai.latency.time_in_model_decode': 2,
      'gen_ai.latency.time_in_model_inference': 2.5,
      'gen_ai.latency.time_in_scheduler': 0.01,
      'gen_ai.latency.time_in_model_execute': 2.4,
      'gen_ai.latency.time_in_model_forward': 2.3,
    });
    expect(vllmLatencyAttributes({ arrival_time: 100, first_token_time: 99, finished_time: Number.POSITIVE_INFINITY })).toEqual({});
    expect(vllmLatencyAttributes(null)).toEqual({});
  });

  it('a response of an OpenAI-compatible llama.cpp server carries its timings onto the span', async () => {
    const llm = await startMockLlm();
    cleanups.push(() => llm.close());
    harness = await startHarness({ enabledInstrumentors: ['openai'] });
    const client = new OpenAI({ apiKey: 'none', baseURL: `${llm.url}/v1`, maxRetries: 0 });
    llm.reply({
      json: {
        id: 'c1',
        object: 'chat.completion',
        model: 'qwen',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Paris.' } }],
        usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
        timings: { prompt_n: 9, prompt_ms: 50, predicted_n: 7, predicted_ms: 150 },
      },
    });
    await client.chat.completions.create({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] });
    expect(harness.span('openai.chat.completion').attributes).toMatchObject({
      'gen_ai.latency.time_in_model_prefill': 0.05,
      'gen_ai.latency.time_in_model_decode': 0.15,
      'gen_ai.latency.e2e': 0.2,
    });
  });
});

describe('the Ollama instrumentor starts the poller', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of ['OLLAMA_BASE_URL', 'GENAI_ENABLE_OLLAMA_SERVER_METRICS', 'GENAI_OLLAMA_METRICS_INTERVAL', 'GENAI_OLLAMA_MAX_VRAM_GB']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('polls OLLAMA_BASE_URL while instrumented, and stops with uninstrument()', async () => {
    const ollama = await ollamaServer(TWO_MODELS);
    process.env.OLLAMA_BASE_URL = ollama.url;
    process.env.GENAI_ENABLE_OLLAMA_SERVER_METRICS = 'true';
    process.env.GENAI_OLLAMA_METRICS_INTERVAL = '0.05';
    process.env.GENAI_OLLAMA_MAX_VRAM_GB = '12';
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    await eventually(() => expect(ollama.hits()).toBeGreaterThanOrEqual(2));
    expect((await points('gen_ai.server.kv_cache.usage'))?.[0]).toEqual({ attributes: { model: 'qwen3.5:4b', ...ENGINE }, value: 25 });
    await harness.stop();
    harness = undefined;
    const after = ollama.hits();
    await new Promise((done) => setTimeout(done, 200));
    expect(ollama.hits()).toBeLessThanOrEqual(after + 1);
  });

  it('GENAI_ENABLE_OLLAMA_SERVER_METRICS=false: no polling', async () => {
    const ollama = await ollamaServer(TWO_MODELS);
    process.env.OLLAMA_BASE_URL = ollama.url;
    process.env.GENAI_ENABLE_OLLAMA_SERVER_METRICS = 'false';
    harness = await startHarness({ enabledInstrumentors: ['ollama'] });
    await new Promise((done) => setTimeout(done, 150));
    expect(ollama.hits()).toBe(0);
  });
});
