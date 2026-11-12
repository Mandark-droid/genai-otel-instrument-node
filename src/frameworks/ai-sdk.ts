/**
 * Vercel AI SDK (`ai`) - a JavaScript-only addition; the reference has no
 * counterpart.
 *
 * The SDK's functions are ES-module exports and cannot be patched. It emits
 * OpenTelemetry spans itself, through `@ai-sdk/otel`, in one of two attribute
 * styles: `ai.*` (tracer `ai`) and GenAI (`gen_ai.*`, tracer `gen_ai`). This
 * processor makes those spans read like the ones this library produces:
 *
 * - `gen_ai.system` / `gen_ai.provider.name` (the SDK says `openai.chat`),
 *   `gen_ai.operation.name` and `gen_ai.usage.total_tokens` are filled in, so
 *   the cost processor that follows prices the model call;
 * - the SDK records prompts and responses unless told not to; here they are
 *   removed unless content capture is on, the rule of the rest of this library.
 *
 * Spans that repeat the usage of the calls inside them (`ai.generateText`,
 * `invoke_agent`) are not priced: see `isAiSdkAggregate`.
 */
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { logger } from '../logger';

/** Tracer names of `@ai-sdk/otel`: the `ai.*` style and the GenAI style. */
const AI_SDK_SCOPES: ReadonlySet<string> = new Set(['ai', 'gen_ai']);


const isAiSdkSpan = (span: ReadableSpan): boolean => AI_SDK_SCOPES.has(span.instrumentationScope?.name ?? '');

/**
 * An AI SDK span that sums the model calls beneath it. Pricing it would count
 * the same tokens twice.
 */
export function isAiSdkAggregate(span: ReadableSpan): boolean {
  if (!isAiSdkSpan(span)) return false;
  return span.attributes['gen_ai.operation.name'] === 'invoke_agent';
}

export class AiSdkSpanProcessor implements SpanProcessor {
  onStart(): void {}

  /** Called by the SDK just before the span is ended, while it is still writable. */
  onEnding(span: Span): void {
    try {
      if (!isAiSdkSpan(span)) return;
      // What was said is removed by the content guard, with every other framework's (content-guard.ts).
      this.normalise(span);
    } catch (error) {
      // Never fail span processing here.
      logger.debug(`Could not normalise AI SDK span '${span.name}': ${String(error)}`);
    }
  }

  private normalise(span: Span): void {
    const attributes = span.attributes;
    // `openai.chat`, `anthropic.messages`: the provider is the first part.
    const named = attributes['gen_ai.provider.name'] ?? attributes['gen_ai.system'] ?? attributes['ai.model.provider'];
    const provider = typeof named === 'string' && named ? named.split('.')[0] : undefined;
    const operationId = String(attributes['ai.operationId'] ?? '');
    const isModelCall = /\.do(Generate|Stream|Embed)$/.test(operationId);
    const isEmbedding = operationId.endsWith('.doEmbed');

    if (provider && (isModelCall || 'gen_ai.provider.name' in attributes || 'gen_ai.system' in attributes)) {
      span.setAttribute('gen_ai.system', provider);
      span.setAttribute('gen_ai.provider.name', provider);
    }
    if (isModelCall) {
      if (!attributes['gen_ai.request.model'] && typeof attributes['ai.model.id'] === 'string') span.setAttribute('gen_ai.request.model', attributes['ai.model.id']);
      if (!attributes['gen_ai.operation.name']) span.setAttribute('gen_ai.operation.name', isEmbedding ? 'embeddings' : 'chat');
      // An embedding call reports one count.
      if (isEmbedding && attributes['gen_ai.usage.input_tokens'] === undefined && typeof attributes['ai.usage.tokens'] === 'number') {
        span.setAttribute('gen_ai.usage.input_tokens', attributes['ai.usage.tokens']);
      }
    }
    const input = span.attributes['gen_ai.usage.input_tokens'];
    const output = span.attributes['gen_ai.usage.output_tokens'];
    if (span.attributes['gen_ai.usage.total_tokens'] === undefined && (typeof input === 'number' || typeof output === 'number')) {
      span.setAttribute('gen_ai.usage.total_tokens', (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0));
    }
  }

  onEnd(): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
