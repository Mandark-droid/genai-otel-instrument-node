/**
 * Span processor that adds cost attributes to GenAI spans which have token
 * usage but no cost - spans produced by other instrumentation (OpenInference,
 * vendor SDK tracing), which know the tokens and not the price.
 *
 * Port of `cost_enrichment_processor.py` together with
 * `cost_enriching_exporter.py`. In Python a finished span is immutable, so the
 * processor there only logs and an exporter wrapper rebuilds the span with the
 * extra attributes. Here the SDK offers `onEnding`, called while the span can
 * still be written, so one processor does both jobs and nothing wraps the
 * exporter.
 *
 * Reads both GenAI (`gen_ai.request.model`, `gen_ai.usage.*`) and OpenInference
 * (`llm.model_name`, `llm.token_count.*`, `decision.*`) attribute names. Spans
 * this library's own instrumentors produced already carry their cost and are
 * left alone.
 *
 * An agent span in a trace whose model calls carried usage is not priced: the
 * framework reports the run's aggregate usage there as well as per call on the
 * model spans, and pricing both would count the run twice.
 */
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { usageRecordedBelow } from '../usage-holders';
import { logger } from '../logger';
import type { CostCalculator } from './calculator';
import { getDefaultCostCalculator } from './default';
import { METER_NAME as BASE_TRACER_NAME, recordPricingMissing } from './pricing-missing';

const COST_TOTAL = 'gen_ai.usage.cost.total';
const COST_PROMPT = 'gen_ai.usage.cost.prompt';
const COST_COMPLETION = 'gen_ai.usage.cost.completion';
const PRICING_SOURCE = 'gen_ai.usage.cost.pricing_source';
const COST_DECISION = 'gen_ai.usage.cost.decision';

const MODEL_KEYS = ['gen_ai.request.model', 'llm.model_name', 'embedding.model_name', 'decision.model_name'] as const;
// Current GenAI names first; the superseded prompt_/completion_ names are only
// present under gen_ai/dup; then OpenInference, then OpenInference DECISION.
const PROMPT_KEYS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.prompt_tokens',
  'llm.token_count.prompt',
  'decision.token_count.input',
] as const;
const COMPLETION_KEYS = [
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.completion_tokens',
  'llm.token_count.completion',
  'decision.token_count.output',
] as const;
const CACHE_READ_KEYS = ['gen_ai.usage.cache_read.input_tokens', 'cache_read_input_tokens'] as const;
const CACHE_WRITE_KEYS = ['gen_ai.usage.cache_write.input_tokens', 'cache_creation_input_tokens'] as const;
const MODEL_SPAN_KINDS: ReadonlySet<string> = new Set(['LLM', 'EMBEDDING']);
const MODEL_OPERATIONS: ReadonlySet<string> = new Set(['chat', 'completion', 'text_generation', 'image_generation', 'embedding']);

/** Operation name / OpenInference span kind -> call type the calculator dispatches on. */
const CALL_TYPE_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  // GenAI conventions
  chat: 'chat',
  completion: 'chat',
  embedding: 'embedding',
  embeddings: 'embedding',
  text_generation: 'chat',
  image_generation: 'image',
  audio: 'audio',
  // OpenInference span kinds
  llm: 'chat',
  chain: 'chat',
  retriever: 'embedding',
  reranker: 'embedding',
  tool: 'chat',
  agent: 'chat',
});

/** Python's `a or b or c or 0` over attribute values. */
function firstTruthy(attributes: Attributes, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = attributes[key];
    if (value) return value;
  }
  return 0;
}

const hasModel = (attributes: Attributes): boolean => Boolean(firstTruthy(attributes, MODEL_KEYS));
const hasUsage = (attributes: Attributes): boolean =>
  Boolean(firstTruthy(attributes, PROMPT_KEYS) || firstTruthy(attributes, COMPLETION_KEYS));

function isModelSpan(attributes: Attributes): boolean {
  const spanKind = String(attributes['openinference.span.kind'] ?? '').toUpperCase();
  const operation = String(attributes['gen_ai.operation.name'] ?? '').toLowerCase();
  return MODEL_SPAN_KINDS.has(spanKind) || MODEL_OPERATIONS.has(operation);
}

function isAgentSpan(attributes: Attributes): boolean {
  const spanKind = String(attributes['openinference.span.kind'] ?? '').toUpperCase();
  const operation = String(attributes['gen_ai.operation.name'] ?? '').toLowerCase();
  return spanKind === 'AGENT' || operation === 'invoke_agent';
}

export class CostEnrichmentSpanProcessor implements SpanProcessor {
  readonly costCalculator: CostCalculator;
  /** Traces in which a model span with usage has ended; forgotten when the trace's root span ends. */
  private readonly tracesWithModelUsage = new Set<string>();

  /**
   * `skip` names spans that must not be priced although they carry a model and
   * tokens - a span that sums the model calls beneath it.
   */
  constructor(
    costCalculator?: CostCalculator,
    private readonly skip?: (span: ReadableSpan) => boolean,
  ) {
    this.costCalculator = costCalculator ?? getDefaultCostCalculator();
    logger.info('CostEnrichmentSpanProcessor initialized');
  }

  onStart(): void {}

  /** Called by the SDK just before the span is ended, while it is still writable. */
  onEnding(span: Span): void {
    let traceId: string | undefined;
    try {
      traceId = span.spanContext().traceId;
      this.enrich(span, traceId);
    } catch (error) {
      // Never fail span processing because of cost enrichment.
      logger.warn(`Failed to enrich span '${span.name}' with cost: ${String(error)}`);
    } finally {
      if (traceId !== undefined && !span.parentSpanContext) this.tracesWithModelUsage.delete(traceId);
    }
  }

  private enrich(span: Span, traceId: string): void {
    const attributes = span.attributes;
    if (!attributes) return;

    // Remember model usage before anything else returns early: an agent span
    // ending later in this trace carries the run's aggregate of these calls.
    if (hasUsage(attributes) && isModelSpan(attributes) && hasModel(attributes)) {
      this.tracesWithModelUsage.add(traceId);
    }
    if (isAgentSpan(attributes) && this.tracesWithModelUsage.has(traceId)) return;

    // This library's own instrumentors make their own cost decision, including
    // the decision to record none (a cancelled stream, cost tracking of a model
    // with no price). Second-guessing them here would put a cost back.
    if (span.instrumentationScope?.name === BASE_TRACER_NAME) return;
    if (this.skip?.(span)) return;
    // A span whose call was recorded beneath it is not priced again (SDK_ADDITIONS.md section 8).
    if (usageRecordedBelow(span)) return;

    const model = firstTruthy(attributes, MODEL_KEYS);
    if (!model) return;

    // Already priced by the instrumentor that produced the span.
    if (COST_TOTAL in attributes) {
      logger.debug(`Span '${span.name}' already has cost attributes, skipping enrichment`);
      return;
    }

    const completionTokens = firstTruthy(attributes, COMPLETION_KEYS);
    // Anthropic SDK v1.14+ reports input_tokens with cache reads and writes
    // included. The calculator prices those separately, so they come out of
    // the standard prompt bucket before their dedicated cache rates apply.
    const cacheRead = Math.trunc(Number(firstTruthy(attributes, CACHE_READ_KEYS)));
    const cacheWrite = Math.trunc(Number(firstTruthy(attributes, CACHE_WRITE_KEYS)));
    const prompt = Math.max(Math.trunc(Number(firstTruthy(attributes, PROMPT_KEYS))) - cacheRead - cacheWrite, 0);
    if (prompt === 0 && completionTokens === 0) return;

    const spanKind = String(attributes['openinference.span.kind'] ?? '').toUpperCase();
    const callType = attributes['gen_ai.operation.name'] || spanKind.toLowerCase() || 'chat';
    let normalizedCallType = CALL_TYPE_MAPPING[String(callType).toLowerCase()] ?? 'chat';
    // A decision model is priced from the decision section only. Read as chat,
    // a self-hosted one would pick up a parameter-count estimate and
    // gpt-6-luna would be billed for output it does not charge for.
    if (spanKind === 'DECISION' || attributes['gen_ai.request.type'] === 'decision') normalizedCallType = 'decision';

    const completion = Math.trunc(Number(completionTokens));
    const usage: Record<string, number> = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + cacheRead + cacheWrite + completion,
    };
    if (cacheRead) usage.cache_read_input_tokens = cacheRead;
    if (cacheWrite) usage.cache_creation_input_tokens = cacheWrite;

    let cost: ReturnType<CostCalculator['calculateGranularCost']>;
    try {
      cost = this.costCalculator.calculateGranularCost(String(model), usage, normalizedCallType);
    } catch (error) {
      // A pricing entry the calculator cannot use: no cost, and that is counted.
      logger.warn(`Failed to enrich span '${span.name}' with cost: ${String(error)}`);
      cost = null;
    }
    if (cost === null) {
      // No price known. No attribute - a zero would read as "free" - but the
      // gap is counted, unless the producing instrumentor already reported it.
      if (!(PRICING_SOURCE in attributes)) recordPricingMissing(String(model), normalizedCallType);
      return;
    }
    if (cost.total > 0) {
      span.setAttribute(COST_TOTAL, cost.total);
      if (normalizedCallType === 'decision') span.setAttribute(COST_DECISION, cost.total);
      if (cost.prompt > 0) span.setAttribute(COST_PROMPT, cost.prompt);
      if (cost.completion > 0) span.setAttribute(COST_COMPLETION, cost.completion);
      logger.debug(
        `Enriched span '${span.name}' with cost: ${cost.total.toFixed(6)} USD for model ${String(model)} (${usage.total_tokens} tokens)`,
      );
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    logger.info('CostEnrichmentSpanProcessor shutdown');
  }
}
