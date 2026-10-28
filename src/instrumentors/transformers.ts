/**
 * Instrumentor for transformers.js (`@huggingface/transformers`): models that
 * run in the page, in a worker, or in Node, on WebGPU, WASM or the CPU.
 *
 * The local-model half of `genai_otel/instrumentors/huggingface_instrumentor.py`,
 * with the same span names and `gen_ai.system`:
 *
 *  - `huggingface.pipeline`       one pipeline call;
 *  - `huggingface.model.generate` one `model.generate()`: token counts read
 *    off the tensors, time to first token and per-token time through the
 *    streamer hook, cost from the pricing table or the size tier;
 *  - `transformers.model.load`    (not in the reference) one
 *    `from_pretrained()`: which device was asked for and which one ran, the
 *    dtype, how long fetching the files and creating the session took.
 *
 * Two things differ from the reference on purpose. The pipeline span carries
 * no token estimate: the generate span nested in it has the measured counts,
 * and both carrying them would count every token twice. And nothing is said
 * about cache versus download, because the library does not tell.
 *
 * Runs wherever the library does. In a browser the application hands the
 * library over (`instrumentTransformers(module)`); on Node it is also found
 * by name.
 */
import type { AttributeValue, Span } from '@opentelemetry/api';
import { logger } from '../logger';
import { ATTR } from '../semconv';
import { webGpuFacts } from '../webgpu';
import type { Params, UsageDict } from './base';
import { PatchingInstrumentor, type PatchTarget } from './patching';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;

const isObject = (value: unknown): value is Obj => (typeof value === 'object' || typeof value === 'function') && value !== null;
const nowMs = (): number => (typeof performance === 'object' ? performance.now() : Date.now());

/** The last dimension of a tensor-like value: the sequence length. */
function sequenceLength(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const dims = value.dims;
  if (Array.isArray(dims) && dims.length > 0 && typeof dims[dims.length - 1] === 'number') return dims[dims.length - 1] as number;
  if (Array.isArray(value) && Array.isArray(value[0])) return (value[0] as unknown[]).length;
  return undefined;
}

/** What the library created the session on, as opposed to what was asked for. */
function sessionConfig(model: unknown): { device?: string; dtype?: string } {
  const sessions = isObject(model) ? model.sessions : undefined;
  if (!isObject(sessions)) return {};
  const first = (sessions.model ?? Object.values(sessions)[0]) as unknown;
  const config = isObject(first) ? first.config : undefined;
  if (!isObject(config)) return {};
  return {
    device: typeof config.device === 'string' ? config.device : undefined,
    dtype: typeof config.dtype === 'string' ? config.dtype : undefined,
  };
}

interface GenerateTiming {
  started: number;
  /** Milliseconds from the call to the first generated token. */
  firstTokenMs?: number;
  promptTokens?: number;
}

export class TransformersInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'transformers.js';
  protected readonly packages = ['@huggingface/transformers'];
  protected override get owner(): string {
    return 'transformers.js';
  }

  /** Model object -> the id it was loaded under. The library does not keep it. */
  private readonly modelIds = new WeakMap<object, string>();
  /** The options object handed to `generate` -> what was timed for it. */
  private readonly timings = new WeakMap<object, GenerateTiming>();
  /** The call being recorded; set and read synchronously. */
  private recording: { params: Params; pipeline: boolean; embedding: boolean } | undefined;

  protected targets(module: unknown): PatchTarget[] {
    if (!isObject(module)) return [];
    const model = module.PreTrainedModel;
    if (typeof model !== 'function') return [];
    const prototype = (model as { prototype: object }).prototype;

    const targets: PatchTarget[] = [
      {
        // A static: every model class inherits it.
        holder: model,
        method: 'from_pretrained',
        wrap: (original) => this.loadWrapper(original),
      },
      {
        holder: prototype,
        method: 'generate',
        wrap: (original) => this.generateWrapper(original),
      },
    ];
    // Every pipeline class that implements `_call` itself.
    for (const [name, exported] of Object.entries(module)) {
      if (!name.endsWith('Pipeline') || typeof exported !== 'function') continue;
      const pipelinePrototype = (exported as { prototype?: object }).prototype;
      if (!pipelinePrototype || !Object.prototype.hasOwnProperty.call(pipelinePrototype, '_call')) continue;
      targets.push({
        holder: pipelinePrototype,
        method: '_call',
        spanName: 'huggingface.pipeline',
        attributes: (instance, args) => this.pipelineAttributes(instance, args),
        options: { params: (args) => ({ __pipeline: true, inputs: args[0], model: 'unknown' }) },
      });
    }
    return targets;
  }

  private modelName(model: unknown): string {
    if (isObject(model)) {
      const known = this.modelIds.get(model);
      if (known) return known;
      const config = model.config;
      if (isObject(config)) {
        for (const key of ['_name_or_path', 'name_or_path', 'model_type']) {
          if (typeof config[key] === 'string' && config[key]) return config[key];
        }
      }
    }
    return 'unknown';
  }

  // -------------------------------------------------------------------------
  // from_pretrained
  // -------------------------------------------------------------------------

  private loadWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    const traced = this.operationWrapper(
      'transformers.model.load',
      (_modelClass, args) => {
        const options = isObject(args[1]) ? args[1] : {};
        const attributes: Record<string, AttributeValue | undefined> = {
          [ATTR.GEN_AI_SYSTEM]: 'huggingface',
          [ATTR.GEN_AI_PROVIDER_NAME]: 'huggingface',
          [ATTR.GEN_AI_REQUEST_MODEL]: String(args[0] ?? 'unknown'),
          [ATTR.GEN_AI_OPERATION_NAME]: 'load_model',
          ...webGpuFacts(),
        };
        if (typeof options.device === 'string') attributes['transformers.requested_device'] = options.device;
        if (options.dtype !== undefined && options.dtype !== null) {
          attributes['transformers.requested_dtype'] = typeof options.dtype === 'string' ? options.dtype : JSON.stringify(options.dtype);
        }
        return attributes;
      },
      (span, model, _modelClass, args) => {
        if (isObject(model)) instrumentor.modelIds.set(model, String(args[0] ?? 'unknown'));
        const options = isObject(args[1]) ? args[1] : {};
        const { device, dtype } = sessionConfig(model);
        if (device) span.setAttribute('transformers.device', device);
        if (dtype) span.setAttribute('transformers.dtype', dtype);
        // Only where WebGPU was asked for can it have been fallen back from.
        if (device && (options.device === 'webgpu' || options.device === 'auto')) {
          span.setAttribute('webgpu.fallback', device !== 'webgpu');
        }
        const progress = isObject(args[1]) ? (instrumentor.loads.get(args[1]) ?? undefined) : undefined;
        if (progress && progress.files.size > 0) {
          span.setAttribute('transformers.load.files', progress.files.size);
          let bytes = 0;
          for (const size of progress.files.values()) bytes += size;
          if (bytes > 0) span.setAttribute('transformers.load.bytes', bytes);
          if (progress.lastDone !== undefined) {
            span.setAttribute('transformers.load.fetch_ms', progress.lastDone - progress.started);
            span.setAttribute('transformers.load.session_create_ms', nowMs() - progress.lastDone);
          }
        }
      },
    )(original);

    return function (this: unknown, ...args: unknown[]): unknown {
      if (!instrumentor.instrumented) return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      // Listen to the progress events through a copy of the options: the
      // application's own callback, if any, still gets every event.
      const options: Obj = isObject(args[1]) ? { ...args[1] } : {};
      const theirs = options.progress_callback;
      const progress: LoadProgress = { started: nowMs(), files: new Map() };
      // A callback the library has already wrapped carries state of its own; leave it be.
      if (theirs === undefined || theirs === null || typeof theirs === 'function') {
        options.progress_callback = (event: unknown): void => {
          try {
            if (isObject(event) && typeof event.file === 'string') {
              if (!progress.files.has(event.file)) progress.files.set(event.file, 0);
              if (typeof event.total === 'number' && event.total > 0) progress.files.set(event.file, event.total);
              if (event.status === 'done') progress.lastDone = nowMs();
            }
          } catch {
            // observation must never disturb a load
          }
          if (typeof theirs === 'function') (theirs as (value: unknown) => void)(event);
        };
        instrumentor.loads.set(options, progress);
      }
      return (traced as unknown as (...a: unknown[]) => unknown).apply(this, [args[0], options, ...args.slice(2)]);
    } as unknown as AnyFunction;
  }

  private readonly loads = new WeakMap<object, LoadProgress>();

  // -------------------------------------------------------------------------
  // generate
  // -------------------------------------------------------------------------

  private generateWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    const traced = this.createSpanWrapper('huggingface.model.generate', (instance, _args, params) => this.generateAttributes(instance, params))(
      original,
    );
    return function (this: unknown, ...args: unknown[]): unknown {
      if (!instrumentor.instrumented) return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      const given = isObject(args[0]) ? args[0] : {};
      const theirs = given.streamer as { put?: (value: unknown) => void; end?: () => void } | null | undefined;
      const timing: GenerateTiming = { started: nowMs(), promptTokens: sequenceLength(given.input_ids ?? given.inputs) };
      let puts = 0;
      // A copy: the caller's options object is left as it was. The streamer hears
      // the prompt first, then each generated token.
      const options: Obj = {
        ...given,
        streamer: {
          put(value: unknown): void {
            puts += 1;
            if (puts === 2 && timing.firstTokenMs === undefined) timing.firstTokenMs = nowMs() - timing.started;
            theirs?.put?.(value);
          },
          end(): void {
            theirs?.end?.();
          },
        },
      };
      instrumentor.timings.set(options, timing);
      return (traced as unknown as (...a: unknown[]) => unknown).apply(this, [options, ...args.slice(1)]);
    } as unknown as AnyFunction;
  }

  private generateAttributes(instance: unknown, params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'huggingface',
      [ATTR.GEN_AI_REQUEST_MODEL]: this.modelName(instance),
      [ATTR.GEN_AI_OPERATION_NAME]: 'text_generation',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'chat',
    };
    const maxTokens = params.max_new_tokens ?? params.max_length;
    if (typeof maxTokens === 'number') attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = maxTokens;
    if (typeof params.temperature === 'number') attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = params.temperature;
    if (typeof params.top_p === 'number') attributes[ATTR.GEN_AI_REQUEST_TOP_P] = params.top_p;
    const { device, dtype } = sessionConfig(instance);
    if (device) attributes['transformers.device'] = device;
    if (dtype) attributes['transformers.dtype'] = dtype;
    return attributes;
  }

  // -------------------------------------------------------------------------
  // pipeline
  // -------------------------------------------------------------------------

  private pipelineAttributes(pipeline: unknown, args: unknown[]): Obj {
    const task = String((isObject(pipeline) ? pipeline.task : undefined) ?? 'unknown');
    const normalised = task.toLowerCase();
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'huggingface',
      [ATTR.GEN_AI_REQUEST_MODEL]: this.modelName(isObject(pipeline) ? pipeline.model : undefined),
      'huggingface.task': task,
    };
    let operation = task;
    if (normalised === 'feature-extraction') {
      operation = 'embeddings';
      attributes[ATTR.GEN_AI_REQUEST_TYPE] = 'embedding';
      const input = args[0];
      attributes[ATTR.GEN_AI_REQUEST_INPUT_COUNT] = Array.isArray(input) ? input.length : input !== undefined && input !== null ? 1 : 0;
    } else if (normalised === 'automatic-speech-recognition') {
      operation = 'speech_to_text';
      attributes[ATTR.GEN_AI_REQUEST_TYPE] = 'speech_to_text';
    }
    attributes[ATTR.GEN_AI_OPERATION_NAME] = operation;
    const { device, dtype } = sessionConfig(isObject(pipeline) ? pipeline.model : undefined);
    if (device) attributes['transformers.device'] = device;
    if (dtype) attributes['transformers.dtype'] = dtype;
    return attributes;
  }

  // -------------------------------------------------------------------------
  // results
  // -------------------------------------------------------------------------

  protected override recordResultMetrics(span: Span, spanName: string, result: unknown, startTime: number, params: Params): void {
    const pipeline = params.__pipeline === true;
    const written = (span as unknown as { attributes?: Obj }).attributes ?? {};
    this.recording = { params, pipeline, embedding: written[ATTR.GEN_AI_REQUEST_TYPE] === 'embedding' };
    try {
      super.recordResultMetrics(span, spanName, result, startTime, params);
    } finally {
      this.recording = undefined;
    }
    if (pipeline) return;
    try {
      const timing = this.timings.get(params);
      if (!timing) return;
      const model = String((span as unknown as { attributes?: Obj }).attributes?.[ATTR.GEN_AI_REQUEST_MODEL] ?? 'unknown');
      const durationSeconds = (nowMs() - timing.started) / 1000;
      const outputTokens = this.generatedTokens(result, timing);
      if (timing.firstTokenMs !== undefined) {
        const ttft = timing.firstTokenMs / 1000;
        this.recordTimeToFirstToken(span, spanName, ttft, model);
        this.recordTimePerOutputToken(span, spanName, ttft, durationSeconds, outputTokens, model);
      }
      if (outputTokens !== undefined && outputTokens > 0 && durationSeconds > 0) {
        span.setAttribute('transformers.tokens_per_second', outputTokens / durationSeconds);
      }
    } catch (error) {
      logger.debug(`Failed to record generation timing: ${String(error)}`);
    }
  }

  private generatedTokens(result: unknown, timing: GenerateTiming): number | undefined {
    const total = sequenceLength(isObject(result) && 'sequences' in result ? result.sequences : result);
    if (total === undefined) return undefined;
    return Math.max(0, total - (timing.promptTokens ?? 0));
  }

  /** Measured, from the tensors: prompt length in, total length out. A pipeline span has none (see the file header). */
  protected extractUsage(result: unknown): UsageDict | null {
    const recording = this.recording;
    if (!recording || recording.pipeline) return null;
    const timing = this.timings.get(recording.params);
    if (!timing) return null;
    const promptTokens = timing.promptTokens ?? 0;
    const completionTokens = this.generatedTokens(result, timing) ?? 0;
    if (promptTokens === 0 && completionTokens === 0) return null;
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }

  /** Embedding count and vector size, off the output tensor of a feature-extraction pipeline. */
  protected override extractResponseAttributes(result: unknown): Obj {
    if (!this.recording?.pipeline || !this.recording.embedding) return {};
    const dims = isObject(result) && Array.isArray(result.dims) ? (result.dims as unknown[]) : undefined;
    if (!dims || dims.length < 2 || !dims.every((value) => typeof value === 'number')) return {};
    return { [ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT]: dims[0], [ATTR.GEN_AI_RESPONSE_VECTOR_SIZE]: dims[dims.length - 1] };
  }

  /** Instrument a transformers.js module the application imported. True if it was recognised. */
  instrumentLibrary(module: unknown): boolean {
    return this.instrumentModule(module);
  }
}

interface LoadProgress {
  started: number;
  /** File name -> size in bytes, 0 when the library did not say. */
  files: Map<string, number>;
  lastDone?: number;
}
