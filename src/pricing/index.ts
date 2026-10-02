/**
 * The pricing table, vendored from the Python reference implementation.
 *
 * `llm_pricing.json` is copied by `scripts/sync-from-python.mjs` at the pinned
 * tag and bundled into the package: there is no runtime file read and no
 * network fetch. Never edit it by hand.
 */
import pricing from './llm_pricing.json';

/** The shared, read-only table. A calculator that merges custom pricing copies what it changes. */
export function defaultPricingData(): Record<string, unknown> {
  return pricing as Record<string, unknown>;
}
