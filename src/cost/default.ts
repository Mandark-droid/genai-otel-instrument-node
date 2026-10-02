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

/** The calculator for a configuration: shared by default, private with custom pricing. */
export function costCalculatorFor(customPricingJson: string | undefined): CostCalculator {
  return customPricingJson ? new CostCalculator({ customPricingJson }) : getDefaultCostCalculator();
}
