/**
 * Instrumentor for the `ollama` package. A port of
 * `genai_otel/instrumentors/ollama_instrumentor.py`: `generate`, `chat`,
 * `embed` and the legacy `embeddings`.
 *
 * The methods live on the client class, so the default export
 * (`import ollama from 'ollama'`) and every `new Ollama()` are covered.
 *
 * As in the reference, a poller of the Ollama server's `/api/ps` starts with
 * the instrumentor (`GENAI_ENABLE_OLLAMA_SERVER_METRICS`, on by default;
 * `OLLAMA_BASE_URL`, `GENAI_OLLAMA_METRICS_INTERVAL`, `GENAI_OLLAMA_MAX_VRAM_GB`).
 */
import type { Span } from '@opentelemetry/api';
import { ambientEnv } from '../env';
import { logger } from '../logger';
import { ATTR } from '../semconv';
import { OllamaServerMetricsPoller, vramDetector } from '../server-metrics';
import type { Params, UsageDict } from './base';
import { countEmbeddingInputs, defined, isObject, OpenAIShapeInstrumentor, type Obj } from './openai-shape';
import { exportedClass, prototypeDefining } from './patch';
import type { PatchTarget } from './patching';

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 256;

export class OllamaInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Ollama';
  protected readonly packages = ['ollama'];
  private poller: OllamaServerMetricsPoller | undefined;

  protected override onEnabled(): void {
    if (this.poller) return;
    try {
      const env = ambientEnv();
      if ((env.GENAI_ENABLE_OLLAMA_SERVER_METRICS ?? 'true').toLowerCase() !== 'true') return;
      const interval = Number.parseFloat(env.GENAI_OLLAMA_METRICS_INTERVAL ?? '5.0');
      const maxVram = Number.parseFloat(env.GENAI_OLLAMA_MAX_VRAM_GB ?? '');
      this.poller = new OllamaServerMetricsPoller({
        baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
        intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5.0,
        maxVramGb: Number.isFinite(maxVram) && maxVram > 0 ? maxVram : undefined,
        detectVram: vramDetector(),
      });
      this.poller.start();
    } catch (error) {
      logger.warn(`Failed to start Ollama server metrics poller: ${String(error)}`);
    }
  }

  override uninstrument(): void {
    this.poller?.stop();
    this.poller = undefined;
    super.uninstrument();
  }

  protected targets(module: unknown): PatchTarget[] {
    const Client = exportedClass(module, 'Ollama');
    if (typeof Client !== 'function') return [];
    return [
      {
        holder: prototypeDefining(Client, 'generate'),
        method: 'generate',
        spanName: 'ollama.generate',
        attributes: (_i, _a, params) => ({
          [ATTR.GEN_AI_SYSTEM]: 'ollama',
          [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
          [ATTR.GEN_AI_OPERATION_NAME]: 'generate',
        }),
      },
      {
        holder: prototypeDefining(Client, 'chat'),
        method: 'chat',
        spanName: 'ollama.chat',
        attributes: (_i, _a, params) => this.chatAttributes(params),
      },
      ...['embed', 'embeddings'].map((method) => ({
        holder: prototypeDefining(Client, method),
        method,
        spanName: 'ollama.embeddings',
        attributes: (_i: unknown, _a: unknown[], params: Params) => this.embeddingAttributes(params),
      })),
    ];
  }

  private chatAttributes(params: Params): Obj {
    const messages = Array.isArray(params.messages) ? params.messages : [];
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'ollama',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
      [ATTR.GEN_AI_OPERATION_NAME]: 'chat',
      [ATTR.GEN_AI_REQUEST_MESSAGE_COUNT]: messages.length,
    };
    const firstMessage = this.buildFirstMessage(messages);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  private embeddingAttributes(params: Params): Obj {
    return {
      [ATTR.GEN_AI_SYSTEM]: 'ollama',
      [ATTR.GEN_AI_REQUEST_MODEL]: String(params.model ?? 'unknown'),
      [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
      [ATTR.GEN_AI_REQUEST_INPUT_COUNT]: countEmbeddingInputs(params.input ?? params.prompt),
    };
  }

  /** `prompt_eval_count` in, `eval_count` out. null when the server reported neither. */
  protected extractUsage(result: unknown): UsageDict | null {
    if (!isObject(result)) return null;
    const prompt = Number(result.prompt_eval_count ?? 0);
    const completion = Number(result.eval_count ?? 0);
    if (prompt === 0 && completion === 0) return null;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }

  /**
   * A server that omits the counts: about four characters to a token, 256
   * tokens to an image. The span is marked as carrying an estimate.
   */
  protected override estimateUsage(result: unknown, params: Params): UsageDict | null {
    let promptChars = 0;
    let imageCount = 0;
    if (typeof params.prompt === 'string') promptChars += params.prompt.length;
    if (Array.isArray(params.messages)) {
      for (const message of params.messages as unknown[]) {
        if (!isObject(message)) continue;
        const content = message.content;
        if (typeof content === 'string') promptChars += content.length;
        else if (Array.isArray(content)) {
          for (const part of content as unknown[]) {
            if (!isObject(part)) continue;
            const text = part.text || part.content;
            if (typeof text === 'string') promptChars += text.length;
            if (part.type === 'image' || part.type === 'image_url' || part.image_url) imageCount += 1;
          }
        }
        if (Array.isArray(message.images)) imageCount += message.images.length;
      }
    }
    if (Array.isArray(params.images)) imageCount += params.images.length;

    let responseText = '';
    if (isObject(result)) {
      if (typeof result.response === 'string') responseText = result.response;
      if (!responseText && isObject(result.message) && typeof result.message.content === 'string') responseText = result.message.content;
    }
    if (promptChars === 0 && imageCount === 0 && !responseText) return null;

    const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN) + imageCount * IMAGE_TOKEN_ESTIMATE;
    const completionTokens = Math.ceil(responseText.length / CHARS_PER_TOKEN);
    if (promptTokens === 0 && completionTokens === 0) return null;
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    if ('model' in result) attributes[ATTR.GEN_AI_RESPONSE_MODEL] = result.model;
    if ('done_reason' in result) attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASON] = result.done_reason;
    if ('response' in result) {
      if (typeof result.response === 'string') attributes[ATTR.GEN_AI_RESPONSE_LENGTH] = [...result.response].length;
    } else if (isObject(result.message) && typeof result.message.content === 'string') {
      attributes[ATTR.GEN_AI_RESPONSE_LENGTH] = [...result.message.content].length;
    }
    let vectors: unknown = result.embeddings;
    if ((vectors === undefined || vectors === null) && result.embedding !== undefined && result.embedding !== null) vectors = [result.embedding];
    if (Array.isArray(vectors)) {
      attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = vectors.length;
      if (Array.isArray(vectors[0])) attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = vectors[0].length;
    }
    return attributes;
  }

  protected override extractFinishReason(result: unknown): string | null {
    return isObject(result) && typeof result.done_reason === 'string' ? result.done_reason : null;
  }

  protected override addContentEvents(span: Span, result: unknown, params: Params): void {
    const messages = Array.isArray(params.messages) ? params.messages : [];
    messages.forEach((message: unknown, index) => {
      if (!isObject(message)) return;
      span.addEvent(
        `gen_ai.prompt.${index}`,
        defined({
          [ATTR.GEN_AI_PROMPT_ROLE]: String(message.role ?? 'unknown'),
          [ATTR.GEN_AI_PROMPT_CONTENT]: this.capContent(message.content ?? ''),
        }),
      );
    });
    if (!isObject(result)) return;
    let content: unknown;
    if ('response' in result) content = result.response;
    else if (isObject(result.message)) content = result.message.content;
    if (!content) return;
    const capped = this.capContent(content);
    span.addEvent('gen_ai.completion.0', defined({ [ATTR.GEN_AI_COMPLETION_ROLE]: 'assistant', [ATTR.GEN_AI_COMPLETION_CONTENT]: capped }));
    if (capped !== undefined) span.setAttribute(ATTR.GEN_AI_RESPONSE, capped);
  }
}
