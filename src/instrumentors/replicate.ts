/**
 * Instrumentor for the `replicate` package. A port of
 * `genai_otel/instrumentors/replicate_instrumentor.py`: `run()`.
 *
 * Replicate bills by hardware time, not by token: the span has no token and no
 * cost attributes, by design.
 */
import type { Span } from '@opentelemetry/api';
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { isObject, OpenAIShapeInstrumentor, type Obj } from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';

const EMBEDDING_MODEL_MARKERS = ['embed', 'bge-', 'e5-', 'gte-', 'mpnet-base', 'minilm', 'sentence-transformers'];

function isEmbeddingModel(model: unknown): boolean {
  const name = String(model).toLowerCase();
  return EMBEDDING_MODEL_MARKERS.some((marker) => name.includes(marker));
}

/** Replicate has no fixed input schema; only the field names embedding models conventionally use are recognised. */
function countInputs(input: unknown): number {
  if (!isObject(input) || Array.isArray(input)) return input !== undefined && input !== null ? 1 : 0;
  for (const key of ['texts', 'inputs']) {
    if (Array.isArray(input[key])) return input[key].length;
  }
  for (const key of ['text', 'input', 'prompt']) {
    if (input[key] !== undefined && input[key] !== null) return 1;
  }
  return 0;
}

export class ReplicateInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Replicate';
  protected readonly packages = ['replicate'];
  /** Whether the call being recorded asked for an embedding model. Set and read synchronously. */
  private recordingEmbedding = false;

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'Replicate');
    if (typeof client !== 'function') return [];
    return [
      {
        holder: (client as { prototype: object }).prototype,
        method: 'run',
        spanName: 'replicate.run',
        attributes: (_instance, _args, params) => this.runAttributes(params),
        // run(model, { input })
        options: { params: (args) => ({ model: args[0] ?? 'unknown', input: isObject(args[1]) ? args[1].input : undefined }) },
      },
    ];
  }

  private runAttributes(params: Params): Obj {
    const attributes: Obj = { [ATTR.GEN_AI_SYSTEM]: 'replicate', [ATTR.GEN_AI_REQUEST_MODEL]: params.model };
    if (isEmbeddingModel(params.model)) {
      attributes[ATTR.GEN_AI_OPERATION_NAME] = 'embeddings';
      attributes[ATTR.GEN_AI_REQUEST_TYPE] = 'embedding';
      attributes[ATTR.GEN_AI_REQUEST_INPUT_COUNT] = countInputs(params.input);
    } else {
      attributes[ATTR.GEN_AI_OPERATION_NAME] = 'run';
    }
    return attributes;
  }

  protected override recordResultMetrics(span: Span, spanName: string, result: unknown, startTime: number, params: Params): void {
    this.recordingEmbedding = isEmbeddingModel(params.model);
    try {
      super.recordResultMetrics(span, spanName, result, startTime, params);
    } finally {
      this.recordingEmbedding = false;
    }
  }

  /**
   * An embedding model returns the bare vector, or a list of vectors. Read that
   * way only when the request was for an embedding model: any other model's
   * list of numbers (audio samples, boxes) would otherwise be mislabelled.
   */
  protected override extractResponseAttributes(result: unknown): Obj {
    if (!this.recordingEmbedding || !Array.isArray(result) || result.length === 0) return {};
    const first: unknown = result[0];
    if (Array.isArray(first)) {
      const attributes: Obj = { [ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT]: result.length };
      if (first.length > 0) attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = first.length;
      return attributes;
    }
    if (typeof first === 'number') {
      return { [ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT]: 1, [ATTR.GEN_AI_RESPONSE_VECTOR_SIZE]: result.length };
    }
    return {};
  }

  /** Hardware-time pricing: there are no tokens to report. */
  protected extractUsage(): UsageDict | null {
    return null;
  }
}
