/**
 * The content guard (contract/SDK_ADDITIONS.md section 10).
 *
 * Frameworks that emit their own spans write prompts and answers on them
 * whatever our content-capture setting says - Genkit, OpenInference
 * instrumentations, the Vercel AI SDK, any GenAI-semconv instrumentation. Since
 * `instrument()` installs the tracer provider, they export through this
 * pipeline. With content capture OFF this processor removes those attributes,
 * and the span events that carry content, from every span before export. The
 * SDK's own spans never carry content with capture off; the guard covers them
 * too.
 *
 * The list lives here and only here; extend it when a framework is added.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { isContentKey } from './instrumentors/content';
import { logger } from './logger';

/** Attributes that carry what was said, by exact name. */
export const CONTENT_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  // Genkit
  'genkit:input',
  'genkit:output',
  // OpenInference
  'input.value',
  'output.value',
  'llm.prompts',
  'llm.prompt_template.template',
  'llm.prompt_template.variables',
  // Vercel AI SDK
  'ai.prompt',
  'ai.prompt.messages',
  'ai.prompt.tools',
  'ai.response.text',
  'ai.response.reasoning',
  'ai.response.toolCalls',
  'ai.response.object',
  'ai.response.files',
  'ai.toolCall.args',
  'ai.toolCall.result',
  'ai.value',
  'ai.values',
  'ai.embedding',
  'ai.embeddings',
  'ai.schema',
  // GenAI semantic conventions beyond the message attributes
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);

const EXACT = new Set(CONTENT_ATTRIBUTE_KEYS);

/**
 * Attribute families that carry what was said: OpenInference message text, retrieved documents, embedded
 * texts. A model's tool calls (name, arguments) on this SDK's own spans are recorded with capture off and
 * stay: only the message text is removed.
 */
const CONTENT_FAMILY = /^(llm\.(input|output)_messages\.\d+\.message\.(content|contents\.)|retrieval\.documents\.\d+\.document\.content$|embedding\.embeddings\.\d+\.embedding\.text$)/;

/** Span events that carry what was said (GenAI semantic conventions, old and new). */
const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  'gen_ai.user.message',
  'gen_ai.assistant.message',
  'gen_ai.system.message',
  'gen_ai.tool.message',
  'gen_ai.choice',
  'gen_ai.content.prompt',
  'gen_ai.content.completion',
  'gen_ai.client.inference.operation.details',
]);

/**
 * The SDK's own structure under `gen_ai.prompt.N.*` / `gen_ai.completion.N.*` (roles, part types, media
 * metadata) is recorded with capture off by design; only the text under them is content.
 */
const STRUCTURE_SUFFIX = /^gen_ai\.(prompt|completion)\.\d+(\.content\.\d+)?\.(role|type|finish_reason|media_[a-z_]+)$/;

/** Whether an attribute key carries what was said, under any framework's naming. */
export function isGuardedContentKey(key: string): boolean {
  if (STRUCTURE_SUFFIX.test(key)) return false;
  return EXACT.has(key) || CONTENT_FAMILY.test(key) || isContentKey(key);
}

export class ContentGuardSpanProcessor implements SpanProcessor {
  constructor(private readonly options: { contentCapture: boolean }) {}

  onStart(_span: Span, _context: Context): void {}

  /** Called by the SDK just before the span is ended, while it is still writable. */
  onEnding(span: Span): void {
    if (this.options.contentCapture) return;
    try {
      // The API has no way to unset an attribute; the open span's own table is edited.
      const table = span.attributes as Record<string, unknown>;
      for (const key of Object.keys(table)) if (isGuardedContentKey(key)) delete table[key];
      const events = (span as unknown as { events?: { name: string; attributes?: Record<string, unknown> }[] }).events;
      if (Array.isArray(events)) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (!event) continue;
          if (CONTENT_EVENTS.has(event.name) || Object.keys(event.attributes ?? {}).some(isGuardedContentKey)) events.splice(index, 1);
        }
      }
    } catch (error) {
      // Never fail span processing here.
      logger.debug(`Content guard could not process span '${span.name}': ${String(error)}`);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
