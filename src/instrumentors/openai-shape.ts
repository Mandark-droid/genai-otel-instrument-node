/**
 * What the instrumentors for OpenAI-shaped APIs have in common.
 *
 * A dozen providers speak the Chat Completions dialect - `messages` in,
 * `choices` and `usage` out - through their own client or through the `openai`
 * one. The reference library has one instrumentor per provider, each a slight
 * variant of the same extraction; the variants are kept (which request
 * parameters, whether tool calls or the response text are recorded), the
 * extraction is written once here.
 */
import type { Span } from '@opentelemetry/api';
import { logger } from '../logger';
import { pyJsonDumps, pyStr, pyTruncate } from '../pycompat';
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { PatchingInstrumentor } from './patching';

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/** `getattr(obj, key, default)`: the default only when the key is absent, not when it is null. */
export function getattr(object: Obj, key: string, fallback: unknown): unknown {
  return key in object ? object[key] : fallback;
}

/** Event attributes without the undefined ones. */
export function defined(attributes: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = value;
  return out;
}

/** The three request parameters every variant records. */
export const BASIC_PARAMS = [
  ['temperature', ATTR.GEN_AI_REQUEST_TEMPERATURE],
  ['top_p', ATTR.GEN_AI_REQUEST_TOP_P],
  ['max_tokens', ATTR.GEN_AI_REQUEST_MAX_TOKENS],
] as const;

export const PENALTY_PARAMS = [
  ['frequency_penalty', ATTR.GEN_AI_REQUEST_FREQUENCY_PENALTY],
  ['presence_penalty', ATTR.GEN_AI_REQUEST_PRESENCE_PENALTY],
] as const;

export interface ChatAttributeOptions {
  system: string;
  params?: readonly (readonly [string, string])[];
  /** `llm.tools`: the tool definitions as JSON. */
  tools?: boolean;
  firstMessage?: boolean;
}

export interface ResponseAttributeOptions {
  id?: boolean;
  model?: boolean;
  finishReasons?: boolean;
  toolCalls?: boolean;
  embeddings?: boolean;
  /** `gen_ai.response`: the first choice's text, bounded. Some reference instrumentors record it always. */
  responseText?: boolean;
  /** Anthropic-shaped `stop_reason`, where the provider also fronts that dialect. */
  stopReason?: boolean;
}

/** How many texts an embeddings request covers. A list of integers is one pre-tokenised input. */
export function countEmbeddingInputs(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return 1;
  if (Array.isArray(value)) {
    if (value.length === 0) return 0;
    if (value.every((item) => Number.isInteger(item))) return 1;
    return value.length;
  }
  return 1;
}

/** The embedding items of a response, or null if it is not an embeddings response. */
export function embeddingItems(result: unknown): Obj[] | null {
  const data = isObject(result) ? result.data : undefined;
  if (Array.isArray(data) && data.length > 0 && isObject(data[0]) && 'embedding' in data[0]) return data as Obj[];
  return null;
}

/** `prompt_tokens` / `completion_tokens` / `total_tokens`, absent keys as 0. null without a usage object. */
export function basicUsage(result: unknown): UsageDict | null {
  if (!isObject(result) || !isObject(result.usage)) return null;
  const usage = result.usage;
  return {
    prompt_tokens: getattr(usage, 'prompt_tokens', 0),
    completion_tokens: getattr(usage, 'completion_tokens', 0),
    total_tokens: getattr(usage, 'total_tokens', 0),
  };
}

/** `basicUsage` plus reasoning tokens where the provider itemises them. */
export function reasoningUsage(result: unknown): UsageDict | null {
  const mapped = basicUsage(result);
  if (!mapped) return null;
  const details = ((result as Obj).usage as Obj).completion_tokens_details;
  if (isObject(details)) mapped.completion_tokens_details = { reasoning_tokens: getattr(details, 'reasoning_tokens', 0) };
  return mapped;
}

export abstract class OpenAIShapeInstrumentor extends PatchingInstrumentor {
  /** Bound captured content to `contentMaxLength` (0: unlimited). `undefined` for a null value. */
  protected capContent(text: unknown): string | undefined {
    if (text === null || text === undefined) return undefined;
    const value = pyStr(text);
    const maxLength = this.config?.contentMaxLength ?? 0;
    return maxLength > 0 ? pyTruncate(value, maxLength) : value;
  }

  protected chatRequestAttributes(params: Params, options: ChatAttributeOptions): Obj {
    const attributes: Obj = {};
    const messages = Array.isArray(params.messages) ? params.messages : [];
    attributes[ATTR.GEN_AI_SYSTEM] = options.system;
    attributes[ATTR.GEN_AI_REQUEST_MODEL] = params.model ?? 'unknown';
    attributes[ATTR.GEN_AI_OPERATION_NAME] = 'chat';
    attributes[ATTR.GEN_AI_REQUEST_MESSAGE_COUNT] = messages.length;
    for (const [key, attribute] of options.params ?? BASIC_PARAMS) {
      if (key in params) attributes[attribute] = params[key];
    }
    if (options.tools && 'tools' in params && params.tools !== undefined) {
      try {
        attributes[ATTR.LLM_TOOLS] = pyJsonDumps(params.tools);
      } catch (error) {
        logger.debug(`Failed to serialize tools: ${String(error)}`);
      }
    }
    if (options.firstMessage ?? true) {
      const firstMessage = this.buildFirstMessage(messages);
      if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    }
    return attributes;
  }

  protected embeddingRequestAttributes(params: Params, system: string, withFormat = true): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: system,
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
      [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
      // "embedding", singular, is the value the cost calculator dispatches on.
      [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
      [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: countEmbeddingInputs(params.input),
    };
    if (withFormat) this.addEmbeddingRequestAttributes(attributes, params.dimensions, params.encoding_format);
    return attributes;
  }

  protected chatResponseAttributes(result: unknown, options: ResponseAttributeOptions): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    if (options.id && 'id' in result) attributes[ATTR.GEN_AI_RESPONSE_ID] = result.id;
    if (options.model && 'model' in result) attributes[ATTR.GEN_AI_RESPONSE_MODEL] = result.model;

    if (options.embeddings) {
      const items = embeddingItems(result);
      if (items !== null) {
        attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = items.length;
        const first = items[0]?.embedding;
        if (Array.isArray(first) || typeof first === 'string') attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = first.length;
        return attributes;
      }
    }

    if (Array.isArray(result.choices) && result.choices.length > 0) {
      const choices = result.choices as unknown[];
      if (options.finishReasons) {
        const finishReasons = choices
          .filter((choice): choice is Obj => isObject(choice) && typeof choice.finish_reason === 'string')
          .map((choice) => choice.finish_reason as string);
        if (finishReasons.length > 0) attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = finishReasons;
      }
      if (options.toolCalls) {
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
      if (options.responseText) {
        const first = choices[0];
        const message = isObject(first) ? first.message : undefined;
        const content = isObject(message) ? message.content : undefined;
        if (content) attributes[ATTR.GEN_AI_RESPONSE] = this.capContent(content);
      }
    } else if (options.stopReason && result.stop_reason) {
      attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = [result.stop_reason];
    }
    return attributes;
  }

  /** The first choice's finish reason; an Anthropic-shaped `stop_reason` when asked to look for one. */
  protected firstFinishReason(result: unknown, stopReason = false): string | null {
    if (!isObject(result)) return null;
    if (Array.isArray(result.choices) && result.choices.length > 0) {
      const first: unknown = result.choices[0];
      if (isObject(first) && 'finish_reason' in first) return (first.finish_reason as string | null) ?? null;
    }
    if (stopReason && typeof result.stop_reason === 'string' && result.stop_reason) return result.stop_reason;
    return null;
  }

  /** Prompt and completion events, and `gen_ai.response`. Only called with content capture on. */
  protected chatContentEvents(span: Span, result: unknown, params: Params): void {
    const messagesGiven = Array.isArray(params.messages) && params.messages.length > 0;
    if ('input' in params && !messagesGiven) {
      this.embeddingContent(span, result, params);
      return;
    }
    const messages = Array.isArray(params.messages) ? params.messages : [];
    messages.forEach((message: unknown, index) => {
      if (!isObject(message)) return;
      span.addEvent(
        `gen_ai.prompt.${index}`,
        defined({
          [ATTR.GEN_AI_PROMPT_ROLE]: String(message.role ?? 'unknown'),
          [ATTR.GEN_AI_PROMPT_CONTENT]: this.capContent('content' in message ? message.content : ''),
        }),
      );
    });

    let responseText: string | undefined;
    const record = (text: unknown, index: number): void => {
      const content = this.capContent(text);
      span.addEvent(
        `gen_ai.completion.${index}`,
        defined({ [ATTR.GEN_AI_COMPLETION_ROLE]: 'assistant', [ATTR.GEN_AI_COMPLETION_CONTENT]: content }),
      );
      if (index === 0) responseText = content;
    };
    if (isObject(result) && Array.isArray(result.choices) && result.choices.length > 0) {
      (result.choices as unknown[]).forEach((choice, index) => {
        const message = isObject(choice) ? choice.message : undefined;
        if (isObject(message) && 'content' in message) record(message.content, index);
      });
    } else if (isObject(result) && Array.isArray(result.content)) {
      // An Anthropic-shaped response.
      (result.content as unknown[]).forEach((block, index) => {
        if (isObject(block) && 'text' in block) record(block.text, index);
      });
    }
    if (responseText) span.setAttribute(ATTR.GEN_AI_RESPONSE, responseText);
  }

  /** The embedded text and, only when asked for, the vector. */
  protected embeddingContent(span: Span, result: unknown, params: Params): void {
    span.setAttribute(ATTR.EMBEDDING_MODEL_NAME, String(params.model ?? 'unknown'));
    const rawInput = params.input;
    let texts: string[] = [];
    if (typeof rawInput === 'string') texts = [rawInput];
    else if (Array.isArray(rawInput) && !rawInput.every((item) => Number.isInteger(item))) {
      texts = rawInput.filter((item): item is string => typeof item === 'string');
    }
    const first = texts[0];
    if (first !== undefined) {
      span.setAttribute(ATTR.EMBEDDING_TEXT, this.capContent(first) ?? '');
      texts.forEach((text, index) => {
        span.addEvent(`gen_ai.embedding.${index}`, defined({ [ATTR.GEN_AI_EMBEDDING_CONTENT]: this.capContent(text) }));
      });
    }
    if (this.config?.captureEmbeddingVectors) {
      const vector = embeddingItems(result)?.[0]?.embedding;
      if (Array.isArray(vector)) {
        try {
          span.setAttribute(ATTR.EMBEDDING_VECTOR, pyJsonDumps(vector));
          span.setAttribute(ATTR.EMBEDDING_VECTOR_DIMENSION, vector.length);
        } catch (error) {
          logger.debug(`Failed to serialize embedding vector: ${String(error)}`);
        }
      }
    }
  }
}
