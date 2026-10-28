/**
 * Instrumentor for `cactus-react-native`: a language model running on the
 * phone. JavaScript only; there is no Python counterpart.
 *
 * `CactusLM.complete()` already measures what matters on the device - tokens
 * in and out, time to first token, decode speed, memory - and reports it in
 * its result. This puts those numbers on a span, in the same attributes a
 * server-side call uses, so an on-device chat reads like any other.
 *
 * The application hands the classes over, as nothing can be looked up by name
 * in React Native:
 *
 *   import { CactusLM, CactusSTT } from 'cactus-react-native';
 *   instrumentCactus({ CactusLM, CactusSTT });
 */
import type { AttributeValue, Span } from '@opentelemetry/api';
import { logger } from '../logger';
import { pyJsonDumps } from '../pycompat';
import { OPENINFERENCE_SPAN_KIND } from '../openinference';
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { PatchingInstrumentor, type PatchTarget } from './patching';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const SYSTEM = 'cactus';

/** The model as the application named it; the file name on disk (with its quantisation) goes in `cactus.model_file`. */
function modelOf(instance: unknown): string {
  return isObject(instance) && typeof instance.model === 'string' && instance.model ? instance.model : 'unknown';
}

function modelFile(instance: unknown): string | undefined {
  if (!isObject(instance) || typeof instance.getModelName !== 'function') return undefined;
  try {
    const name: unknown = (instance.getModelName as () => unknown).call(instance);
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

export class CactusInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'cactus-react-native';
  protected readonly packages = ['cactus-react-native'];
  protected override get owner(): string {
    return SYSTEM;
  }

  /** The call being recorded; set and read synchronously. */
  private recording: Params | undefined;

  protected targets(module: unknown): PatchTarget[] {
    if (!isObject(module)) return [];
    const targets: PatchTarget[] = [];
    const base = (instance: unknown, operation: string): Record<string, AttributeValue | undefined> => ({
      [ATTR.GEN_AI_SYSTEM]: SYSTEM,
      [ATTR.GEN_AI_PROVIDER_NAME]: SYSTEM,
      [ATTR.GEN_AI_REQUEST_MODEL]: modelOf(instance),
      [ATTR.GEN_AI_OPERATION_NAME]: operation,
      'cactus.model_file': modelFile(instance),
      // Downloading and loading weights are steps, not model calls.
      [OPENINFERENCE_SPAN_KIND]: 'CHAIN',
    });
    // The engine calls init() before every completion and transcription; on a loaded model it is a
    // no-op and gets no span of its own.
    const skipWhenLoaded =
      (traced: (original: AnyFunction) => AnyFunction) =>
      (original: AnyFunction): AnyFunction => {
        const wrapped = traced(original);
        return function (this: unknown, ...args: unknown[]) {
          const loaded = isObject(this) && this.isInitialized === true;
          return ((loaded ? original : wrapped) as (...a: unknown[]) => unknown).apply(this, args);
        } as AnyFunction;
      };

    for (const [className, completion, spanPrefix] of [
      ['CactusLM', 'complete', 'cactus'],
      ['CactusSTT', 'transcribe', 'cactus.stt'],
    ] as const) {
      const exported = module[className];
      if (typeof exported !== 'function') continue;
      const prototype = (exported as { prototype: object }).prototype;
      targets.push(
        {
          holder: prototype,
          method: 'download',
          wrap: this.operationWrapper(`${spanPrefix}.download`, (instance) => base(instance, 'download_model')),
        },
        {
          holder: prototype,
          method: 'init',
          wrap: skipWhenLoaded(this.operationWrapper(`${spanPrefix}.init`, (instance) => base(instance, 'load_model'))),
        },
        {
          holder: prototype,
          method: completion,
          spanName: `${spanPrefix}.${completion}`,
          attributes: (instance, _args, params) =>
            completion === 'complete' ? this.completeAttributes(instance, params) : this.transcribeAttributes(instance, params),
          options: { params: (args) => ({ ...(isObject(args[0]) ? args[0] : {}), __kind: completion }) },
        },
      );
      if (className === 'CactusLM') {
        targets.push({
          holder: prototype,
          method: 'embed',
          spanName: 'cactus.embed',
          attributes: (instance) => ({
            ...base(instance, 'embeddings'),
            [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
            [OPENINFERENCE_SPAN_KIND]: 'EMBEDDING',
            [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: 1,
          }),
          options: { params: (args) => ({ ...(isObject(args[0]) ? args[0] : {}), __kind: 'embed' }) },
        });
      }
    }
    return targets;
  }

  private requestOptions(attributes: Obj, params: Params): void {
    const options = isObject(params.options) ? params.options : {};
    if (isNumber(options.temperature)) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = options.temperature;
    if (isNumber(options.topP)) attributes[ATTR.GEN_AI_REQUEST_TOP_P] = options.topP;
    if (isNumber(options.maxTokens)) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = options.maxTokens;
  }

  private completeAttributes(instance: unknown, params: Params): Obj {
    const messages = Array.isArray(params.messages) ? params.messages : [];
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: SYSTEM,
      [ATTR.GEN_AI_REQUEST_MODEL]: modelOf(instance),
      [ATTR.GEN_AI_OPERATION_NAME]: 'chat',
      [OPENINFERENCE_SPAN_KIND]: 'LLM',
      [ATTR.GEN_AI_REQUEST_MESSAGE_COUNT]: messages.length,
    };
    const file = modelFile(instance);
    if (file) attributes['cactus.model_file'] = file;
    this.requestOptions(attributes, params);
    if (Array.isArray(params.tools) && params.tools.length > 0) {
      try {
        attributes[ATTR.LLM_TOOLS] = pyJsonDumps(params.tools);
      } catch (error) {
        logger.debug(`Failed to serialize tools: ${String(error)}`);
      }
    }
    const firstMessage = this.buildFirstMessage(messages);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  private transcribeAttributes(instance: unknown, params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: SYSTEM,
      [ATTR.GEN_AI_REQUEST_MODEL]: modelOf(instance),
      [ATTR.GEN_AI_OPERATION_NAME]: 'speech_to_text',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'speech_to_text',
      [OPENINFERENCE_SPAN_KIND]: 'LLM',
    };
    const file = modelFile(instance);
    if (file) attributes['cactus.model_file'] = file;
    this.requestOptions(attributes, params);
    return attributes;
  }

  /** The engine reports a failed completion in its result rather than by throwing. */
  protected override resultFailure(result: unknown): string | undefined {
    if (!isObject(result) || result.success !== false) return undefined;
    return typeof result.response === 'string' && result.response ? result.response : 'the engine reported failure';
  }

  /** Counted by the engine: prompt tokens prefilled, tokens decoded. */
  protected extractUsage(result: unknown): UsageDict | null {
    if (!isObject(result) || !isNumber(result.prefillTokens) || !isNumber(result.decodeTokens)) return null;
    if (result.prefillTokens === 0 && result.decodeTokens === 0) return null;
    return {
      prompt_tokens: result.prefillTokens,
      completion_tokens: result.decodeTokens,
      total_tokens: isNumber(result.totalTokens) ? result.totalTokens : result.prefillTokens + result.decodeTokens,
    };
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    if (this.recording?.__kind === 'embed') {
      if (Array.isArray(result.embedding)) {
        attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = 1;
        attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = result.embedding.length;
      }
      return attributes;
    }
    // What only a device can say. Each is written when the engine reported it.
    if (isNumber(result.decodeTps) && result.decodeTps > 0) attributes['cactus.decode_tps'] = result.decodeTps;
    if (isNumber(result.prefillTps) && result.prefillTps > 0) attributes['cactus.prefill_tps'] = result.prefillTps;
    if (isNumber(result.ramUsageMb)) attributes['cactus.ram_usage_mb'] = result.ramUsageMb;
    if (typeof result.cloudHandoff === 'boolean') attributes['cactus.cloud_handoff'] = result.cloudHandoff;
    if (isNumber(result.confidence)) attributes['cactus.confidence'] = result.confidence;

    if (Array.isArray(result.functionCalls)) {
      (result.functionCalls as unknown[]).forEach((call, index) => {
        if (!isObject(call)) return;
        const prefix = `llm.output_messages.0.message.tool_calls.${index}`;
        if (call.name) attributes[`${prefix}.tool_call.function.name`] = call.name;
        if (call.arguments !== undefined) {
          try {
            attributes[`${prefix}.tool_call.function.arguments`] =
              typeof call.arguments === 'string' ? call.arguments : pyJsonDumps(call.arguments);
          } catch {
            // arguments that cannot be serialised are left off
          }
        }
      });
    }
    return attributes;
  }

  protected override recordResultMetrics(span: Span, spanName: string, result: unknown, startTime: number, params: Params): void {
    this.recording = params;
    try {
      super.recordResultMetrics(span, spanName, result, startTime, params);
    } finally {
      this.recording = undefined;
    }
    if (params.__kind === 'embed' || !isObject(result)) return;
    try {
      // The engine timed the first token itself; that is the number to trust.
      if (isNumber(result.timeToFirstTokenMs) && result.timeToFirstTokenMs > 0) {
        const model = String((span as unknown as { attributes?: Obj }).attributes?.[ATTR.GEN_AI_REQUEST_MODEL] ?? 'unknown');
        const ttft = result.timeToFirstTokenMs / 1000;
        this.recordTimeToFirstToken(span, spanName, ttft, model);
        if (isNumber(result.totalTimeMs) && result.totalTimeMs > 0) {
          this.recordTimePerOutputToken(span, spanName, ttft, result.totalTimeMs / 1000, result.decodeTokens, model);
        }
      }
      if (this.config?.enableContentCapture && typeof result.response === 'string' && result.response) {
        const maxLength = this.config.contentMaxLength ?? 0;
        span.setAttribute(ATTR.GEN_AI_RESPONSE, maxLength > 0 ? [...result.response].slice(0, maxLength).join('') : result.response);
      }
    } catch (error) {
      logger.debug(`Failed to record cactus timings: ${String(error)}`);
    }
  }
}
