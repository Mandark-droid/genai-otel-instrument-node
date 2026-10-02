/**
 * Cost contract: every vector in contract/cost_vectors.json - the return values
 * of the Python CostCalculator for the shipped pricing table.
 *
 * `cost` in a vector is what Python returned, which is 0.0 for an unknown
 * model. `priced` tells "no price" (this SDK: null) from "priced, and zero".
 */
import { beforeAll, describe, expect, it } from 'vitest';
import contract from '../../contract/cost_vectors.json';
import pricing from '../../src/pricing/llm_pricing.json';
import { CALL_TYPE_CATEGORY, CostCalculator, type GranularCost, type Usage } from '../../src/cost/calculator';
import { getDefaultCostCalculator } from '../../src/cost';
import { setLogger } from '../../src/logger';

interface Vector {
  id: string;
  kind: string;
  model: string;
  call_type: string;
  usage: Usage;
  cost: number | null;
  granular: GranularCost | null;
  pricing_source: string;
  priced: boolean;
  resolved_category: string | null;
  resolved_key: string | null;
  estimated_param_count_billions: number | null;
  deprecation: string | null;
  price_checked: string | null;
  error?: { type: string; message: string };
  custom_pricing_json?: string;
  must_not_resolve_to?: string;
}

const vectors = contract.vectors as unknown as Vector[];
const TOLERANCE = 1e-9;
const RELATIVE = 1e-12;

function expectClose(actual: number | null | undefined, expected: number, label: string): void {
  expect(actual, label).not.toBeNull();
  expect(actual, label).not.toBeUndefined();
  const diff = Math.abs((actual as number) - expected);
  expect(diff, `${label}: got ${actual}, want ${expected}`).toBeLessThanOrEqual(
    Math.max(TOLERANCE * 1e-3, RELATIVE * Math.abs(expected)),
  );
}

const custom = new Map<string, CostCalculator>();
function calculatorFor(vector: Vector): CostCalculator {
  if (vector.custom_pricing_json === undefined) return getDefaultCostCalculator();
  let calculator = custom.get(vector.custom_pricing_json);
  if (!calculator) {
    calculator = new CostCalculator({ customPricingJson: vector.custom_pricing_json });
    custom.set(vector.custom_pricing_json, calculator);
  }
  return calculator;
}

beforeAll(() => {
  // The vectors deliberately include unknown call types, unit mismatches and
  // malformed custom pricing, each of which logs.
  setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  return () => setLogger(undefined);
});

describe('cost vectors', () => {
  it('there are vectors, and their ids are unique', () => {
    expect(vectors.length).toBeGreaterThan(2000);
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(vectors.length);
  });

  it.each(vectors.map((vector) => [vector.id, vector] as const))('%s', (_id, vector) => {
    const calculator = calculatorFor(vector);

    if (vector.error) {
      // The Python calculator raised on this table entry; so does this one.
      expect(vector.error.type).toBe('TypeError');
      expect(() => calculator.calculateCost(vector.model, vector.usage, vector.call_type)).toThrow(TypeError);
      expect(() => calculator.calculateGranularCost(vector.model, vector.usage, vector.call_type)).toThrow(TypeError);
    } else if (!vector.priced) {
      // No price: never a number, so it can never be read as "free".
      expect(vector.cost).toBe(0);
      expect(calculator.calculateCost(vector.model, vector.usage, vector.call_type)).toBeNull();
      expect(calculator.calculateGranularCost(vector.model, vector.usage, vector.call_type)).toBeNull();
    } else {
      expectClose(calculator.calculateCost(vector.model, vector.usage, vector.call_type), vector.cost as number, 'cost');
      const granular = calculator.calculateGranularCost(vector.model, vector.usage, vector.call_type);
      expect(granular).not.toBeNull();
      for (const [part, expected] of Object.entries(vector.granular ?? {})) {
        expectClose(granular?.[part as keyof GranularCost], expected, `granular.${part}`);
      }
      // Bit-for-bit, not merely close: same operations in the same order.
      expect(calculator.calculateCost(vector.model, vector.usage, vector.call_type)).toBe(vector.cost);
    }

    expect(calculator.isPriced(vector.model, vector.call_type), 'priced').toBe(vector.priced);
    expect(calculator.pricingSource(vector.model, vector.call_type), 'pricing_source').toBe(vector.pricing_source);
    expect(calculator.deprecation(vector.model, vector.call_type), 'deprecation').toBe(vector.deprecation);
    expect(calculator.priceChecked(vector.model, vector.call_type), 'price_checked').toBe(vector.price_checked);

    if (vector.resolved_category !== null) {
      expect(calculator.normalizeModelName(vector.model, vector.resolved_category), 'resolved_key').toBe(vector.resolved_key);
    }
    if (vector.call_type === 'chat' && vector.resolved_key === null) {
      const estimated = calculator.extractParamCountFromModelName(vector.model);
      if (vector.estimated_param_count_billions === null) expect(estimated, 'param count').toBeNull();
      else expectClose(estimated, vector.estimated_param_count_billions, 'param count');
    }
    if (vector.must_not_resolve_to !== undefined) {
      expect(calculator.normalizeModelName(vector.model, 'chat')).not.toBe(vector.must_not_resolve_to);
    }
  });
});

describe('cost contract tables', () => {
  it('supported call types and their pricing categories', () => {
    expect(Object.keys(CALL_TYPE_CATEGORY).sort()).toEqual(contract.supported_call_types);
    expect({ ...CALL_TYPE_CATEGORY }).toEqual(contract.call_type_to_pricing_category);
  });

  it('metadata keys are never a pricing category', () => {
    const calculator = getDefaultCostCalculator();
    for (const key of contract.metadata_keys) {
      const registry = (pricing as Record<string, Record<string, unknown>>)[key] ?? {};
      const anyKey = Object.keys(registry)[0];
      expect(anyKey, key).toBeDefined();
      expect(calculator.normalizeModelName(String(anyKey), key), key).toBeNull();
    }
  });

  it.each(['chat', 'embeddings', 'images', 'audio', 'speech_to_text'])('custom pricing category %s is accepted or dropped as in Python', (category) => {
    const probe = new CostCalculator({ customPricingJson: JSON.stringify({ [category]: { 'contract-probe-model': 1.0 } }) });
    const accepted = Object.keys((probe.pricingData[category] as Record<string, unknown>) ?? {}).includes('contract-probe-model');
    expect(accepted).toBe(contract.accepted_custom_pricing_categories.includes(category));
  });

  it.each(contract.local_model_price_tiers.map((tier) => [tier.param_count_billions, tier] as const))(
    'local model price tier at %sB',
    (_params, tier) => {
      expect(getDefaultCostCalculator().localModelPriceTier(tier.param_count_billions)).toEqual(tier.price);
    },
  );

  it.each(contract.case_insensitive_key_collisions.map((entry) => [entry.lowercase, entry] as const))(
    'keys that differ only by case: %s',
    (_lower, entry) => {
      const calculator = getDefaultCostCalculator();
      for (const key of [...entry.keys, entry.lowercase, entry.lowercase.toUpperCase()]) {
        expect(calculator.normalizeModelName(key, entry.category), key).toBe(entry.resolves_to);
      }
    },
  );

  it('no pricing key is integer-like, which a JavaScript object would silently reorder', () => {
    const offenders: string[] = [];
    for (const [category, models] of Object.entries(pricing as Record<string, unknown>)) {
      if (typeof models !== 'object' || models === null) continue;
      for (const key of Object.keys(models)) if (/^(0|[1-9]\d*)$/.test(key)) offenders.push(`${category}.${key}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the default calculator is created once and shared', () => {
    expect(getDefaultCostCalculator()).toBe(getDefaultCostCalculator());
  });
});
