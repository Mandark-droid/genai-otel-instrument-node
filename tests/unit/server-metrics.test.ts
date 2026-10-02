/**
 * Server-side metrics: the collector, its use by instrumented calls, the
 * Ollama poller against a stand-in for `/api/ps`, and the engine latency
 * breakdown.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { llamacppLatencyAttributes, vllmLatencyAttributes } from '../../src/engine-latency';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { getServerMetrics, OllamaServerMetricsPoller } from '../../src/server-metrics';
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

/** A stand-in for an Ollama server: `/api/ps` answers with `body`. */
async function ollamaServer(body: unknown, status = 200): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    if (request.url === '/api/ps') hits += 1;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

const GIB = 1024 ** 3;
const TWO_MODELS = {
  models: [
    { name: 'qwen3.5:4b', size: 4 * GIB, size_vram: 3 * GIB, details: { parameter_size: '4B', quantization_level: 'Q4_K_M', format: 'gguf' } },
    { name: 'embeddinggemma:300m', size: GIB, size_vram: 0.5 * GIB },
  ],
};

describe('ServerMetricsCollector', () => {
  it('reports nothing until something was measured', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    expect(getServerMetrics()).toBeDefined();
    for (const name of ['gen_ai.server.kv_cache.usage', 'gen_ai.server.requests.running', 'gen_ai.server.requests.waiting', 'gen_ai.server.requests.max']) {
      expect(await points(name), name).toBeUndefined();
    }
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
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: {}, value: 4 }]);
    expect(await points('gen_ai.server.requests.waiting')).toEqual([{ attributes: {}, value: 0 }]);
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: {}, value: 8 }]);

    server?.incrementRequestsRunning(2);
    server?.decrementRequestsRunning(10);
    server?.incrementRequestsWaiting();
    server?.incrementRequestsWaiting();
    server?.decrementRequestsWaiting();
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: {}, value: 0 }]);
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
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: {}, value: 1 }]);
    await call;
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: {}, value: 0 }]);

    // A failed call is no longer running either.
    llm.reply({ status: 500, json: { error: { message: 'boom' } } });
    await expect(client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(await points('gen_ai.server.requests.running')).toEqual([{ attributes: {}, value: 0 }]);
  });
});

describe('Ollama server metrics poller', () => {
  it('reports each loaded model as a share of the known VRAM, and the number of loaded models', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    const poller = new OllamaServerMetricsPoller({ baseUrl: `${ollama.url}/`, maxVramGb: 12 });
    await poller.collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toEqual([
      { attributes: { model: 'qwen3.5:4b' }, value: 25 },
      { attributes: { model: 'embeddinggemma:300m' }, value: (0.5 / 12) * 100 },
    ]);
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: {}, value: 2 }]);
  });

  it('a model larger than the stated VRAM is capped at 100', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, maxVramGb: 2 }).collect();
    expect((await points('gen_ai.server.kv_cache.usage'))?.[0]).toEqual({ attributes: { model: 'qwen3.5:4b' }, value: 100 });
  });

  it('with the VRAM of the host unknown, no share is reported - the reference assumes 8 GB', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, detectVram: async () => undefined }).collect();
    expect(await points('gen_ai.server.kv_cache.usage')).toBeUndefined();
    // The count of loaded models needs no VRAM figure.
    expect(await points('gen_ai.server.requests.max')).toEqual([{ attributes: {}, value: 2 }]);
  });

  it('VRAM detected from the host is used when none is configured', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ollama = await ollamaServer(TWO_MODELS);
    await new OllamaServerMetricsPoller({ baseUrl: ollama.url, detectVram: async () => 6 }).collect();
    expect((await points('gen_ai.server.kv_cache.usage'))?.[0]).toEqual({ attributes: { model: 'qwen3.5:4b' }, value: 50 });
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
    expect((await points('gen_ai.server.kv_cache.usage'))?.[0]).toEqual({ attributes: { model: 'qwen3.5:4b' }, value: 25 });
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
