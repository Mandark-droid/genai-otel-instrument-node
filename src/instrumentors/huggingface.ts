/**
 * HuggingFace Inference (`@huggingface/inference`). The inference-client half
 * of `genai_otel/instrumentors/huggingface_instrumentor.py`: `chatCompletion`,
 * `textGeneration`, and `chatCompletionStream`.
 *
 * This client cannot be patched from outside. Its constructor defines every
 * task method on the instance as a non-configurable property, and the module's
 * exports are read-only. So the application wraps the client it creates:
 *
 *   const hf = traceHuggingFaceClient(new InferenceClient(token));
 *
 * The result behaves as the client does (`instanceof InferenceClient` holds);
 * the three methods above are traced once `instrument()` has run, and pass
 * straight through before that.
 */
import type { Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { ATTR } from '../semconv';
import { stateSlot } from '../state';
import { BaseInstrumentor, type Params, type UsageDict } from './base';
import { defined, isObject, type Obj } from './openai-shape';
import { pyStr, pyTruncate } from '../pycompat';

type AnyFunction = (...args: never[]) => unknown;

class HuggingFaceInferenceInstrumentor extends BaseInstrumentor {
  instrument(config: OTelConfig): void {
    this.setupConfig(config);
    this.instrumented = true;
  }

  uninstrument(): void {
    this.instrumented = false;
  }

  wrap<F extends AnyFunction>(spanName: string, original: F, streaming = false): F {
    return this.createSpanWrapper(spanName, (_instance, _args, params) => this.requestAttributes(params), { streaming })(original);
  }

  private cap(text: unknown): string | undefined {
    if (text === null || text === undefined) return undefined;
    const value = pyStr(text);
    const maxLength = this.config?.contentMaxLength ?? 0;
    return maxLength > 0 ? pyTruncate(value, maxLength) : value;
  }

  private requestAttributes(params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'huggingface',
      [ATTR.GEN_AI_REQUEST_MODEL]: String(params.model ?? 'unknown'),
      [ATTR.GEN_AI_OPERATION_NAME]: 'chat',
    };
    // textGeneration nests its sampling parameters, under the Hub's names.
    const nested = isObject(params.parameters) ? params.parameters : {};
    const maxTokens = params.max_tokens ?? nested.max_new_tokens;
    if (maxTokens !== undefined) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = maxTokens;
    const temperature = params.temperature ?? nested.temperature;
    if (temperature !== undefined) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = temperature;
    const topP = params.top_p ?? nested.top_p;
    if (topP !== undefined) attributes[ATTR.GEN_AI_REQUEST_TOP_P] = topP;

    const messages = Array.isArray(params.messages) ? params.messages : [];
    const prompt = params.prompt ?? params.inputs;
    let firstMessage: string | null = null;
    if (messages.length > 0) firstMessage = this.buildFirstMessage(messages);
    else if (prompt !== undefined) firstMessage = this.buildFirstMessage([{ role: 'user', content: String(prompt) }]);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    const usage = isObject(result) ? result.usage : undefined;
    if (!isObject(usage)) return null;
    const prompt = usage.prompt_tokens as number | null | undefined;
    const completion = usage.completion_tokens as number | null | undefined;
    if ((prompt === undefined || prompt === null) && (completion === undefined || completion === null)) return null;
    return {
      prompt_tokens: prompt || 0,
      completion_tokens: completion || 0,
      total_tokens: (usage.total_tokens as number | null | undefined) || (prompt || 0) + (completion || 0),
    };
  }

  protected override addContentEvents(span: Span, result: unknown, params: Params): void {
    const messages = Array.isArray(params.messages) ? params.messages : [];
    const prompt = params.prompt ?? params.inputs;
    if (messages.length > 0) {
      messages.forEach((message: unknown, index) => {
        if (!isObject(message)) return;
        span.addEvent(
          `gen_ai.prompt.${index}`,
          defined({ [ATTR.GEN_AI_PROMPT_ROLE]: String(message.role ?? 'unknown'), [ATTR.GEN_AI_PROMPT_CONTENT]: this.cap(message.content ?? '') }),
        );
      });
    } else if (prompt !== undefined) {
      span.addEvent('gen_ai.prompt.0', defined({ [ATTR.GEN_AI_PROMPT_ROLE]: 'user', [ATTR.GEN_AI_PROMPT_CONTENT]: this.cap(prompt) }));
    }

    let responseText: string | undefined;
    const completion = (text: unknown, index: number): void => {
      const content = this.cap(text);
      span.addEvent(
        `gen_ai.completion.${index}`,
        defined({ [ATTR.GEN_AI_COMPLETION_ROLE]: 'assistant', [ATTR.GEN_AI_COMPLETION_CONTENT]: content }),
      );
      if (index === 0) responseText = content;
    };
    if (isObject(result) && Array.isArray(result.choices) && result.choices.length > 0) {
      (result.choices as unknown[]).forEach((choice, index) => {
        const message = isObject(choice) ? choice.message : undefined;
        if (isObject(message) && 'content' in message) completion(message.content, index);
      });
    } else if (isObject(result) && 'generated_text' in result) {
      completion(result.generated_text, 0);
    }
    if (responseText) span.setAttribute(ATTR.GEN_AI_RESPONSE, responseText);
  }
}

const SLOT = 'huggingface.inference';

/** The one instrumentor every traced client reports through. Registered under the reference name `transformers`. */
export function huggingFaceInferenceInstrumentor(): HuggingFaceInferenceInstrumentor {
  return stateSlot(SLOT, () => new HuggingFaceInferenceInstrumentor());
}

const TRACED: readonly (readonly [string, string, boolean])[] = [
  ['chatCompletion', 'huggingface.inference.chat_completion', false],
  ['chatCompletionStream', 'huggingface.inference.chat_completion', true],
  ['textGeneration', 'huggingface.inference.text_generation', false],
];

/**
 * A view of an `InferenceClient` whose chat and text-generation calls are
 * traced. The client itself is not modified.
 */
export function traceHuggingFaceClient<T extends object>(client: T): T {
  const instrumentor = huggingFaceInferenceInstrumentor();
  // The client's own methods are non-configurable, so a Proxy could not replace
  // them; an object that inherits from the client and shadows them can.
  const traced = Object.create(client) as T;
  for (const [method, spanName, streaming] of TRACED) {
    const original = (client as Record<string, unknown>)[method];
    if (typeof original !== 'function') continue;
    Object.defineProperty(traced, method, {
      enumerable: false,
      configurable: true,
      value: instrumentor.wrap(spanName, (original as AnyFunction).bind(client), streaming),
    });
  }
  return traced;
}
