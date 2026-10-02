/**
 * Instrumentor for `@mistralai/mistralai`. A port of
 * `genai_otel/instrumentors/mistralai_instrumentor.py`: `chat.complete`,
 * `chat.stream` and `embeddings.create`.
 *
 * As in the reference, the span name carries the model
 * (`mistralai.chat.complete mistral-small-latest`). The JavaScript client
 * spells request and response fields in camelCase; both spellings are read.
 */
import { ATTR } from '../semconv';
import type { Params, StreamTiming, UsageDict } from './base';
import { isObject, OpenAIShapeInstrumentor, pick, type Obj } from './openai-shape';
import { exportedClass, prototypeDefining } from './patch';
import type { PatchTarget } from './patching';

export class MistralInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'MistralAI';
  protected readonly packages = ['@mistralai/mistralai'];

  protected targets(module: unknown): PatchTarget[] {
    const Client = exportedClass(module, 'Mistral') as (new (options: Record<string, unknown>) => Obj) | undefined;
    if (typeof Client !== 'function') return [];
    // The resource classes (Chat, Embeddings) are not exported; reach them
    // through an instance. Constructing a client opens no connection.
    let client: Obj;
    try {
      client = new Client({ apiKey: 'instrumentation-probe' });
    } catch {
      return [];
    }
    const chat = prototypeDefining(client.chat, 'complete');
    const embeddings = prototypeDefining(client.embeddings, 'create');
    return [
      {
        holder: chat,
        method: 'complete',
        attributes: (_instance, _args, params) => this.chatAttributes(params),
        options: { spanName: (params) => `mistralai.chat.complete ${String(params.model ?? 'mistral-small-latest')}` },
      },
      {
        holder: chat,
        method: 'stream',
        attributes: (_instance, _args, params) => this.chatAttributes(params),
        options: { streaming: true, spanName: (params) => `mistralai.chat.stream ${String(params.model ?? 'mistral-small-latest')}` },
      },
      {
        holder: embeddings,
        method: 'create',
        attributes: (_instance, _args, params) => ({
          [ATTR.GEN_AI_SYSTEM]: 'mistralai',
          [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'mistral-embed',
          [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
        }),
        options: { spanName: (params) => `mistralai.embeddings.create ${String(params.model ?? 'mistral-embed')}` },
      },
    ];
  }

  private chatAttributes(params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'mistralai',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'chat',
    };
    const temperature = pick(params, 'temperature');
    if (temperature !== undefined) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = temperature;
    const topP = pick(params, 'topP', 'top_p');
    if (topP !== undefined) attributes[ATTR.GEN_AI_REQUEST_TOP_P] = topP;
    const maxTokens = pick(params, 'maxTokens', 'max_tokens');
    if (maxTokens !== undefined) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = maxTokens;
    const messages = Array.isArray(params.messages) ? params.messages : [];
    if (messages.length > 0) {
      const firstMessage = this.buildFirstMessage(messages);
      if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    }
    return attributes;
  }

  private static usageOf(holder: unknown): UsageDict | null {
    const usage = isObject(holder) ? holder.usage : undefined;
    if (!isObject(usage)) return null;
    return {
      prompt_tokens: pick(usage, 'promptTokens', 'prompt_tokens') ?? 0,
      completion_tokens: pick(usage, 'completionTokens', 'completion_tokens') ?? 0,
      total_tokens: pick(usage, 'totalTokens', 'total_tokens') ?? 0,
    };
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return MistralInstrumentor.usageOf(result);
  }

  /** A streamed event wraps the chunk in `data`; usage rides on the last one. */
  protected override accumulateStreamUsage(timing: StreamTiming, chunk: unknown): void {
    const usage = MistralInstrumentor.usageOf(isObject(chunk) ? chunk.data : undefined);
    if (usage && Number(usage.total_tokens) > 0) timing.usage = usage;
  }

  /** The reference records the response text on every span. */
  protected override extractResponseAttributes(result: unknown): Obj {
    return this.chatResponseAttributes(result, { responseText: true });
  }
}
