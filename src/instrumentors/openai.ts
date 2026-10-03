/**
 * Instrumentor for the official `openai` package: Chat Completions (buffered
 * and streamed, tool calls), Embeddings and the Responses API.
 *
 * A port of `genai_otel/instrumentors/openai_instrumentor.py`: same span names,
 * same attributes, same usage mapping. Any OpenAI-compatible endpoint (vLLM,
 * llama.cpp server, LiteLLM, Ollama's /v1) is covered through the same client;
 * `server.address` / `server.port` record where the client actually points,
 * and a base URL claimed by a dedicated aggregator instrumentor is left to it.
 */
import type { Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { pyJsonDumps, pyStr, pyTruncate } from '../pycompat';
import { ATTR } from '../semconv';
import { BaseInstrumentor, clientBaseUrl, findBaseUrlClaim, type Params, type UsageDict } from './base';
import { exportedClass, loadModuleCopies, unwrapMethod, wrapMethod } from './patch';

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** `getattr(obj, key, default)`: the default only when the key is absent, not when it is null. */
function getattr(object: Obj, key: string, fallback: unknown): unknown {
  return key in object ? object[key] : fallback;
}

/**
 * Bound captured content to `contentMaxLength` (0 or unset: unlimited).
 * `undefined` for a null value, which is then left off the event - the
 * reference passes `None` to the SDK, which drops it.
 */
function capContent(config: OTelConfig | undefined, text: unknown): string | undefined {
  if (text === null || text === undefined) return undefined;
  const value = pyStr(text);
  const maxLength = config?.contentMaxLength ?? 0;
  return maxLength > 0 ? pyTruncate(value, maxLength) : value;
}

/** Event attributes without the undefined ones. */
function defined(attributes: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = value;
  return out;
}

/** Flatten a Responses content value (a string, or a list of typed parts) to plain text. */
function responsesContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

export class OpenAIInstrumentor extends BaseInstrumentor {
  private patched: [object, string][] = [];
  private stopListening: (() => void) | undefined;
  private readonly responsesPrototypes = new WeakSet<object>();

  /**
   * Patch every copy of `openai` that can be loaded. The CommonJS build is
   * patched before this returns; the returned promise settles once the
   * ES-module build is patched as well.
   */
  instrument(config: OTelConfig): Promise<void> {
    // Unlike the reference instrumentor (v1.30.0), which never sets its
    // configuration up and so ignores custom pricing.
    this.setupConfig(config);
    const copies = loadModuleCopies('openai');
    for (const module of copies.commonjs) this.patchModule(module);
    this.stopListening?.();
    this.stopListening = copies.whenLoaded((module) => this.patchModule(module));
    return copies.esm.then((modules) => {
      for (const module of modules) this.patchModule(module);
    });
  }

  /**
   * Instrument a given `openai` module (or anything exposing the `OpenAI`
   * class). For applications whose bundler makes the package unresolvable at
   * run time.
   */
  instrumentModule(module: unknown, config: OTelConfig): void {
    this.setupConfig(config);
    this.patchModule(module);
  }

  uninstrument(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    for (const [target, name] of this.patched) unwrapMethod(target, name);
    this.patched = [];
    this.instrumented = false;
  }

  private patchModule(module: unknown): void {
    try {
      const client = exportedClass(module, 'OpenAI') as
        | { Chat?: { Completions?: { prototype?: object } }; Embeddings?: { prototype?: object }; Responses?: { prototype?: object } }
        | undefined;
      if (!client) return;

      const targets: [object | undefined, string, string, (instance: unknown, args: unknown[], params: Params) => Obj][] = [
        [client.Chat?.Completions?.prototype, 'create', 'openai.chat.completion', (_i, _a, params) => this.chatAttributes(params)],
        // Embeddings are the retrieval half of a RAG call; without a span here
        // the lookup that selected the context is invisible.
        [client.Embeddings?.prototype, 'create', 'openai.embeddings', (_i, _a, params) => this.embeddingAttributes(params)],
        // The Responses API is the default path for the newer models.
        // Through an aggregator too: the span keeps this name and carries the vendor as its system
        // (SDK_ADDITIONS.md section 7), as no vendor instrumentor traces the Responses API.
        [
          client.Responses?.prototype,
          'create',
          'openai.responses',
          (instance, _a, params) => {
            const attributes = this.responsesAttributes(params);
            const vendor = findBaseUrlClaim(clientBaseUrl(instance));
            if (vendor) attributes[ATTR.GEN_AI_SYSTEM] = vendor;
            return attributes;
          },
        ],
      ];
      if (client.Responses?.prototype) this.responsesPrototypes.add(client.Responses.prototype);
      let found = false;
      for (const [prototype, method, spanName, extract] of targets) {
        if (!prototype) continue;
        found = true;
        if (wrapMethod(prototype, method, this.createSpanWrapper(spanName, extract))) this.patched.push([prototype, method]);
      }
      if (!found) return;
      this.instrumented = true;
      logger.info('OpenAI instrumentation enabled');
    } catch (error) {
      logger.error(`Failed to instrument OpenAI: ${String(error)}`);
      if (this.config?.failOnError) throw error;
    }
  }

  /**
   * A client pointed at an aggregator (OpenRouter, CometAPI) is traced by its
   * dedicated instrumentor; tracing it here too would emit a duplicate span and
   * double-count tokens and cost.
   */
  protected override shouldBypass(instance: unknown): boolean {
    if (typeof instance === 'object' && instance !== null && this.responsesPrototypes.has(Object.getPrototypeOf(instance) as object)) return false;
    const claimed = findBaseUrlClaim(clientBaseUrl(instance));
    if (claimed) logger.debug(`Skipping generic OpenAI instrumentation for client handled by the '${claimed}' instrumentor`);
    return claimed !== undefined;
  }

  // -------------------------------------------------------------------------
  // Request attributes
  // -------------------------------------------------------------------------

  private chatAttributes(params: Params): Obj {
    const attributes: Obj = {};
    const messages = Array.isArray(params.messages) ? params.messages : [];

    attributes[ATTR.GEN_AI_SYSTEM] = 'openai';
    attributes[ATTR.GEN_AI_REQUEST_MODEL] = params.model ?? 'unknown';
    attributes[ATTR.GEN_AI_OPERATION_NAME] = 'chat';
    attributes[ATTR.GEN_AI_REQUEST_MESSAGE_COUNT] = messages.length;

    for (const [key, attribute] of [
      ['temperature', ATTR.GEN_AI_REQUEST_TEMPERATURE],
      ['top_p', ATTR.GEN_AI_REQUEST_TOP_P],
      ['max_tokens', ATTR.GEN_AI_REQUEST_MAX_TOKENS],
      ['frequency_penalty', ATTR.GEN_AI_REQUEST_FREQUENCY_PENALTY],
      ['presence_penalty', ATTR.GEN_AI_REQUEST_PRESENCE_PENALTY],
    ] as const) {
      if (key in params) attributes[attribute] = params[key];
    }

    if ('tools' in params && params.tools !== undefined) {
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

  /**
   * How many texts an embeddings request covers. A list of integers is one
   * pre-tokenised input, not N inputs.
   */
  private static countEmbeddingInputs(value: unknown): number {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'string') return 1;
    if (Array.isArray(value)) {
      if (value.length === 0) return 0;
      if (value.every((item) => Number.isInteger(item))) return 1;
      return value.length;
    }
    return 1;
  }

  private embeddingAttributes(params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'openai',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
      [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
      // "embedding", singular, is the value the cost calculator dispatches on.
      // The pricing table's section is "embeddings"; the two deliberately differ.
      [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
      [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: OpenAIInstrumentor.countEmbeddingInputs(params.input),
    };
    this.addEmbeddingRequestAttributes(attributes, params.dimensions, params.encoding_format);
    return attributes;
  }

  /** Normalise a Responses `input` (a string, or a list of typed items) onto the chat `messages` shape. */
  private static responsesInputAsMessages(rawInput: unknown): { role: unknown; content: string }[] {
    if (rawInput === undefined || rawInput === null) return [];
    if (typeof rawInput === 'string') return [{ role: 'user', content: rawInput }];
    if (Array.isArray(rawInput)) {
      const messages: { role: unknown; content: string }[] = [];
      for (const item of rawInput) {
        if (isObject(item)) messages.push({ role: item.role ?? 'user', content: responsesContentToText(item.content ?? '') });
      }
      return messages;
    }
    return [];
  }

  private static countResponsesInput(rawInput: unknown): number {
    if (rawInput === undefined || rawInput === null) return 0;
    if (typeof rawInput === 'string') return 1;
    if (Array.isArray(rawInput)) return rawInput.length;
    return 1;
  }

  private responsesAttributes(params: Params): Obj {
    const attributes: Obj = {};
    const rawInput = params.input;

    attributes[ATTR.GEN_AI_SYSTEM] = 'openai';
    attributes[ATTR.GEN_AI_REQUEST_MODEL] = params.model ?? 'unknown';
    attributes[ATTR.GEN_AI_OPERATION_NAME] = 'chat';
    attributes[ATTR.GEN_AI_REQUEST_MESSAGE_COUNT] = OpenAIInstrumentor.countResponsesInput(rawInput);

    if (params.instructions) attributes[ATTR.GEN_AI_REQUEST_INSTRUCTIONS] = capContent(this.config, params.instructions);
    if ('temperature' in params) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = params.temperature;
    if ('top_p' in params) attributes[ATTR.GEN_AI_REQUEST_TOP_P] = params.top_p;
    // Responses spells the output cap `max_output_tokens`; the attribute stays `max_tokens`.
    if ('max_output_tokens' in params) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = params.max_output_tokens;

    if ('tools' in params && params.tools !== undefined) {
      try {
        attributes[ATTR.LLM_TOOLS] = pyJsonDumps(params.tools);
      } catch (error) {
        logger.debug(`Failed to serialize tools: ${String(error)}`);
      }
    }

    const firstMessage = this.buildFirstMessage(OpenAIInstrumentor.responsesInputAsMessages(rawInput));
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  protected override extractUsage(result: unknown): UsageDict | null {
    // A streamed Responses call reports its usage on the final event, inside
    // `response` (the reference reads only `event.usage`, and so records none).
    if (isObject(result) && result.type === 'response.completed' && isObject(result.response)) return this.extractUsage(result.response);
    if (!isObject(result) || !isObject(result.usage)) return null;
    const usage = result.usage;

    // The Responses API reports input_tokens/output_tokens where Chat
    // Completions reports prompt_tokens/completion_tokens. Map onto the
    // canonical keys.
    if ((usage.prompt_tokens === undefined || usage.prompt_tokens === null) && 'input_tokens' in usage) {
      const mapped: UsageDict = {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      };
      // Reasoning tokens are billed as output; attributed there, not as a separate bucket.
      const outputDetails = usage.output_tokens_details;
      const reasoning = isObject(outputDetails) ? outputDetails.reasoning_tokens : 0;
      if (reasoning) mapped.completion_tokens_details = { reasoning_tokens: reasoning };
      const inputDetails = usage.input_tokens_details;
      const cached = isObject(inputDetails) ? inputDetails.cached_tokens : undefined;
      if (cached) mapped.cache_read_input_tokens = cached;
      return mapped;
    }

    const mapped: UsageDict = {
      prompt_tokens: getattr(usage, 'prompt_tokens', 0),
      completion_tokens: getattr(usage, 'completion_tokens', 0),
      total_tokens: getattr(usage, 'total_tokens', 0),
    };

    // Reasoning tokens (o-series models).
    if (isObject(usage.completion_tokens_details)) {
      mapped.completion_tokens_details = {
        reasoning_tokens: getattr(usage.completion_tokens_details, 'reasoning_tokens', 0),
      };
    }
    // Prompt-cache reads: conceptually Anthropic's cache_read_input_tokens,
    // surfaced under the same canonical key.
    if (isObject(usage.prompt_tokens_details)) {
      const cached = usage.prompt_tokens_details.cached_tokens;
      if (cached) mapped.cache_read_input_tokens = cached;
    }
    OpenAIInstrumentor.collectModalityTokens(usage, mapped);
    return mapped;
  }

  /**
   * Per-modality token counts off the usage detail objects. Only counts the
   * provider actually reported are copied; a missing detail stays absent.
   */
  private static collectModalityTokens(usage: Obj, mapped: UsageDict): void {
    for (const [detailsKey, direction] of [
      ['prompt_tokens_details', 'input'],
      ['completion_tokens_details', 'output'],
    ] as const) {
      const details = usage[detailsKey];
      if (!isObject(details)) continue;
      for (const modality of ['text', 'image', 'audio']) {
        const value = details[`${modality}_tokens`];
        if (isNumber(value) && value > 0) mapped[`${modality}_${direction}_tokens`] = Math.trunc(value);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Response attributes
  // -------------------------------------------------------------------------

  /** The embedding items of a response, or null if it is not an embeddings response. */
  private static embeddingItems(result: unknown): Obj[] | null {
    const data = isObject(result) ? result.data : undefined;
    if (Array.isArray(data) && data.length > 0 && isObject(data[0]) && 'embedding' in data[0]) return data as Obj[];
    return null;
  }

  /**
   * The Responses `output` items, or null if not that shape. Checked against
   * `choices` first so a Chat Completions response is never read as one.
   */
  private static responsesOutputItems(result: unknown): Obj[] | null {
    if (!isObject(result)) return null;
    if (Array.isArray(result.choices) && result.choices.length > 0) return null;
    return Array.isArray(result.output) ? (result.output as Obj[]) : null;
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;

    if ('id' in result) attributes[ATTR.GEN_AI_RESPONSE_ID] = result.id;
    // The model actually used; may differ from the one requested.
    if ('model' in result) attributes[ATTR.GEN_AI_RESPONSE_MODEL] = result.model;

    // Embeddings responses carry vectors instead of choices. The count and the
    // dimension are what make a retrieval span diagnosable.
    const items = OpenAIInstrumentor.embeddingItems(result);
    if (items !== null) {
      attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = items.length;
      const first = items[0]?.embedding;
      if (Array.isArray(first) || typeof first === 'string') attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = first.length;
      return attributes;
    }

    // Responses carries output[] rather than choices[].
    const outputItems = OpenAIInstrumentor.responsesOutputItems(result);
    if (outputItems !== null) {
      const finishReason = this.extractFinishReason(result);
      if (finishReason) attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = [finishReason];
      let index = 0;
      for (const item of outputItems) {
        if (!isObject(item) || item.type !== 'function_call') continue;
        const prefix = `llm.output_messages.0.message.tool_calls.${index}`;
        const callId = item.call_id || item.id;
        if (callId) attributes[`${prefix}.tool_call.id`] = callId;
        if (item.name) attributes[`${prefix}.tool_call.function.name`] = item.name;
        if (item.arguments !== undefined && item.arguments !== null) {
          attributes[`${prefix}.tool_call.function.arguments`] = item.arguments;
        }
        index += 1;
      }
      return attributes;
    }

    if (Array.isArray(result.choices) && result.choices.length > 0) {
      const choices = result.choices as Obj[];
      const finishReasons = choices
        .filter((choice) => isObject(choice) && typeof choice.finish_reason === 'string')
        .map((choice) => choice.finish_reason as string);
      if (finishReasons.length > 0) attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = finishReasons;

      choices.forEach((choice, choiceIndex) => {
        const message = isObject(choice) ? choice.message : undefined;
        const toolCalls = isObject(message) ? message.tool_calls : undefined;
        if (!Array.isArray(toolCalls)) return;
        toolCalls.forEach((toolCall: unknown, toolIndex) => {
          if (!isObject(toolCall)) return;
          const prefix = `llm.output_messages.${choiceIndex}.message.tool_calls.${toolIndex}`;
          if ('id' in toolCall) attributes[`${prefix}.tool_call.id`] = toolCall.id;
          if (isObject(toolCall.function)) {
            if ('name' in toolCall.function) attributes[`${prefix}.tool_call.function.name`] = toolCall.function.name;
            if ('arguments' in toolCall.function) {
              attributes[`${prefix}.tool_call.function.arguments`] = toolCall.function.arguments;
            }
          }
        });
      });
    }
    return attributes;
  }

  protected override extractFinishReason(result: unknown): string | null {
    if (!isObject(result)) return null;
    if (Array.isArray(result.choices) && result.choices.length > 0) {
      const first: unknown = result.choices[0];
      if (isObject(first) && 'finish_reason' in first) return (first.finish_reason as string | null) ?? null;
    }
    // Responses reports a terminal `status`; when it stopped short,
    // `incomplete_details.reason` says why.
    const details = result.incomplete_details;
    if (isObject(details) && typeof details.reason === 'string' && details.reason) return details.reason;
    if (typeof result.status === 'string' && result.status) return result.status;
    return null;
  }

  // -------------------------------------------------------------------------
  // Content capture (only called when content capture is on)
  // -------------------------------------------------------------------------

  protected override addContentEvents(span: Span, result: unknown, params: Params): void {
    const config = this.config;

    // Embeddings and the Responses API both key on `input`, so the request
    // alone cannot tell them apart. Decide on the response shape.
    const messagesGiven = Array.isArray(params.messages) && params.messages.length > 0;
    if ('input' in params && !messagesGiven && OpenAIInstrumentor.embeddingItems(result) !== null) {
      this.addEmbeddingContent(span, result, params);
      return;
    }
    const outputItems = OpenAIInstrumentor.responsesOutputItems(result);
    if (outputItems !== null) {
      this.addResponsesContent(span, params, outputItems);
      return;
    }

    const messages = Array.isArray(params.messages) ? params.messages : [];
    messages.forEach((message: unknown, index) => {
      if (!isObject(message)) return;
      span.addEvent(
        `gen_ai.prompt.${index}`,
        defined({
          [ATTR.GEN_AI_PROMPT_ROLE]: String(message.role ?? 'unknown'),
          [ATTR.GEN_AI_PROMPT_CONTENT]: capContent(config, 'content' in message ? message.content : ''),
        }),
      );
    });

    if (isObject(result) && Array.isArray(result.choices) && result.choices.length > 0) {
      let responseText: string | undefined;
      (result.choices as unknown[]).forEach((choice, index) => {
        const message = isObject(choice) ? choice.message : undefined;
        if (!isObject(message) || !('content' in message)) return;
        const content = capContent(config, message.content);
        span.addEvent(
          `gen_ai.completion.${index}`,
          defined({ [ATTR.GEN_AI_COMPLETION_ROLE]: 'assistant', [ATTR.GEN_AI_COMPLETION_CONTENT]: content }),
        );
        if (index === 0) responseText = content;
      });
      if (responseText) span.setAttribute(ATTR.GEN_AI_RESPONSE, responseText);
    }
  }

  private addResponsesContent(span: Span, params: Params, outputItems: Obj[]): void {
    const config = this.config;
    if (params.instructions) {
      span.addEvent(
        'gen_ai.prompt.system',
        defined({ [ATTR.GEN_AI_PROMPT_ROLE]: 'system', [ATTR.GEN_AI_PROMPT_CONTENT]: capContent(config, params.instructions) }),
      );
    }
    OpenAIInstrumentor.responsesInputAsMessages(params.input).forEach((message, index) => {
      span.addEvent(
        `gen_ai.prompt.${index}`,
        defined({ [ATTR.GEN_AI_PROMPT_ROLE]: String(message.role), [ATTR.GEN_AI_PROMPT_CONTENT]: capContent(config, message.content) }),
      );
    });

    let responseText: string | undefined;
    let completionIndex = 0;
    for (const item of outputItems) {
      if (!isObject(item) || item.type !== 'message') continue;
      const text = responsesContentToText(item.content ?? '');
      if (!text) continue;
      const content = capContent(config, text);
      span.addEvent(
        `gen_ai.completion.${completionIndex}`,
        defined({ [ATTR.GEN_AI_COMPLETION_ROLE]: String(item.role ?? 'assistant'), [ATTR.GEN_AI_COMPLETION_CONTENT]: content }),
      );
      if (completionIndex === 0) responseText = content;
      completionIndex += 1;
    }
    if (responseText) span.setAttribute(ATTR.GEN_AI_RESPONSE, responseText);
  }

  /** The embedded text (and, only when asked for, the vector). */
  private addEmbeddingContent(span: Span, result: unknown, params: Params): void {
    const config = this.config;
    span.setAttribute(ATTR.EMBEDDING_MODEL_NAME, String(params.model ?? 'unknown'));

    const rawInput = params.input;
    let texts: string[] = [];
    if (typeof rawInput === 'string') texts = [rawInput];
    else if (Array.isArray(rawInput) && !rawInput.every((item) => Number.isInteger(item))) {
      texts = rawInput.filter((item): item is string => typeof item === 'string');
    }
    // Otherwise pre-tokenised input: there is no text to record.

    const first = texts[0];
    if (first !== undefined) {
      span.setAttribute(ATTR.EMBEDDING_TEXT, capContent(config, first) ?? '');
      texts.forEach((text, index) => {
        span.addEvent(`gen_ai.embedding.${index}`, defined({ [ATTR.GEN_AI_EMBEDDING_CONTENT]: capContent(config, text) }));
      });
    }

    // Vectors are large enough to dominate a span and are rarely wanted.
    if (config?.captureEmbeddingVectors) {
      const vector = OpenAIInstrumentor.embeddingItems(result)?.[0]?.embedding;
      if (Array.isArray(vector)) {
        span.setAttribute(ATTR.EMBEDDING_VECTOR, pyJsonDumps(vector));
        span.setAttribute(ATTR.EMBEDDING_VECTOR_DIMENSION, vector.length);
      }
    }
  }
}
