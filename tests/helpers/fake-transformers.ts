/**
 * A stand-in for `@huggingface/transformers`, shaped like the real package
 * where the instrumentor touches it (read from the v4.3.0 source):
 *
 *  - `PreTrainedModel.from_pretrained(id, { device, dtype, progress_callback })`
 *    is a static inherited by every model class, dispatches `initiate` /
 *    `progress` / `done` events per file, and returns a model whose
 *    `sessions.model.config` is `{ device, dtype }`;
 *  - `model.generate({ input_ids, streamer, max_new_tokens, ... })` calls
 *    `streamer.put()` once with the prompt and once per generated token, then
 *    `streamer.end()`, and resolves to a tensor with `dims`;
 *  - pipeline classes extend `Pipeline`, hold `task` / `model` / `tokenizer`
 *    and implement `_call`; a pipeline object is callable.
 *
 * The real package is not a dependency here: it would pull the ONNX runtime
 * and need a model download to do anything.
 */
export interface FakeTensor {
  dims: number[];
}

const tensor = (...dims: number[]): FakeTensor => ({ dims });

export interface FakeOptions {
  /** What a session reports having been created on; default: the requested device, or `wasm`. */
  selectedDevice?: string;
  /** Tokens the model produces per generate call. */
  newTokens?: number;
  /** Milliseconds per generated token. */
  tokenDelayMs?: number;
  failLoad?: Error;
  failGenerate?: Error;
}

export function makeFakeTransformers(behaviour: FakeOptions = {}): {
  module: Record<string, unknown>;
  PreTrainedModel: FakeModelClass;
  AutoModelForCausalLM: FakeModelClass;
  TextGenerationPipeline: new (parts: { task: string; model: unknown; tokenizer?: unknown }) => FakePipeline;
  FeatureExtractionPipeline: new (parts: { task: string; model: unknown; tokenizer?: unknown }) => FakePipeline;
} {
  class PreTrainedModel {
    sessions: Record<string, { config: { device: string; dtype: string } }> = {};
    config = { model_type: 'fake' };

    static async from_pretrained(
      this: new () => PreTrainedModel,
      id: string,
      options: { device?: string | null; dtype?: string | null; progress_callback?: ((event: Record<string, unknown>) => void) | null } = {},
    ): Promise<PreTrainedModel> {
      const files = ['config.json', 'onnx/model_q4.onnx'];
      for (const file of files) options.progress_callback?.({ status: 'initiate', name: id, file });
      await new Promise((done) => setTimeout(done, 5));
      for (const file of files) {
        options.progress_callback?.({ status: 'progress', name: id, file, progress: 100, loaded: file.endsWith('.onnx') ? 4000 : 96, total: file.endsWith('.onnx') ? 4000 : 96 });
        options.progress_callback?.({ status: 'done', name: id, file });
      }
      if (behaviour.failLoad) throw behaviour.failLoad;
      await new Promise((done) => setTimeout(done, 5));
      const model = new this();
      model.sessions = { model: { config: { device: behaviour.selectedDevice ?? options.device ?? 'wasm', dtype: options.dtype ?? 'q8' } } };
      return model;
    }

    async generate(options: { input_ids?: FakeTensor; streamer?: { put(value: unknown): void; end(): void } | null; [key: string]: unknown }): Promise<FakeTensor> {
      if (behaviour.failGenerate) throw behaviour.failGenerate;
      const promptLength = options.input_ids?.dims.at(-1) ?? 0;
      const newTokens = behaviour.newTokens ?? 4;
      options.streamer?.put([[...Array(promptLength).keys()]]);
      for (let index = 0; index < newTokens; index += 1) {
        await new Promise((done) => setTimeout(done, behaviour.tokenDelayMs ?? 3));
        options.streamer?.put([[index]]);
      }
      options.streamer?.end();
      return tensor(1, promptLength + newTokens);
    }
  }

  class AutoModelForCausalLM extends PreTrainedModel {}

  /** As the real `Callable`: constructing one yields a function that runs `_call`. */
  class Callable {
    constructor() {
      const closure = (...args: unknown[]): unknown => (closure as unknown as { _call: (...a: unknown[]) => unknown })._call(...args);
      return Object.setPrototypeOf(closure, new.target.prototype) as unknown as this;
    }
  }

  class Pipeline extends Callable {
    task: string;
    model: PreTrainedModel;
    tokenizer: unknown;

    constructor(parts: { task: string; model: unknown; tokenizer?: unknown }) {
      super();
      this.task = parts.task;
      this.model = parts.model as PreTrainedModel;
      this.tokenizer = parts.tokenizer;
    }

    async _call(..._args: unknown[]): Promise<unknown> {
      throw new Error('not implemented');
    }
  }

  class TextGenerationPipeline extends Pipeline {
    override async _call(texts: unknown, generateOptions: Record<string, unknown> = {}): Promise<unknown> {
      const prompt = typeof texts === 'string' ? texts : JSON.stringify(texts);
      const output = await this.model.generate({ input_ids: tensor(1, Math.ceil(prompt.length / 4)), max_new_tokens: 256, ...generateOptions });
      return [{ generated_text: `${prompt} -> ${output.dims.at(-1)} tokens` }];
    }
  }

  class FeatureExtractionPipeline extends Pipeline {
    override async _call(texts: unknown): Promise<FakeTensor> {
      const count = Array.isArray(texts) ? texts.length : 1;
      return tensor(count, 384);
    }
  }

  const module = { PreTrainedModel, AutoModelForCausalLM, Pipeline, TextGenerationPipeline, FeatureExtractionPipeline, env: {} };
  return {
    module,
    PreTrainedModel: PreTrainedModel as unknown as FakeModelClass,
    AutoModelForCausalLM: AutoModelForCausalLM as unknown as FakeModelClass,
    TextGenerationPipeline: TextGenerationPipeline as never,
    FeatureExtractionPipeline: FeatureExtractionPipeline as never,
  };
}

export interface FakeModel {
  generate(options: Record<string, unknown>): Promise<FakeTensor>;
  sessions: Record<string, { config: { device: string; dtype: string } }>;
}
export interface FakeModelClass {
  from_pretrained(id: string, options?: Record<string, unknown>): Promise<FakeModel>;
}
export type FakePipeline = ((input: unknown, options?: Record<string, unknown>) => Promise<unknown>) & { task: string };
export { tensor };
