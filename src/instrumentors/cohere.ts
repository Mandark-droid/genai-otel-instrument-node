/**
 * Instrumentor for `cohere-ai`. A port of `genai_otel/instrumentors/cohere_instrumentor.py`
 * (`generate`, `embed`), plus `chat` and `chatStream` on both client
 * generations - which the reference does not trace, and without which a current
 * Cohere application would be invisible: `generate` is the legacy endpoint.
 *
 * The JavaScript client returns camelCase fields; both spellings are read.
 */
import { ATTR } from '../semconv';
import type { Params, StreamTiming, UsageDict } from './base';
import { countEmbeddingInputs, isObject, OpenAIShapeInstrumentor, pick, type Obj } from './openai-shape';
import { exportedClass, prototypeDefining } from './patch';
import type { PatchTarget } from './patching';

function tokenUsage(tokens: unknown): UsageDict | null {
  const input = pick(tokens, 'inputTokens', 'input_tokens');
  const output = pick(tokens, 'outputTokens', 'output_tokens');
  if (!input && !output) return null;
  const prompt = input ? Math.trunc(Number(input)) : 0;
  const completion = output ? Math.trunc(Number(output)) : 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export class CohereInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Cohere';
  protected readonly packages = ['cohere-ai'];

  protected targets(module: unknown): PatchTarget[] {
    const Client = exportedClass(module, 'CohereClient') as (new (options: Record<string, unknown>) => Obj) | undefined;
    if (typeof Client !== 'function') return [];
    const targets: PatchTarget[] = [];
    const add = (holder: object | undefined): void => {
      if (!holder) return;
      targets.push(
        { holder, method: 'generate', spanName: 'cohere.generate', attributes: (_i, _a, params) => this.generateAttributes(params) },
        { holder, method: 'embed', spanName: 'cohere.embeddings', attributes: (_i, _a, params) => this.embeddingAttributes(params) },
        { holder, method: 'chat', spanName: 'cohere.chat', attributes: (_i, _a, params) => this.chatAttributes(params) },
        {
          holder,
          method: 'chatStream',
          spanName: 'cohere.chat',
          attributes: (_i, _a, params) => this.chatAttributes(params),
          options: { streaming: true },
        },
      );
    };
    // v1 methods live on a base class of CohereClient.
    add(prototypeDefining(Client, 'chat'));
    // The v2 client class is not exported; reach it through an instance.
    // Constructing a client opens no connection.
    try {
      const v2 = new Client({ token: 'instrumentation-probe' }).v2;
      const prototype = prototypeDefining(v2, 'chat');
      if (prototype && !targets.some((target) => target.holder === prototype)) add(prototype);
    } catch {
      // an older client without v2
    }
    return targets;
  }

  private generateAttributes(params: Params): Obj {
    const prompt = params.prompt ?? '';
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'cohere',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'command',
      [ATTR.GEN_AI_OPERATION_NAME]: 'generate',
      [ATTR.GEN_AI_REQUEST_MESSAGE_COUNT]: prompt ? 1 : 0,
    };
    if (prompt) {
      const firstMessage = this.buildFirstMessage([{ role: 'user', content: String(prompt) }]);
      if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    }
    return attributes;
  }

  private embeddingAttributes(params: Params): Obj {
    return {
      [ATTR.GEN_AI_SYSTEM]: 'cohere',
      [ATTR.GEN_AI_REQUEST_MODEL]: String(params.model || 'unknown'),
      [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
      [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: countEmbeddingInputs(params.texts ?? params.text),
    };
  }

  /** v1 sends one `message` (plus `chatHistory`); v2 sends `messages`. */
  private chatAttributes(params: Params): Obj {
    const messages: unknown[] = Array.isArray(params.messages)
      ? params.messages
      : params.message
        ? [{ role: 'user', content: String(params.message) }]
        : [];
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'cohere',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
      [ATTR.GEN_AI_OPERATION_NAME]: 'chat',
      [ATTR.GEN_AI_REQUEST_MESSAGE_COUNT]: messages.length,
    };
    const temperature = pick(params, 'temperature');
    if (temperature !== undefined) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = temperature;
    const maxTokens = pick(params, 'maxTokens', 'max_tokens');
    if (maxTokens !== undefined) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = maxTokens;
    const firstMessage = this.buildFirstMessage(messages);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  /**
   * `meta.tokens` where present, else `meta.billed_units` (the reference's
   * order). The v2 chat response carries the same pair under `usage`.
   */
  protected extractUsage(result: unknown): UsageDict | null {
    if (!isObject(result)) return null;
    const meta = isObject(result.meta) ? result.meta : isObject(result.usage) ? result.usage : undefined;
    if (!meta) return null;
    if (isObject(meta.tokens)) return tokenUsage(meta.tokens);
    const billed = pick(meta, 'billedUnits', 'billed_units');
    return isObject(billed) ? tokenUsage(billed) : null;
  }

  /** The final stream event carries the whole response (v1: `response`; v2: `delta.usage`). */
  protected override accumulateStreamUsage(timing: StreamTiming, chunk: unknown): void {
    if (!isObject(chunk)) return;
    const usage =
      this.extractUsage(chunk.response) ?? (isObject(chunk.delta) ? this.extractUsage({ usage: chunk.delta.usage }) : null);
    if (usage) timing.usage = usage;
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;

    const generations = result.generations;
    if (Array.isArray(generations) && generations.length > 0) {
      const first: unknown = generations[0];
      if (isObject(first) && first.text) attributes[ATTR.GEN_AI_RESPONSE] = this.capContent(first.text);
    }

    let vectors: unknown;
    const embeddings = result.embeddings;
    if (isObject(embeddings) && !Array.isArray(embeddings) && 'float' in embeddings) vectors = embeddings.float;
    else if (embeddings !== undefined && embeddings !== null) vectors = embeddings;
    else if ('embedding' in result && result.embedding !== undefined) vectors = [result.embedding];
    if (Array.isArray(vectors)) {
      attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = vectors.length;
      if (Array.isArray(vectors[0])) attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = vectors[0].length;
    }

    // Chat responses.
    const id = pick(result, 'id', 'responseId', 'response_id');
    if (id !== undefined && ('text' in result || 'message' in result)) attributes[ATTR.GEN_AI_RESPONSE_ID] = id;
    return attributes;
  }

  protected override extractFinishReason(result: unknown): string | null {
    const reason = pick(result, 'finishReason', 'finish_reason');
    return typeof reason === 'string' ? reason : null;
  }
}
