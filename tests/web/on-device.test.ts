/**
 * On-device inference, through the browser entry: transformers.js, WebGPU
 * facts, and (React Native entry) cactus. Runs in the Node project and in the
 * browser-like one. The model libraries are stand-ins shaped like the real
 * ones; see tests/helpers/fake-transformers.ts.
 */
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as web from '../../src/index.browser';
import * as native from '../../src/index.react-native';
import { getDefaultCostCalculator } from '../../src/cost';
import { setLogger } from '../../src/logger';
import { makeFakeTransformers, tensor } from '../helpers/fake-transformers';

const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

function start(sdk: typeof web | typeof native, options: Record<string, unknown> = {}): InMemorySpanExporter {
  setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  const exporter = new InMemorySpanExporter();
  const handle = sdk.instrument({
    serviceName: 'on-device-test',
    endpoint: 'https://collector.example',
    fetch: okFetch,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    ...options,
  });
  if (!handle) throw new Error('instrument() failed');
  return exporter;
}

const named = (exporter: InMemorySpanExporter, name: string): ReadableSpan => {
  const found = exporter.getFinishedSpans().filter((span) => span.name === name);
  if (found.length !== 1) throw new Error(`expected one ${name}, found ${found.length} among ${exporter.getFinishedSpans().map((s) => s.name).join(', ')}`);
  return found[0] as ReadableSpan;
};

afterEach(async () => {
  web.clearWebGpuFacts();
  await web.uninstrument(0.2);
  await native.uninstrument(0.2);
  trace.disable();
  metrics.disable();
  setLogger(undefined);
  vi.unstubAllGlobals();
});

describe('transformers.js', () => {
  const MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';

  it('loading a model is one span: device asked for and used, dtype, files, bytes, fetch and session-create time', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers();
    web.instrumentTransformers(fake.module);
    const model = await fake.AutoModelForCausalLM.from_pretrained(MODEL, { device: 'webgpu', dtype: 'q4' });
    expect(model.sessions.model?.config.device).toBe('webgpu');

    const span = named(exporter, 'transformers.model.load');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'huggingface',
      'gen_ai.provider.name': 'huggingface',
      'gen_ai.request.model': MODEL,
      'gen_ai.operation.name': 'load_model',
      'transformers.device.requested': 'webgpu',
      'transformers.device': 'webgpu',
      'transformers.dtype.requested': 'q4',
      'transformers.dtype': 'q4',
      'webgpu.fallback': false,
      'transformers.load.files': 2,
      'transformers.load.bytes': 4096,
    });
    expect(span.attributes['transformers.load.fetch_ms']).toBeGreaterThan(0);
    expect(span.attributes['transformers.load.session_create_ms']).toBeGreaterThan(0);
  });

  it('the application progress callback still receives every event', async () => {
    start(web);
    const fake = makeFakeTransformers();
    web.instrumentTransformers(fake.module);
    const seen: string[] = [];
    await fake.PreTrainedModel.from_pretrained(MODEL, { progress_callback: (event: { status: string }) => seen.push(event.status) });
    expect(seen).toEqual(['initiate', 'initiate', 'progress', 'done', 'progress', 'done']);
  });

  it('WebGPU asked for, something else ran: the fallback is recorded', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers({ selectedDevice: 'wasm' });
    web.instrumentTransformers(fake.module);
    await fake.PreTrainedModel.from_pretrained(MODEL, { device: 'webgpu' });
    expect(named(exporter, 'transformers.model.load').attributes).toMatchObject({
      'transformers.device.requested': 'webgpu',
      'transformers.device': 'wasm',
      'webgpu.fallback': true,
    });
  });

  it('no device asked for: none is reported as asked for, and no fallback claim is made', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers();
    web.instrumentTransformers(fake.module);
    await fake.PreTrainedModel.from_pretrained(MODEL);
    const attributes = named(exporter, 'transformers.model.load').attributes;
    expect(attributes['transformers.device']).toBe('wasm');
    expect('transformers.device.requested' in attributes).toBe(false);
    expect('webgpu.fallback' in attributes).toBe(false);
  });

  it('a load that fails ends its span with ERROR status and rethrows', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers({ failLoad: new Error('no available backend found') });
    web.instrumentTransformers(fake.module);
    await expect(fake.PreTrainedModel.from_pretrained(MODEL, { device: 'webgpu' })).rejects.toThrow('no available backend found');
    const span = named(exporter, 'transformers.model.load');
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'no available backend found' });
  });

  it('generate: token counts from the tensors, time to first token and per-token time through the streamer, cost by size tier', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers({ newTokens: 5, tokenDelayMs: 4 });
    web.instrumentTransformers(fake.module);
    const model = await fake.AutoModelForCausalLM.from_pretrained(MODEL, { device: 'webgpu', dtype: 'q4' });

    const put = vi.fn();
    const end = vi.fn();
    const output = await model.generate({ input_ids: tensor(1, 12), max_new_tokens: 32, temperature: 0.7, top_p: 0.9, streamer: { put, end } });
    expect(output.dims).toEqual([1, 17]);
    // The application's own streamer still got everything.
    expect(put).toHaveBeenCalledTimes(6);
    expect(end).toHaveBeenCalledTimes(1);

    const span = named(exporter, 'huggingface.model.generate');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'huggingface',
      'gen_ai.request.model': MODEL,
      'gen_ai.operation.name': 'text_generation',
      'gen_ai.request.type': 'chat',
      'gen_ai.request.max_tokens': 32,
      'gen_ai.request.temperature': 0.7,
      'gen_ai.request.top_p': 0.9,
      'transformers.device': 'webgpu',
      'transformers.dtype': 'q4',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.total_tokens': 17,
      // 0.5B parameters: the size-tier estimate, as for any local model.
      'gen_ai.usage.cost.pricing_source': 'estimated',
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost(MODEL, { prompt_tokens: 12, completion_tokens: 5 }, 'chat'),
    });
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(span.attributes['gen_ai.server.time_per_output_token']).toBeGreaterThan(0);
    expect(span.attributes['transformers.tokens_per_second']).toBeGreaterThan(0);
  });

  it('generate without a streamer of the application\'s own is timed all the same', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers({ newTokens: 3 });
    web.instrumentTransformers(fake.module);
    const model = await fake.PreTrainedModel.from_pretrained('acme/untagged-model');
    const options = { input_ids: tensor(1, 8) };
    await model.generate(options);
    // The caller's options object is not modified.
    expect('streamer' in options).toBe(false);
    const attributes = named(exporter, 'huggingface.model.generate').attributes;
    expect(attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(attributes['gen_ai.usage.output_tokens']).toBe(3);
    // No size in the name and not in the pricing table: no cost at all.
    expect(attributes['gen_ai.usage.cost.pricing_source']).toBe('unpriced');
    expect('gen_ai.usage.cost.total' in attributes).toBe(false);
  });

  it('a generate that fails ends its span with ERROR status, no tokens, no cost', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers({ failGenerate: new Error('GPUDevice was lost') });
    web.instrumentTransformers(fake.module);
    const model = await fake.PreTrainedModel.from_pretrained(MODEL);
    await expect(model.generate({ input_ids: tensor(1, 8) })).rejects.toThrow('GPUDevice was lost');
    const span = named(exporter, 'huggingface.model.generate');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });

  it('a pipeline call is a span of its own; tokens and cost stay on the generate span, counted once', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers({ newTokens: 4 });
    web.instrumentTransformers(fake.module);
    const model = await fake.AutoModelForCausalLM.from_pretrained(MODEL);
    const generator = new fake.TextGenerationPipeline({ task: 'text-generation', model });
    const output = await generator('What is the capital of France?');
    expect(Array.isArray(output)).toBe(true);

    const pipelineSpan = named(exporter, 'huggingface.pipeline');
    expect(pipelineSpan.attributes).toMatchObject({
      'gen_ai.system': 'huggingface',
      'gen_ai.request.model': MODEL,
      'gen_ai.operation.name': 'text-generation',
      'huggingface.task': 'text-generation',
    });
    expect(Object.keys(pipelineSpan.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
    expect(named(exporter, 'huggingface.model.generate').attributes['gen_ai.usage.output_tokens']).toBe(4);
  });

  it('a feature-extraction pipeline is an embeddings span with the vector count and size', async () => {
    const exporter = start(web);
    const fake = makeFakeTransformers();
    web.instrumentTransformers(fake.module);
    const model = await fake.PreTrainedModel.from_pretrained('Xenova/all-MiniLM-L6-v2');
    const extractor = new fake.FeatureExtractionPipeline({ task: 'feature-extraction', model });
    await extractor(['alpha', 'beta', 'gamma'], { pooling: 'mean' });
    expect(named(exporter, 'huggingface.pipeline').attributes).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 3,
      'gen_ai.response.embedding_count': 3,
      'gen_ai.response.vector_size': 384,
      'huggingface.task': 'feature-extraction',
    });
  });

  it('instrumenting twice does not double the spans; before instrument() the library is untouched in effect', async () => {
    const fake = makeFakeTransformers();
    web.instrumentTransformers(fake.module);
    const early = await fake.PreTrainedModel.from_pretrained(MODEL);
    expect(early.sessions.model?.config.device).toBe('wasm');

    const exporter = start(web);
    web.instrumentTransformers(fake.module);
    web.instrumentTransformers(fake.module);
    await fake.PreTrainedModel.from_pretrained(MODEL);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['transformers.model.load']);
  });

  it('something that is not the library is refused quietly', () => {
    start(web);
    expect(web.instrumentTransformers({})).toBe(false);
    expect(web.instrumentTransformers(undefined)).toBe(false);
  });
});

describe('WebGPU facts', () => {
  const adapter = (fallback = false): Record<string, unknown> => ({
    info: { vendor: 'nvidia', architecture: 'ampere', device: '0x2484', description: 'NVIDIA GeForce RTX 3070' },
    isFallbackAdapter: fallback,
    features: new Set(['shader-f16', 'timestamp-query']),
    limits: { maxBufferSize: 2147483648, maxStorageBufferBindingSize: 1073741824, maxTextureDimension2D: 16384, maxComputeWorkgroupStorageSize: 32768 },
  });

  it('reads the adapter: vendor, architecture, fallback flag, features, selected limits', async () => {
    const facts = await web.collectWebGpuFacts({ requestAdapter: async () => adapter() });
    expect(facts).toEqual({
      'webgpu.available': true,
      'webgpu.adapter.vendor': 'nvidia',
      'webgpu.adapter.architecture': 'ampere',
      'webgpu.adapter.device': '0x2484',
      'webgpu.adapter.description': 'NVIDIA GeForce RTX 3070',
      'webgpu.adapter.is_fallback': false,
      'webgpu.features': ['shader-f16', 'timestamp-query'],
      'webgpu.limits.max_buffer_size': 2147483648,
      'webgpu.limits.max_storage_buffer_binding_size': 1073741824,
      'webgpu.limits.max_texture_dimension_2d': 16384,
      'webgpu.limits.max_compute_workgroup_storage_size': 32768,
    });
  });

  it('no WebGPU, or no adapter: said so, with nothing invented', async () => {
    expect(await web.collectWebGpuFacts(undefined)).toEqual({ 'webgpu.available': false, 'webgpu.unavailable_reason': 'navigator.gpu is not present' });
    expect(await web.collectWebGpuFacts({ requestAdapter: async () => null })).toEqual({
      'webgpu.available': false,
      'webgpu.unavailable_reason': 'no adapter was returned',
    });
    const failing = await web.collectWebGpuFacts({
      requestAdapter: async () => {
        throw new Error('blocked by policy');
      },
    });
    expect(failing).toEqual({ 'webgpu.available': false, 'webgpu.unavailable_reason': 'blocked by policy' });
  });

  it('reads navigator.gpu by default, and never reports utilisation, temperature or power', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter(true) } });
    const facts = await web.collectWebGpuFacts();
    expect(facts['webgpu.adapter.is_fallback']).toBe(true);
    expect(Object.keys(facts).filter((key) => /util|temp|power|energy|co2/i.test(key))).toEqual([]);
  });

  it('once collected, the facts ride on model-load spans', async () => {
    const exporter = start(web);
    await web.enableWebGpuFacts({ requestAdapter: async () => adapter() });
    const fake = makeFakeTransformers();
    web.instrumentTransformers(fake.module);
    await fake.PreTrainedModel.from_pretrained('acme/model', { device: 'webgpu' });
    expect(named(exporter, 'transformers.model.load').attributes).toMatchObject({
      'webgpu.available': true,
      'webgpu.adapter.vendor': 'nvidia',
      'webgpu.adapter.is_fallback': false,
    });
  });

  it('a lost device is counted and logged, with the reason the browser gave', async () => {
    start(web);
    const warned: string[] = [];
    setLogger({ debug: () => {}, info: () => {}, warn: (message) => warned.push(String(message)), error: () => {} });
    let lose: (info: { reason: string; message: string }) => void = () => {};
    const device = { lost: new Promise<{ reason: string; message: string }>((resolve) => (lose = resolve)) };
    const watching = web.watchWebGpuDevice(device, { model: 'acme/model' });
    lose({ reason: 'destroyed', message: 'device was destroyed' });
    expect(await watching).toEqual({ reason: 'destroyed', message: 'device was destroyed' });
    expect(warned.join('\n')).toContain('WebGPU device lost');
    expect(warned.join('\n')).toContain('destroyed');
  });
});

describe('cactus-react-native', () => {
  /** Shaped like `CactusLM` (v1.13): model in the constructor, `complete()` resolving to the native result. */
  class CactusLM {
    static failNext: Error | undefined;
    static nextResult: Record<string, unknown> | undefined;
    model: string;

    constructor(options: { model?: string } = {}) {
      this.model = options.model ?? 'lfm2-350m';
    }

    getModelName(): string {
      return `${this.model}-int4`;
    }

    async download(_params?: { onProgress?: (progress: number) => void }): Promise<void> {
      _params?.onProgress?.(1);
    }

    async init(): Promise<void> {
      if (CactusLM.failNext) throw CactusLM.failNext;
    }

    async complete(params: { messages: unknown[]; onToken?: (token: string) => void }): Promise<Record<string, unknown>> {
      if (CactusLM.failNext) throw CactusLM.failNext;
      params.onToken?.('Paris');
      return (
        CactusLM.nextResult ?? {
          success: true,
          response: 'Paris.',
          timeToFirstTokenMs: 180,
          totalTimeMs: 620,
          prefillTokens: 24,
          prefillTps: 310.5,
          decodeTokens: 6,
          decodeTps: 42.25,
          totalTokens: 30,
          ramUsageMb: 512.5,
        }
      );
    }

    static embedDelayMs = 0;

    async embed(_params: { text: string }): Promise<{ embedding: number[] }> {
      if (CactusLM.embedDelayMs) await new Promise((resolve) => setTimeout(resolve, CactusLM.embedDelayMs));
      return { embedding: [0.1, 0.2, 0.3, 0.4] };
    }
  }

  afterEach(() => {
    CactusLM.failNext = undefined;
    CactusLM.nextResult = undefined;
    CactusLM.embedDelayMs = 0;
  });

  const MESSAGES = [{ role: 'user', content: 'What is the capital of France?' }];

  it('complete: model, request options, native token counts, time to first token, decode speed, memory', async () => {
    const exporter = start(native);
    expect(native.instrumentCactus({ CactusLM })).toBe(true);
    const lm = new CactusLM({ model: 'lfm2-350m' });
    const tokens: string[] = [];
    const result = await lm.complete({
      messages: MESSAGES,
      onToken: (token: string) => tokens.push(token),
      // @ts-expect-error extra fields the stand-in does not declare
      options: { temperature: 0.2, topP: 0.9, maxTokens: 128 },
    });
    expect(result.response).toBe('Paris.');
    expect(tokens).toEqual(['Paris']);

    const span = named(exporter, 'cactus.complete');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'cactus',
      'gen_ai.provider.name': 'cactus',
      'gen_ai.request.model': 'lfm2-350m',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.message_count': 1,
      'gen_ai.request.temperature': 0.2,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.request.max_tokens': 128,
      'gen_ai.usage.input_tokens': 24,
      'gen_ai.usage.output_tokens': 6,
      'gen_ai.usage.total_tokens': 30,
      'gen_ai.server.time_to_first_token': 0.18,
      'cactus.model_file': 'lfm2-350m-int4',
      'cactus.decode_tps': 42.25,
      'cactus.prefill_tps': 310.5,
      'cactus.ram_usage_mb': 512.5,
      // 350M parameters: the size-tier estimate.
      'gen_ai.usage.cost.pricing_source': 'estimated',
    });
    expect(span.attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });

  it('tool calls the model made are recorded, and a cloud handoff is said', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    CactusLM.nextResult = {
      success: true,
      response: '',
      functionCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }],
      cloudHandoff: true,
      confidence: 0.41,
      timeToFirstTokenMs: 90,
      totalTimeMs: 300,
      prefillTokens: 40,
      prefillTps: 300,
      decodeTokens: 12,
      decodeTps: 40,
      totalTokens: 52,
    };
    await new CactusLM().complete({
      messages: MESSAGES,
      // @ts-expect-error extra fields the stand-in does not declare
      tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {}, required: [] } }],
    });
    const attributes = named(exporter, 'cactus.complete').attributes;
    expect(attributes).toMatchObject({
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'get_weather',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments': '{"city": "Paris"}',
      'cactus.cloud_handoff': true,
      'cactus.confidence': 0.41,
    });
    expect(String(attributes['llm.tools'])).toContain('get_weather');
    // The device's memory was not reported this time: absent, not zero.
    expect('cactus.ram_usage_mb' in attributes).toBe(false);
  });

  it('a completion the engine reports as failed ends the span with ERROR status, no tokens, no cost', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    CactusLM.nextResult = { success: false, response: 'context window exceeded', timeToFirstTokenMs: 0, totalTimeMs: 3, prefillTokens: 0, prefillTps: 0, decodeTokens: 0, decodeTps: 0, totalTokens: 0 };
    const result = await new CactusLM().complete({ messages: MESSAGES });
    expect(result.success).toBe(false);
    const span = named(exporter, 'cactus.complete');
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'context window exceeded' });
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });

  it('a completion that throws ends the span with ERROR status and rethrows', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    CactusLM.failNext = new Error('Model is not initialized');
    await expect(new CactusLM().complete({ messages: MESSAGES })).rejects.toThrow('Model is not initialized');
    expect(named(exporter, 'cactus.complete').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('download and init are spans too, so a slow first launch is explained', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    const lm = new CactusLM({ model: 'lfm2-350m' });
    const progress: number[] = [];
    await lm.download({ onProgress: (value) => progress.push(value) });
    await lm.init();
    expect(progress).toEqual([1]);
    expect(named(exporter, 'cactus.download').attributes).toMatchObject({ 'gen_ai.system': 'cactus', 'gen_ai.request.model': 'lfm2-350m', 'gen_ai.operation.name': 'download_model' });
    expect(named(exporter, 'cactus.init').attributes).toMatchObject({ 'gen_ai.request.model': 'lfm2-350m', 'gen_ai.operation.name': 'load_model' });
  });

  it('embed is an embeddings span with the vector size', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    await new CactusLM().embed({ text: 'alpha' });
    expect(named(exporter, 'cactus.embed').attributes).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 1,
      'gen_ai.response.embedding_count': 1,
      'gen_ai.response.vector_size': 4,
    });
  });

  it('something that is not the library is refused quietly', () => {
    start(native);
    expect(native.instrumentCactus({})).toBe(false);
  });
  it('every span carries its OpenInference kind, so Arize AX and Phoenix classify it', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    const lm = new CactusLM();
    await lm.download();
    await lm.init();
    await lm.complete({ messages: MESSAGES });
    await lm.embed({ text: 'alpha' });
    const kind = (name: string) => named(exporter, name).attributes['openinference.span.kind'];
    expect([kind('cactus.download'), kind('cactus.init'), kind('cactus.complete'), kind('cactus.embed')]).toEqual([
      'CHAIN',
      'CHAIN',
      'LLM',
      'EMBEDDING',
    ]);
  });

  it('init() on a model that is already loaded is not a span (the engine calls it before every completion)', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    const lm = Object.assign(new CactusLM(), { isInitialized: false });
    await lm.init();
    lm.isInitialized = true;
    await lm.init();
    await lm.init();
    expect(exporter.getFinishedSpans().filter((span) => span.name === 'cactus.init')).toHaveLength(1);
  });

  it('a model call inside a span of the application is its child, across await (no async context in React Native)', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    const tracer = trace.getTracer('app');
    const parent = tracer.startSpan('invoke_agent assistant');
    await context.with(trace.setSpan(context.active(), parent), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await new CactusLM().complete({ messages: MESSAGES });
    });
    parent.end();
    // Outside the scope again: a new trace.
    await new CactusLM().embed({ text: 'later' });

    const child = named(exporter, 'cactus.complete');
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(named(exporter, 'cactus.embed').spanContext().traceId).not.toBe(parent.spanContext().traceId);
  });

  it('a model call running in the background does not become the parent of what starts meanwhile', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    CactusLM.embedDelayMs = 30;
    const background = new CactusLM().embed({ text: 'index me' }); // e.g. a search index, not awaited
    const tracer = trace.getTracer('app');
    const pipeline = tracer.startSpan('pipeline.ingest');
    await context.with(trace.setSpan(context.active(), pipeline), async () => {
      CactusLM.embedDelayMs = 0;
      await new CactusLM().complete({ messages: MESSAGES });
    });
    pipeline.end();
    await background;

    const embed = named(exporter, 'cactus.embed');
    expect(pipeline.spanContext().traceId).not.toBe(embed.spanContext().traceId);
    const complete = named(exporter, 'cactus.complete');
    expect(complete.parentSpanContext?.spanId).toBe(pipeline.spanContext().spanId);
  });

  it('captured content is also exported under the names OpenInference backends display', async () => {
    const bodies: string[] = [];
    const capture = (async (_url: unknown, init: { body: string | Uint8Array }) => {
      bodies.push(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    start(native, { fetch: capture, spanProcessors: [] });
    const tracer = trace.getTracer('app');
    tracer
      .startSpan('execute_tool get_weather', {
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'get_weather',
          'gen_ai.tool.description': 'Gets the weather for a city.',
          'gen_ai.tool.call.arguments': '{"city":"Paris"}',
          'gen_ai.tool.call.result': '{"success":true}',
        },
      })
      .end();
    const retrieve = tracer.startSpan('retrieve memory', { attributes: { 'gen_ai.operation.name': 'retrieve' } });
    native.addRetrievalAttributes(retrieve, [{ id: 'm1', score: 2.5, content: 'Refunds within 30 days' }], { query: 'refund policy' });
    retrieve.end();
    // Content not captured: nothing to mirror.
    tracer.startSpan('execute_tool lookup_order', { attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup_order' } }).end();
    await native.flushTelemetry(2);

    const spans = bodies
      .map((body) => JSON.parse(body))
      .filter((body) => body.resourceSpans)
      .flatMap((body) => body.resourceSpans.flatMap((r: { scopeSpans: { spans: unknown[] }[] }) => r.scopeSpans.flatMap((s) => s.spans))) as {
      name: string;
      attributes: { key: string; value: Record<string, unknown> }[];
    }[];
    const attrs = (name: string) =>
      Object.fromEntries((spans.find((s) => s.name === name)?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
    expect(attrs('execute_tool get_weather')).toMatchObject({
      'input.value': '{"city":"Paris"}',
      'output.value': '{"success":true}',
      'tool.name': 'get_weather',
      'tool.description': 'Gets the weather for a city.',
      'tool.parameters': '{"city":"Paris"}',
    });
    expect(attrs('retrieve memory')).toMatchObject({
      'openinference.span.kind': 'RETRIEVER',
      'input.value': 'refund policy',
      'retrieval.documents.0.document.content': 'Refunds within 30 days',
    });
    const bare = attrs('execute_tool lookup_order');
    expect(bare['tool.name']).toBe('lookup_order');
    expect('input.value' in bare || 'output.value' in bare || 'tool.parameters' in bare).toBe(false);
  });

  it('withSession holds across await, so every model call in the conversation carries its session', async () => {
    const exporter = start(native);
    native.instrumentCactus({ CactusLM });
    await native.withSession('chat-41', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await new CactusLM().complete({ messages: MESSAGES });
    });
    expect(named(exporter, 'cactus.complete').attributes).toMatchObject({
      'session.id': 'chat-41',
      'gen_ai.conversation.id': 'chat-41',
    });
  });

  it('the export carries the OpenInference kind of application spans and the project name', async () => {
    const bodies: string[] = [];
    const capture = (async (_url: unknown, init: { body: string | Uint8Array }) => {
      bodies.push(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    start(native, { fetch: capture, spanProcessors: [] });
    const tracer = trace.getTracer('app');
    tracer.startSpan('invoke_agent assistant').end();
    tracer.startSpan('pipeline.ingest').end();
    tracer.startSpan('retrieve memory').end();
    await native.flushTelemetry(2);

    const payload = bodies.map((body) => JSON.parse(body)).find((body) => body.resourceSpans);
    const resource = payload.resourceSpans[0].resource.attributes as { key: string; value: { stringValue?: string } }[];
    expect(resource.find((a) => a.key === 'openinference.project.name')?.value.stringValue).toBe('on-device-test');
    const spans = payload.resourceSpans.flatMap((r: { scopeSpans: { spans: unknown[] }[] }) => r.scopeSpans.flatMap((s) => s.spans)) as {
      name: string;
      attributes: { key: string; value: { stringValue?: string } }[];
    }[];
    const kindOf = (name: string) =>
      spans.find((s) => s.name === name)?.attributes.find((a) => a.key === 'openinference.span.kind')?.value.stringValue;
    expect([kindOf('invoke_agent assistant'), kindOf('pipeline.ingest'), kindOf('retrieve memory')]).toEqual(['AGENT', 'CHAIN', 'RETRIEVER']);
  });
});
