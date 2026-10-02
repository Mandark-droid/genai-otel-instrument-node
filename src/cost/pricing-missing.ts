/**
 * The pricing-missing counter.
 *
 * When no price is known for a model, the span gets no cost attribute at all -
 * a zero would read as "this call was free". That keeps a spend total honest,
 * but on its own it also makes the gap invisible, so every such call is counted
 * here. A non-zero value of this metric means "the cost figures are incomplete,
 * and for these models".
 *
 * This metric is not part of the Python reference implementation, which reports
 * the same condition only as `gen_ai.usage.cost.pricing_source = "unpriced"` on
 * the span. That attribute is emitted here too.
 */
import { metrics, type Counter } from '@opentelemetry/api';
import { clearStateSlot, stateSlot } from '../state';

/** Instrumentation scope of the Python library's GenAI client metrics. */
export const METER_NAME = 'genai_otel.instrumentors.base';

export const PRICING_MISSING_METRIC = 'gen_ai.usage.cost.pricing_missing';

const SLOT = 'pricingMissingCounter';

function counter(): Counter {
  return stateSlot(SLOT, () =>
    metrics.getMeter(METER_NAME).createCounter(PRICING_MISSING_METRIC, {
      description: 'Number of GenAI calls with token usage for which no price is known; their cost is not recorded',
    }),
  );
}

/** Count one call that could not be priced. Never throws. */
export function recordPricingMissing(model: string, callType: string): void {
  try {
    counter().add(1, { model: String(model), call_type: String(callType) });
  } catch {
    // A metric must never break the call it measures.
  }
}

/**
 * Forget the instrument, so the next use binds to the current meter provider.
 * Called whenever the global meter provider is replaced.
 */
export function resetPricingMissingCounter(): void {
  clearStateSlot(SLOT);
}
