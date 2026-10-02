import { stateSlot } from '../state';
import { CostCalculator } from './calculator';

/**
 * The process-wide calculator over the shipped pricing table, created once.
 *
 * Building one indexes every priced model; instrumentors share this instance
 * and get a private one only when custom pricing is configured.
 */
export function getDefaultCostCalculator(): CostCalculator {
  return stateSlot('defaultCostCalculator', () => new CostCalculator());
}

/**
 * The calculator for a configuration: the shared default one, or - when custom
 * pricing is supplied - one with that pricing merged over the shipped table.
 * Every instrumentor and the cost-enrichment processor of one configuration get
 * the same instance, so the custom JSON is parsed and validated once.
 */
export function costCalculatorFor(customPricingJson: string | undefined): CostCalculator {
  if (!customPricingJson) return getDefaultCostCalculator();
  const cache = stateSlot<{ json: string; calculator: CostCalculator } | { json: undefined }>('cost.custom', () => ({
    json: undefined,
  }));
  if (cache.json === customPricingJson) return (cache as { calculator: CostCalculator }).calculator;
  const calculator = new CostCalculator({ customPricingJson });
  Object.assign(cache, { json: customPricingJson, calculator });
  return calculator;
}
