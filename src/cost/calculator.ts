/**
 * Estimated cost of LLM API calls.
 *
 * A faithful port of `genai_otel/cost_calculator.py`: the same pricing table,
 * the same model-name resolution (case-insensitive exact match, then the
 * longest key that matches on a token boundary), the same parameter-count tiers
 * for local models, and the same arithmetic in the same order, so the figures
 * agree with the Python library to the last bit. `contract/cost_vectors.json`
 * holds the Python results and the contract test checks every one of them.
 *
 * One deliberate difference in the return type, not in the numbers: where the
 * Python calculator returns `0.0` because it has NO price for a model or call
 * type, this one returns `null`. A zero that means "not measured" must not be
 * summed into a spend figure as though the call had been free. A zero that IS a
 * measurement - a free model, zero tokens - is still `0`.
 */
import { logger } from '../logger';
import { defaultPricingData } from '../pricing';

export type Usage = Record<string, unknown>;
export type PricingData = Record<string, unknown>;
export type PricingSource = 'table' | 'estimated' | 'unpriced';

export interface GranularCost {
  total: number;
  prompt: number;
  completion: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

export interface ChatPricing {
  promptPrice?: number;
  completionPrice?: number;
  reasoningPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  [key: string]: unknown;
}

export interface CostCalculatorOptions {
  /** The pricing table. Defaults to the vendored `llm_pricing.json`. */
  pricingData?: PricingData;
  /** `GENAI_CUSTOM_PRICING_JSON`: same shape as the table, merged over it. */
  customPricingJson?: string;
}

/** `call_type` -> section of the pricing table. Anything else is not priced. */
export const CALL_TYPE_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  chat: 'chat',
  embedding: 'embeddings',
  image: 'images',
  audio: 'audio',
});

const DEPRECATED_KEY = 'deprecated';
const PRICES_CHECKED_KEY = 'prices_checked';
/** Metadata registries, not pricing categories; never indexed for model lookup. */
const METADATA_KEYS: ReadonlySet<string> = new Set([DEPRECATED_KEY, PRICES_CHECKED_KEY]);
const CUSTOM_CATEGORIES: ReadonlySet<string> = new Set(['chat', 'embeddings', 'images', 'audio']);
const OTHER_CATEGORIES = ['chat', 'audio', 'embeddings', 'images', 'speech_to_text'] as const;

/** Audio prices carry their unit in the key: unit -> [usage key it bills against, divisor]. */
const AUDIO_UNITS: readonly (readonly [string, string, number])[] = [
  ['per_second', 'seconds', 1],
  ['per_1k_chars', 'characters', 1000],
  ['per_1k_tokens', 'tokens', 1000],
];

/** Approximate parameter counts (billions) for common size words, in lookup order. */
const SIZE_MAP: readonly (readonly [string, number])[] = [
  // T5 family
  ['t5-small', 0.06],
  ['t5-base', 0.22],
  ['t5-large', 0.77],
  ['t5-xl', 3.0],
  ['t5-xxl', 11.0],
  // GPT-2 family
  ['gpt2-small', 0.124],
  ['gpt2-medium', 0.355],
  ['gpt2-large', 0.774],
  ['gpt2-xl', 1.5],
  ['gpt2', 0.124],
  // BERT family
  ['bert-tiny', 0.004],
  ['bert-mini', 0.011],
  ['bert-small', 0.029],
  ['bert-medium', 0.041],
  ['bert-base', 0.11],
  ['bert-large', 0.34],
  // Generic size indicators (fallback)
  ['tiny', 0.01],
  ['mini', 0.02],
  ['small', 0.06],
  ['base', 0.11],
  ['medium', 0.35],
  ['large', 0.77],
  ['xl', 1.5],
  ['xxl', 11.0],
];

const PARAM_COUNT = /(\d+(?:\.\d+)?)(m|b)(?:[^a-z0-9]|$)/;
const ALNUM = /^[\p{L}\p{N}]$/u;

function isAlnum(char: string | undefined): boolean {
  return char !== undefined && ALNUM.test(char);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const hasKey = (object: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/**
 * True if `needle` occurs in `haystack` without splitting a token.
 *
 * Model ids are tokens separated by `-`, `.`, `/`, `:` or `_`. Plain
 * containment treats every position as a candidate, so a short key matches in
 * the middle of an unrelated word and silently bills another model's price:
 * `o1` is inside `sao10k`, `mini` inside `gemini`, `gpt-5` inside
 * `openai-gpt-52`. A match therefore has to be flanked by a separator or the
 * string edge. Where the needle's own first or last character is already a
 * separator it supplies the boundary itself.
 */
export function matchesOnTokenBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const needsLeft = isAlnum(needle[0]);
  const needsRight = isAlnum(needle[needle.length - 1]);
  let start = haystack.indexOf(needle);
  while (start !== -1) {
    const end = start + needle.length;
    const leftOk = !needsLeft || start === 0 || !isAlnum(haystack[start - 1]);
    const rightOk = !needsRight || end === haystack.length || !isAlnum(haystack[end]);
    if (leftOk && rightOk) return true;
    start = haystack.indexOf(needle, start + 1);
  }
  return false;
}

/** A token count as the Python arithmetic sees it: a number, or a TypeError. */
function quantity(value: unknown, name: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new TypeError(`usage.${name} must be a number, got ${typeName(value)}`);
}

function usageNumber(usage: Usage, key: string, fallback: number): number {
  return hasKey(usage, key) ? quantity(usage[key], key) : fallback;
}

function price(pricing: Record<string, unknown>, key: string): number {
  return hasKey(pricing, key) ? quantity(pricing[key], key) : 0.0;
}

export class CostCalculator {
  private data: PricingData = {};
  /** category -> lowercased key -> original key */
  private exactIndex = new Map<string, Map<string, string>>();
  /** category -> [lowercased key, original key], longest first */
  private substrIndex = new Map<string, [string, string][]>();
  private normCache = new Map<string, string | null>();
  private chatPricingCache = new Map<string, ChatPricing | null>();

  constructor(options: CostCalculatorOptions = {}) {
    this.pricingData = options.pricingData ?? defaultPricingData();
    if (options.customPricingJson) this.mergeCustomPricing(options.customPricingJson);
  }

  /**
   * The pricing table. Assigning it rebuilds the lookup indices and clears the
   * memo caches. The default table is shared and must not be mutated in place.
   */
  get pricingData(): PricingData {
    return this.data;
  }

  set pricingData(value: PricingData) {
    this.data = isPlainObject(value) ? value : {};
    this.buildIndices();
  }

  private buildIndices(): void {
    this.exactIndex = new Map();
    this.substrIndex = new Map();
    this.normCache = new Map();
    this.chatPricingCache = new Map();
    for (const [category, models] of Object.entries(this.data)) {
      if (!isPlainObject(models)) continue;
      // Indexing a metadata registry would let a call_type of "deprecated"
      // resolve model names against it.
      if (METADATA_KEYS.has(category)) continue;
      const lowered: [string, string][] = Object.keys(models).map((key) => [key.toLowerCase(), key]);
      // Keys that differ only by case collapse to one entry; the later wins.
      this.exactIndex.set(category, new Map(lowered));
      // Longest keys first so a substring match prefers the most specific model.
      // The sort is stable, so equal lengths keep their table order.
      const byLength = lowered
        .map((pair) => ({ pair, length: [...pair[0]].length }))
        .sort((a, b) => b.length - a.length)
        .map((entry) => entry.pair);
      this.substrIndex.set(category, byLength);
    }
  }

  private mergeCustomPricing(customPricingJson: string): void {
    let custom: unknown;
    try {
      custom = JSON.parse(customPricingJson);
    } catch (error) {
      logger.error(`Failed to decode custom pricing JSON: ${String(error)}. Custom pricing will be ignored.`);
      return;
    }
    if (!isPlainObject(custom)) {
      logger.error(`Custom pricing must be a JSON object/dict. Got: ${typeName(custom)}`);
      return;
    }
    let copied = false;
    for (const [category, models] of Object.entries(custom)) {
      if (!CUSTOM_CATEGORIES.has(category)) {
        logger.warn(
          `Unknown pricing category '${category}' in custom pricing. Valid categories: chat, embeddings, images, audio`,
        );
        continue;
      }
      if (!isPlainObject(models)) {
        logger.error(`Custom pricing for category '${category}' must be a dict. Got: ${typeName(models)}`);
        continue;
      }
      // The table may be the shared bundled one: copy what is about to change
      // instead of writing through it into every other calculator.
      if (!copied) {
        this.data = { ...this.data };
        copied = true;
      }
      const existing = this.data[category];
      const target: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
      this.data[category] = target;
      for (const [modelName, pricing] of Object.entries(models)) {
        target[modelName] = pricing;
        logger.info(`Added custom pricing for ${category} model '${modelName}'`);
      }
    }
    // Rebuild lookup indices and drop memo caches so merged pricing is visible.
    this.buildIndices();
  }

  private category(name: string): Record<string, unknown> | undefined {
    const value = this.data[name];
    return isPlainObject(value) ? value : undefined;
  }

  private hasPricingData(): boolean {
    return Object.keys(this.data).length > 0;
  }

  /**
   * Resolve a model name to its pricing key within one section of the table:
   * case-insensitive exact match first, then the longest key that matches on a
   * token boundary. Memoised per (model, category), negative results included.
   */
  normalizeModelName(model: string, category: string): string | null {
    const cacheKey = `${category}\u0000${model}`;
    const cached = this.normCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = this.resolveModelKey(model, category);
    this.normCache.set(cacheKey, result);
    return result;
  }

  private resolveModelKey(model: string, category: string): string | null {
    const exact = this.exactIndex.get(category);
    if (!exact || exact.size === 0) return null;
    const normalized = model.toLowerCase();
    const hit = exact.get(normalized);
    if (hit !== undefined) return hit;
    for (const [lowerKey, originalKey] of this.substrIndex.get(category) ?? []) {
      // Containment alone is not enough: a short key ("o1", "o3", "auto")
      // matches inside an unrelated name and bills that model's price.
      if (normalized.includes(lowerKey) && matchesOnTokenBoundary(normalized, lowerKey)) return originalKey;
    }
    return null;
  }

  /**
   * Parameter count in billions parsed from an Ollama / HuggingFace style model
   * name (`llama3:70b`, `smollm2:360m`, `bert-base-uncased`), or null.
   */
  extractParamCountFromModelName(model: string): number | null {
    const lower = model.toLowerCase();

    // Explicit size token: digits, optional decimal, then m or b, closed by any
    // non-alphanumeric character or the end of the name.
    const match = PARAM_COUNT.exec(lower);
    if (match) {
      const value = Number.parseFloat(match[1] ?? '');
      return match[2] === 'm' ? value / 1000 : value;
    }

    // Size words. The generic ones are short enough to sit inside unrelated
    // words - "mini" in "gemini", "xl" in "sdxl" - and a bare containment test
    // would invent a parameter count, and from it a fabricated price.
    for (const [sizeKey, paramCount] of SIZE_MAP) {
      if (lower.includes(sizeKey) && matchesOnTokenBoundary(lower, sizeKey)) return paramCount;
    }
    return null;
  }

  /** Price tier for a local model by parameter count. Indicative, not a billable figure. */
  localModelPriceTier(paramCountBillions: number): { promptPrice: number; completionPrice: number } {
    if (paramCountBillions < 1.0) return { promptPrice: 0.0001, completionPrice: 0.0002 };
    if (paramCountBillions < 10.0) return { promptPrice: 0.0003, completionPrice: 0.0006 };
    if (paramCountBillions < 20.0) return { promptPrice: 0.0005, completionPrice: 0.001 };
    if (paramCountBillions < 80.0) return { promptPrice: 0.0008, completionPrice: 0.0008 };
    return { promptPrice: 0.0012, completionPrice: 0.0012 };
  }

  /** The chat price for a model: its table entry, a local-size tier, or null. Memoised. */
  private resolveChatPricing(model: string): ChatPricing | null {
    const cached = this.chatPricingCache.get(model);
    if (cached !== undefined) return cached;

    let pricing: ChatPricing | null;
    const modelKey = this.normalizeModelName(model, 'chat');
    if (modelKey !== null) {
      const entry = this.category('chat')?.[modelKey];
      pricing = isPlainObject(entry) ? (entry as ChatPricing) : null;
    } else {
      const paramCount = this.extractParamCountFromModelName(model);
      if (paramCount !== null) {
        pricing = this.localModelPriceTier(paramCount);
        logger.info(
          `Using fallback pricing for unknown local model '${model}' with ${paramCount.toFixed(2)}B parameters: ` +
            `$${(pricing.promptPrice ?? 0).toFixed(4)} prompt / $${(pricing.completionPrice ?? 0).toFixed(4)} completion per 1k tokens`,
        );
      } else {
        logger.debug(`Pricing not found for chat model: ${model}`);
        pricing = null;
      }
    }
    this.chatPricingCache.set(model, pricing);
    return pricing;
  }

  /**
   * Whether `calculateCost` has a price to apply for this model and call type.
   * False means the result is `null`: not measured, as opposed to free.
   */
  isPriced(model: string, callType: string): boolean {
    if (!this.hasPricingData()) return false;
    const category = CALL_TYPE_CATEGORY[callType];
    if (category === undefined) return false;
    if (callType === 'chat') return this.resolveChatPricing(model) !== null;
    return this.normalizeModelName(model, category) !== null;
  }

  /**
   * Cost in USD for one request, or `null` when no price is known.
   *
   * For chat requests `calculateGranularCost` gives the breakdown.
   */
  calculateCost(model: string, usage: Usage, callType: string): number | null {
    if (!this.hasPricingData()) return null;
    switch (callType) {
      case 'chat':
        return this.chatCostGranular(model, usage)?.total ?? null;
      case 'embedding':
        return this.embeddingCost(model, usage);
      case 'image':
        return this.imageCost(model, usage);
      case 'audio':
        return this.audioCost(model, usage);
      default:
        logger.warn(`Unknown call type '${callType}' for cost calculation.`);
        return null;
    }
  }

  /**
   * Cost breakdown: total, prompt, completion, reasoning, cache_read,
   * cache_write. Non-chat requests carry only `total`. `null` when no price is
   * known.
   */
  calculateGranularCost(model: string, usage: Usage, callType: string): GranularCost | null {
    if (!this.hasPricingData()) return null;
    if (callType === 'chat') return this.chatCostGranular(model, usage);
    const total = this.calculateCost(model, usage, callType);
    if (total === null) return null;
    return { total, prompt: 0.0, completion: 0.0, reasoning: 0.0, cache_read: 0.0, cache_write: 0.0 };
  }

  private chatCostGranular(model: string, usage: Usage): GranularCost | null {
    const pricing = this.resolveChatPricing(model);
    if (pricing === null) return null;

    const promptTokens = usageNumber(usage, 'prompt_tokens', 0);
    const completionTokens = usageNumber(usage, 'completion_tokens', 0);
    const prompt = (promptTokens / 1000) * price(pricing, 'promptPrice');
    const completion = (completionTokens / 1000) * price(pricing, 'completionPrice');

    // Reasoning tokens (OpenAI o-series), priced only where the entry says so.
    let reasoningTokens = 0;
    if (hasKey(usage, 'completion_tokens_details')) {
      const details = usage.completion_tokens_details;
      if (!isPlainObject(details)) {
        throw new TypeError(`usage.completion_tokens_details must be an object, got ${typeName(details)}`);
      }
      reasoningTokens = usageNumber(details, 'reasoning_tokens', 0);
    }
    let reasoning = 0.0;
    if (reasoningTokens > 0 && hasKey(pricing, 'reasoningPrice')) {
      reasoning = (reasoningTokens / 1000) * price(pricing, 'reasoningPrice');
    }

    // Prompt-cache tokens (Anthropic), likewise.
    const cacheReadTokens = usageNumber(usage, 'cache_read_input_tokens', 0);
    const cacheWriteTokens = usageNumber(usage, 'cache_creation_input_tokens', 0);
    let cacheRead = 0.0;
    let cacheWrite = 0.0;
    if (cacheReadTokens > 0 && hasKey(pricing, 'cacheReadPrice')) {
      cacheRead = (cacheReadTokens / 1000) * price(pricing, 'cacheReadPrice');
    }
    if (cacheWriteTokens > 0 && hasKey(pricing, 'cacheWritePrice')) {
      cacheWrite = (cacheWriteTokens / 1000) * price(pricing, 'cacheWritePrice');
    }

    // Summed in this order; floating-point addition is not associative.
    const total = prompt + completion + reasoning + cacheRead + cacheWrite;
    return { total, prompt, completion, reasoning, cache_read: cacheRead, cache_write: cacheWrite };
  }

  private embeddingCost(model: string, usage: Usage): number | null {
    const modelKey = this.normalizeModelName(model, 'embeddings');
    if (modelKey === null) {
      logger.debug(`Pricing not found for embedding model: ${model}`);
      return null;
    }
    const pricePer1k = quantity(this.category('embeddings')?.[modelKey], modelKey);
    // prompt_tokens, or total_tokens when that is absent or zero.
    const totalTokens = usageNumber(usage, 'prompt_tokens', 0) || usageNumber(usage, 'total_tokens', 0);
    return (totalTokens / 1000) * pricePer1k;
  }

  private imageCost(model: string, usage: Usage): number | null {
    const modelKey = this.normalizeModelName(model, 'images');
    if (modelKey === null) {
      logger.debug(`Pricing not found for image model: ${model}`);
      return null;
    }
    const pricingInfo = this.category('images')?.[modelKey];
    const quality = hasKey(usage, 'quality') ? String(usage.quality) : 'standard';
    const size = usage.size;
    const n = usageNumber(usage, 'n', 1);

    if (!isPlainObject(pricingInfo)) {
      throw new TypeError(`images.${modelKey} must be an object, got ${typeName(pricingInfo)}`);
    }
    if (!hasKey(pricingInfo, quality)) {
      logger.warn(`Quality '${quality}' not found for image model ${modelKey}`);
      return 0.0;
    }
    const byQuality = pricingInfo[quality];
    if (!isPlainObject(byQuality)) {
      // A table entry in the wrong shape. The Python calculator raises here too
      // (`"1000000" in <float>`); the caller logs it and records no cost.
      throw new TypeError(`images.${modelKey}.${quality} must be an object, got ${typeName(byQuality)}`);
    }

    // Priced per million pixels.
    if (hasKey(byQuality, '1000000')) {
      const pricePerMillionPixels = quantity(byQuality['1000000'], '1000000');
      const height = usageNumber(usage, 'height', 0);
      const width = usageNumber(usage, 'width', 0);
      return ((height * width) / 1_000_000) * pricePerMillionPixels * n;
    }

    if (!size) {
      logger.warn(`Image size not provided for model ${modelKey}`);
      return 0.0;
    }
    const sizeKey = String(size);
    if (!hasKey(byQuality, sizeKey)) {
      logger.warn(`Size '${sizeKey}' not found for image model ${modelKey} with quality '${quality}'`);
      return 0.0;
    }
    return quantity(byQuality[sizeKey], sizeKey) * n;
  }

  /**
   * An audio entry is either a declared-unit mapping (`{"per_second": ...}`,
   * `{"per_1k_chars": ...}`, `{"per_1k_tokens": ...}`) or a bare number in the
   * legacy shape, where the unit is inferred from what the caller passed. A
   * declared unit that the caller did not bill in is refused, not converted.
   */
  private audioCost(model: string, usage: Usage): number | null {
    const modelKey = this.normalizeModelName(model, 'audio');
    if (modelKey === null) {
      logger.debug(`Pricing not found for audio model: ${model}`);
      return null;
    }
    const pricing = this.category('audio')?.[modelKey];

    if (isPlainObject(pricing)) {
      for (const [unit, usageKey, divisor] of AUDIO_UNITS) {
        if (!hasKey(pricing, unit)) continue;
        if (hasKey(usage, usageKey)) return (quantity(usage[usageKey], usageKey) / divisor) * quantity(pricing[unit], unit);
        const supplied = Object.keys(usage).sort();
        logger.warn(
          `Audio model ${modelKey} is priced ${unit} but usage supplied ${supplied.length > 0 ? supplied.join(', ') : 'nothing'}; ` +
            'refusing to price rather than assume a conversion.',
        );
        return 0.0;
      }
      logger.warn(`Audio model ${modelKey} has no recognised price unit`);
      return 0.0;
    }

    // Legacy shape: a bare number whose unit is whatever the caller implies.
    const flat = quantity(pricing, modelKey);
    if (hasKey(usage, 'characters')) return (quantity(usage.characters, 'characters') / 1000) * flat;
    if (hasKey(usage, 'seconds')) return quantity(usage.seconds, 'seconds') * flat;
    logger.warn(`Could not determine usage unit for audio model ${modelKey}. Expected 'characters' or 'seconds'.`);
    return 0.0;
  }

  /**
   * Where this model's price came from.
   *
   * `table`: an entry in the pricing file. `estimated`: no entry; inferred from
   * the parameter count in the model name (indicative only). `unpriced`: no
   * price could be determined.
   *
   * The call type selects a section of the table only when a section has that
   * exact name; otherwise the chat section is consulted. That is the Python
   * behaviour, and it means `embedding` (singular) looks in `chat`.
   */
  pricingSource(model: string, callType = 'chat'): PricingSource {
    const category = hasKey(this.data, callType) ? callType : 'chat';
    if (this.normalizeModelName(model, category)) return 'table';
    if (category === 'chat' && this.extractParamCountFromModelName(model) !== null) return 'estimated';
    return 'unpriced';
  }

  private registryLookup(registryKey: string, model: string, callType: string): string | null {
    const registry = this.data[registryKey];
    if (!isPlainObject(registry) || Object.keys(registry).length === 0) return null;
    const category = hasKey(this.data, callType) ? callType : 'chat';
    const key = this.normalizeModelName(model, category);
    if (key && hasKey(registry, key)) return String(registry[key]);
    // A model may be priced in one category but registered under a key
    // resolved from another.
    for (const other of OTHER_CATEGORIES) {
      if (other === category || !hasKey(this.data, other)) continue;
      const otherKey = this.normalizeModelName(model, other);
      if (otherKey && hasKey(registry, otherKey)) return String(registry[otherKey]);
    }
    return null;
  }

  /**
   * Why this model is deprecated, or null. A deprecated model still has a real
   * price and stays `table`; this adds the time signal.
   */
  deprecation(model: string, callType = 'chat'): string | null {
    return this.registryLookup(DEPRECATED_KEY, model, callType);
  }

  /** ISO date this model's price was last confirmed against the vendor's page, or null. */
  priceChecked(model: string, callType = 'chat'): string | null {
    return this.registryLookup(PRICES_CHECKED_KEY, model, callType);
  }

  /**
   * Pricing keys due a re-check: verified longer ago than `olderThanDays`, plus -
   * unless disabled - every entry never verified at all.
   */
  stalePrices(olderThanDays = 180, includeUnverified = true, today: Date = new Date()): [string, string | null][] {
    const registry = isPlainObject(this.data[PRICES_CHECKED_KEY]) ? (this.data[PRICES_CHECKED_KEY] as Record<string, unknown>) : {};
    const cutoff = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - olderThanDays * 86400000;
    const out: [string, string | null][] = [];
    for (const [category, models] of Object.entries(this.data)) {
      if (METADATA_KEYS.has(category) || !isPlainObject(models)) continue;
      for (const key of Object.keys(models)) {
        const stamped = registry[key];
        if (stamped === undefined || stamped === null) {
          if (includeUnverified) out.push([key, null]);
          continue;
        }
        const text = String(stamped);
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Number.NaN;
        // An unparseable date is itself a problem.
        if (Number.isNaN(parsed) || parsed < cutoff) out.push([key, text]);
      }
    }
    return out.sort((a, b) => {
      const left = a[1] ?? '';
      const right = b[1] ?? '';
      if (left !== right) return left < right ? -1 : 1;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  }
}
