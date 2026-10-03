/**
 * Instrumentors for Google's clients. Ports of
 * `genai_otel/instrumentors/google_ai_instrumentor.py` (the `google.genai`
 * half) and `vertexai_instrumentor.py`.
 *
 * `@google/genai` assigns `generateContent`, `generateContentStream` and
 * `embedContent` to each `Models` instance, so there is nothing on the
 * prototype to patch under those names. The methods they delegate to are on
 * the prototype - one call per model request - and those are patched. With
 * automatic function calling, that is one span per round trip to the model.
 *
 * The legacy `@google/generative-ai` package reached end of life and is not
 * instrumented.
 */
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { countEmbeddingInputs, isObject, OpenAIShapeInstrumentor, pick, type Obj } from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';

/** `usageMetadata` (JavaScript) or `usage_metadata` (wire, Python). */
function usageMetadata(result: unknown): UsageDict | null {
  const usage = pick(result, 'usageMetadata', 'usage_metadata');
  if (!isObject(usage)) return null;
  const candidates = Number(pick(usage, 'candidatesTokenCount', 'candidates_token_count') ?? 0);
  // Thinking tokens are billed as output and are not in `candidatesTokenCount`:
  // they are output tokens and reasoning tokens (the reference reads neither).
  const thoughts = Number(pick(usage, 'thoughtsTokenCount', 'thoughts_token_count') ?? 0);
  const mapped: UsageDict = {
    prompt_tokens: pick(usage, 'promptTokenCount', 'prompt_token_count') ?? 0,
    completion_tokens: candidates + thoughts,
    total_tokens: pick(usage, 'totalTokenCount', 'total_token_count') ?? 0,
  };
  if (thoughts > 0) mapped.completion_tokens_details = { reasoning_tokens: thoughts };
  // Context-cache hits are part of the prompt count, as OpenAI's cached tokens are.
  const cached = Number(pick(usage, 'cachedContentTokenCount', 'cached_content_token_count') ?? 0);
  if (cached > 0) mapped.cache_read_input_tokens = cached;
  return mapped;
}

function candidateAttributes(result: unknown): Obj {
  const attributes: Obj = {};
  if (!isObject(result)) return attributes;
  const model = pick(result, 'model', 'modelVersion');
  if (model !== undefined) attributes[ATTR.GEN_AI_RESPONSE_MODEL] = model;

  const candidates = Array.isArray(result.candidates) ? (result.candidates as unknown[]) : [];
  const finishReasons = candidates
    .map((candidate) => pick(candidate, 'finishReason', 'finish_reason'))
    .filter((reason) => reason !== undefined)
    .map(String);
  if (finishReasons.length > 0) attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = finishReasons;

  // Safety ratings of the first candidate.
  const ratings = pick(candidates[0], 'safetyRatings', 'safety_ratings');
  if (Array.isArray(ratings)) {
    for (const rating of ratings as unknown[]) {
      if (!isObject(rating)) continue;
      attributes[`gen_ai.safety.${String(rating.category ?? 'unknown')}`] = String(rating.probability ?? 'unknown');
    }
  }

  let vectors: unknown = result.embeddings;
  if ((vectors === undefined || vectors === null) && result.embedding !== undefined && result.embedding !== null) vectors = [result.embedding];
  if (Array.isArray(vectors)) {
    attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = vectors.length;
    const first: unknown = vectors[0];
    const values = Array.isArray(first) ? first : isObject(first) ? first.values : undefined;
    if (Array.isArray(values)) attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = values.length;
  }
  return attributes;
}

function firstFinishReason(result: unknown): string | null {
  const candidates = isObject(result) && Array.isArray(result.candidates) ? (result.candidates as unknown[]) : [];
  const reason = pick(candidates[0], 'finishReason', 'finish_reason');
  return reason === undefined ? null : String(reason);
}

export class GoogleGenAIInstrumentor extends OpenAIShapeInstrumentor {
  protected override readonly mediaProvider = 'google';
  protected readonly label = 'Google GenAI';
  protected readonly packages = ['@google/genai'];

  protected targets(module: unknown): PatchTarget[] {
    const models = (isObject(module) || typeof module === 'function' ? (module as Obj).Models : undefined) as
      | { prototype?: object }
      | undefined;
    const prototype = models?.prototype;
    return [
      {
        holder: prototype,
        method: 'generateContentInternal',
        spanName: 'google.genai.models.generate_content',
        attributes: (_i, _a, params) => this.generateAttributes(params),
      },
      {
        holder: prototype,
        method: 'generateContentStreamInternal',
        spanName: 'google.genai.models.generate_content',
        attributes: (_i, _a, params) => this.generateAttributes(params),
        options: { streaming: true },
      },
      {
        holder: prototype,
        method: 'embedContentInternal',
        spanName: 'google.genai.models.embeddings',
        attributes: (_i, _a, params) => ({
          [ATTR.GEN_AI_SYSTEM]: 'google',
          [ATTR.GEN_AI_REQUEST_MODEL]: String(params.model ?? 'unknown'),
          [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
          [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
          [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: countEmbeddingInputs(params.contents ?? params.content),
        }),
      },
    ];
  }

  private generateAttributes(params: Params): Obj {
    const attributes: Obj = { [ATTR.GEN_AI_SYSTEM]: 'google', [ATTR.GEN_AI_OPERATION_NAME]: 'chat' };
    if ('model' in params) attributes[ATTR.GEN_AI_REQUEST_MODEL] = params.model;
    const config = params.config;
    if (isObject(config)) {
      const temperature = pick(config, 'temperature');
      if (temperature !== undefined) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = temperature;
      const topP = pick(config, 'topP', 'top_p');
      if (topP !== undefined) attributes[ATTR.GEN_AI_REQUEST_TOP_P] = topP;
      const maxTokens = pick(config, 'maxOutputTokens', 'max_output_tokens');
      if (maxTokens !== undefined) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = maxTokens;
    }
    return attributes;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return usageMetadata(result);
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    return candidateAttributes(result);
  }

  protected override extractFinishReason(result: unknown): string | null {
    return firstFinishReason(result);
  }
}

/** `@google-cloud/vertexai`: `GenerativeModel.generateContent`, which resolves to `{ response }`. */
export class VertexAIInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Vertex AI';
  protected readonly packages = ['@google-cloud/vertexai'];

  protected targets(module: unknown): PatchTarget[] {
    const targets: PatchTarget[] = [];
    for (const name of ['GenerativeModel', 'GenerativeModelPreview']) {
      const model: unknown = exportedClass(module, name);
      if (typeof model !== 'function') continue;
      targets.push({
        holder: (model as { prototype?: object }).prototype,
        method: 'generateContent',
        spanName: 'vertexai.generate_content',
        attributes: (instance) => ({
          [ATTR.GEN_AI_SYSTEM]: 'vertexai',
          [ATTR.GEN_AI_REQUEST_MODEL]: (isObject(instance) ? pick(instance, 'model', '_model_name') : undefined) ?? 'unknown',
          [ATTR.GEN_AI_OPERATION_NAME]: 'generate_content',
        }),
      });
    }
    return targets;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    const usage = usageMetadata(isObject(result) && isObject(result.response) ? result.response : result);
    if (!usage) return null;
    // Zero on both sides is "not reported", as in the reference.
    return usage.prompt_tokens || usage.completion_tokens ? usage : null;
  }
}
