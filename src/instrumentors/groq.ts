/**
 * Instrumentor for `groq-sdk`. A port of `genai_otel/instrumentors/groq_instrumentor.py`.
 *
 * The reference wraps the call by hand and records little: system, model, the
 * first message, tokens, cost, and the response text. The same is recorded
 * here, through the common wrapper - which adds what it derives centrally
 * (`server.address`, request parameters).
 */
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { basicUsage, OpenAIShapeInstrumentor, type Obj } from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';

export class GroqInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Groq';
  protected readonly packages = ['groq-sdk'];

  protected targets(module: unknown): PatchTarget[] {
    const client = exportedClass(module, 'Groq') as { Chat?: { Completions?: { prototype?: object } }; Embeddings?: { prototype?: object } } | undefined;
    return [
      {
        holder: client?.Chat?.Completions?.prototype,
        method: 'create',
        spanName: 'groq.chat.completions',
        attributes: (_instance, _args, params) => this.requestAttributes(params),
      },
      {
        // Not traced by the reference; named by SDK_ADDITIONS.md section 7.
        holder: client?.Embeddings?.prototype,
        method: 'create',
        spanName: 'groq.embeddings',
        attributes: (_instance, _args, params) => this.embeddingRequestAttributes(params, 'groq'),
      },
    ];
  }

  private requestAttributes(params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'groq',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
    };
    const messages = Array.isArray(params.messages) ? params.messages : [];
    if (messages.length > 0) {
      const firstMessage = this.buildFirstMessage(messages);
      if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    }
    return attributes;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return basicUsage(result);
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    return this.chatResponseAttributes(result, { responseText: true });
  }
}
