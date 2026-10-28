/**
 * OpenInference span kinds next to the OpenTelemetry GenAI attributes.
 *
 * Backends built on OpenInference (Arize AX, Phoenix) map the standard GenAI
 * attributes - `gen_ai.operation.name`, `gen_ai.usage.*`, the model - but they
 * classify a span by `openinference.span.kind`, and an operation outside the
 * GenAI registry (speech to text, a model load, an application's own retrieval
 * step) has no kind to map to, so it shows as "unknown". Instrumentors that know
 * the kind set it themselves (as the Python library does); this processor fills
 * it in for every other span, from the operation name or the span's name.
 *
 * Content the span already carries (GenAI messages, tool arguments and results,
 * a retrieval query) is also copied to the names those backends display
 * (`input.value`, `output.value`, `tool.*`); with content capture off there is
 * none to copy. A name set by an instrumentor or the application is never
 * replaced, and backends that ignore OpenInference see no difference.
 *
 * Turned off with `openInferenceSpanKinds: false` in instrument().
 */
import { type Context, SpanKind } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { logger } from './logger';

export const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind';

/** The OpenInference kinds this library emits. */
export type OpenInferenceSpanKind = 'LLM' | 'EMBEDDING' | 'RETRIEVER' | 'RERANKER' | 'TOOL' | 'AGENT' | 'CHAIN';

const BY_OPERATION: Record<string, OpenInferenceSpanKind> = {
  chat: 'LLM',
  text_completion: 'LLM',
  generate_content: 'LLM',
  speech_to_text: 'LLM',
  embeddings: 'EMBEDDING',
  retrieval: 'RETRIEVER',
  retrieve: 'RETRIEVER',
  rerank: 'RERANKER',
  execute_tool: 'TOOL',
  invoke_agent: 'AGENT',
  create_agent: 'AGENT',
};

/**
 * The kind for a span, or undefined when it is not a GenAI step: an internal
 * span with no recognisable operation is a CHAIN (a step of the application's
 * pipeline), while a client or server span (an HTTP call, a database query)
 * without one is left alone.
 */
export function openInferenceKind(
  name: string,
  attributes: Record<string, unknown>,
  kind: SpanKind = SpanKind.INTERNAL,
): OpenInferenceSpanKind | undefined {
  const operation = attributes['gen_ai.operation.name'];
  if (typeof operation === 'string' && BY_OPERATION[operation]) return BY_OPERATION[operation];
  const prefix = name.split(' ', 1)[0] ?? '';
  if (BY_OPERATION[prefix]) return BY_OPERATION[prefix];
  if (prefix === 'query' && Object.keys(attributes).some((key) => key.startsWith('rag.') || key.startsWith('db.vector')))
    return 'RETRIEVER';
  if (attributes['mcp.method.name'] === 'tools/call') return 'TOOL';
  return kind === SpanKind.INTERNAL ? 'CHAIN' : undefined;
}

/**
 * The names OpenInference backends display a span's input, output and tool under, filled in
 * from GenAI attributes already on the span. Content is only copied, never collected: when the
 * application did not capture prompts and results, there is nothing to copy. A name already set
 * is kept.
 */
const CONTENT_SOURCES: [target: string, sources: string[]][] = [
  ['input.value', ['gen_ai.input.messages', 'gen_ai.tool.call.arguments', 'retrieval.query', 'gen_ai.prompt']],
  ['output.value', ['gen_ai.output.messages', 'gen_ai.tool.call.result', 'gen_ai.response', 'gen_ai.completion']],
  ['tool.name', ['gen_ai.tool.name']],
  ['tool.description', ['gen_ai.tool.description']],
  ['tool.parameters', ['gen_ai.tool.call.arguments']],
];

export function openInferenceContent(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [target, sources] of CONTENT_SOURCES) {
    if (attributes[target] !== undefined) continue;
    const value = sources.map((key) => attributes[key]).find((v) => v !== undefined && v !== '');
    if (value !== undefined) out[target] = value;
  }
  return out;
}

export class OpenInferenceSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  /**
   * Runs before the exporting processor, so the exported span carries the kind.
   * The span has ended, which closes `setAttribute`; the attribute map itself is
   * still the one the exporter reads.
   */
  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    try {
      if (attributes[OPENINFERENCE_SPAN_KIND] === undefined) {
        const kind = openInferenceKind(span.name, attributes, span.kind);
        if (kind) attributes[OPENINFERENCE_SPAN_KIND] = kind;
      }
      Object.assign(attributes, openInferenceContent(attributes));
    } catch (error) {
      logger.debug(`OpenInference attributes not set: ${String(error)}`);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
