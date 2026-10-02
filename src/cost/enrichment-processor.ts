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
 * (`llm.model_name`, `llm.token_count.*`) attribute names. Spans this library's
 * own instrumentors produced already carry their cost and are left alone.
 */
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { logger } from '../logger';
import type { CostCalculator } from './calculator';
import { getDefaultCostCalculator } from './default';
import { METER_NAME as BASE_TRACER_NAME, recordPricingMissing } from './pricing-missing';

const COST_TOTAL = 'gen_ai.usage.cost.total';
const COST_PROMPT = 'gen_ai.usage.cost.prompt';
const COST_COMPLETION = 'gen_ai.usage.cost.completion';
const PRICING_SOURCE = 'gen_ai.usage.cost.pricing_source';

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

export class CostEnrichmentSpanProcessor implements SpanProcessor {
  readonly costCalculator: CostCalculator;

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
    try {
      this.enrich(span);
    } catch (error) {
      // Never fail span processing because of cost enrichment.
      logger.warn(`Failed to enrich span '${span.name}' with cost: ${String(error)}`);
    }
  }

  private enrich(span: Span): void {
    const attributes = span.attributes;
    if (!attributes) return;

    // This library's own instrumentors make their own cost decision, including
    // the decision to record none (a cancelled stream, cost tracking of a model
    // with no price). Second-guessing them here would put a cost back.
    if (span.instrumentationScope?.name === BASE_TRACER_NAME) return;
    if (this.skip?.(span)) return;

    const model =
      attributes['gen_ai.request.model'] || attributes['llm.model_name'] || attributes['embedding.model_name'];
    if (!model) return;

    // Already priced by the instrumentor that produced the span.
    if (COST_TOTAL in attributes) {
      logger.debug(`Span '${span.name}' already has cost attributes, skipping enrichment`);
      return;
    }

    // Current GenAI names first; the superseded prompt_/completion_ names are
    // only present under gen_ai/dup; then OpenInference.
    const promptTokens = firstTruthy(attributes, [
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.prompt_tokens',
      'llm.token_count.prompt',
    ]);
    const completionTokens = firstTruthy(attributes, [
      'gen_ai.usage.output_tokens',
      'gen_ai.usage.completion_tokens',
      'llm.token_count.completion',
    ]);
    if (promptTokens === 0 && completionTokens === 0) return;

    const spanKind = String(attributes['openinference.span.kind'] ?? '').toUpperCase();
    const callType = attributes['gen_ai.operation.name'] || spanKind.toLowerCase() || 'chat';
    const normalizedCallType = CALL_TYPE_MAPPING[String(callType).toLowerCase()] ?? 'chat';

    const prompt = Math.trunc(Number(promptTokens));
    const completion = Math.trunc(Number(completionTokens));
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };

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
