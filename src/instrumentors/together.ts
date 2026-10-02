/**
 * Instrumentor for `together-ai`. A port of `genai_otel/instrumentors/togetherai_instrumentor.py`:
 * chat completions and embeddings on the client-based API.
 */
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { basicUsage, countEmbeddingInputs, isObject, OpenAIShapeInstrumentor, type Obj } from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';

export class TogetherInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Together AI';
  protected readonly packages = ['together-ai'];

  protected targets(module: unknown): PatchTarget[] {
    const client = exportedClass(module, 'Together') as
      | { Chat?: { Completions?: { prototype?: object } }; Embeddings?: { prototype?: object } }
      | undefined;
    return [
      {
        holder: client?.Chat?.Completions?.prototype,
        method: 'create',
        spanName: 'together.chat.completion',
        // No first message and no tool definitions: the reference records neither here.
        attributes: (_instance, _args, params) => this.chatRequestAttributes(params, { system: 'together', firstMessage: false }),
      },
      {
        holder: client?.Embeddings?.prototype,
        method: 'create',
        spanName: 'together.embeddings',
        attributes: (_instance, _args, params) => this.embeddingAttributes(params),
      },
    ];
  }

  private embeddingAttributes(params: Params): Obj {
    return {
      [ATTR.GEN_AI_SYSTEM]: 'together',
      [ATTR.GEN_AI_REQUEST_MODEL]: String(params.model ?? 'unknown'),
      [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
      [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: countEmbeddingInputs(params.input),
    };
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return basicUsage(result);
  }

  /** Embedding count and vector size where the response carries vectors; the model always. */
  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    const data = result.data ?? result.embeddings;
    if (Array.isArray(data)) {
      attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = data.length;
      const first: unknown = data[0];
      const vector = isObject(first) && !Array.isArray(first) ? first.embedding : first;
      if (Array.isArray(vector)) attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = vector.length;
    }
    if (result.model) attributes[ATTR.GEN_AI_RESPONSE_MODEL] = String(result.model);
    return attributes;
  }
}
