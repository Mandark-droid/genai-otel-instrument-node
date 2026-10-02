import { afterEach, describe, expect, it, vi } from 'vitest';
import { CostCalculator, matchesOnTokenBoundary, type PricingData } from '../../src/cost/calculator';
import { setLogger } from '../../src/logger';

/** A small table in the shape of llm_pricing.json. Test data, not vendored prices. */
function table(): PricingData {
  return {
    chat: {
      'gpt-x': { promptPrice: 0.0025, completionPrice: 0.01 },
      'gpt-x-mini': { promptPrice: 0.00015, completionPrice: 0.0006, cacheReadPrice: 0.000075 },
      o1: { promptPrice: 0.015, completionPrice: 0.06 },
      'claude-s': { promptPrice: 0.003, completionPrice: 0.015, cacheReadPrice: 0.0003, cacheWritePrice: 0.00375 },
      'reasoner-1': { promptPrice: 0.001, completionPrice: 0.002, reasoningPrice: 0.004 },
      'free-model': { promptPrice: 0, completionPrice: 0 },
      'MiniMax-M9': { promptPrice: 0.1, completionPrice: 0.1 },
      'minimax-m9': { promptPrice: 0.2, completionPrice: 0.2 },
      'old-model': { promptPrice: 0.001, completionPrice: 0.001 },
    },
    embeddings: { 'embed-small': 0.00002 },
    images: {
      'img-1': {
        standard: { '1024x1024': 0.04, '512x512': 0.018 },
        hd: { '1024x1024': 0.08 },
      },
      'img-pixels': { standard: { '1000000': 0.025 } },
    },
    audio: {
      'tts-a': { per_1k_chars: 0.015 },
      'stt-a': { per_second: 0.0001 },
      'tok-a': { per_1k_tokens: 0.0025 },
      'legacy-a': 0.1,
      'odd-a': { per_minute: 1 },
    },
    speech_to_text: { 'asr-1': { promptPrice: 0.00015, completionPrice: 0.00015 } },
    deprecated: { 'old-model': 'Retires 2026-12-31; migrate to gpt-x.', 'stt-a': 'Withdrawn.' },
    prices_checked: { 'gpt-x': '2026-08-13', 'tts-a': '2026-08-01' },
  };
}

const calc = (custom?: string) => new CostCalculator({ pricingData: table(), customPricingJson: custom });
const CHAT = { prompt_tokens: 1000, completion_tokens: 500 };

afterEach(() => setLogger(undefined));

describe('matchesOnTokenBoundary', () => {
  it.each([
    ['sa-o1-0k', 'o1', true],
    ['sao10k/fimbulvetr-11b', 'o1', false],
    ['ge-mini', 'mini', true],
    ['gemini-3-flash', 'mini', false],
    ['nova-2-automotive', 'auto', false],
    ['openai-gpt-52', 'gpt-5', false],
    ['openai/gpt-5', 'gpt-5', true],
    ['gpt-5', 'gpt-5', true],
    ['my_gpt-5_proxy', 'gpt-5', true],
    ['gpt-5.1', 'gpt-5', true],
    ['xgpt-5 gpt-5', 'gpt-5', true],
    ['abc', '', false],
    ['a/b', '/', true],
    ['x-key-', '-key-', true],
  ])('%j contains %j on a boundary: %s', (haystack, needle, expected) => {
    expect(matchesOnTokenBoundary(haystack, needle)).toBe(expected);
  });
});

describe('model key resolution', () => {
  it('exact match is case-insensitive', () => {
    expect(calc().normalizeModelName('GPT-X', 'chat')).toBe('gpt-x');
  });

  it('keys that differ only by case collapse to the later one', () => {
    expect(calc().normalizeModelName('minimax-m9', 'chat')).toBe('minimax-m9');
    expect(calc().normalizeModelName('MINIMAX-M9', 'chat')).toBe('minimax-m9');
  });

  it('prefers the longest key that matches on a boundary', () => {
    expect(calc().normalizeModelName('openai/gpt-x-mini-2026-01-01', 'chat')).toBe('gpt-x-mini');
    expect(calc().normalizeModelName('azure/gpt-x-2026-01-01', 'chat')).toBe('gpt-x');
  });

  it('a short key does not capture an unrelated model', () => {
    expect(calc().normalizeModelName('Sao10K/L3-8B-Stheno', 'chat')).toBeNull();
    expect(calc().normalizeModelName('gpt-xx', 'chat')).toBeNull();
    expect(calc().normalizeModelName('xgpt-x', 'chat')).toBeNull();
  });

  it('does not strip whitespace', () => {
    expect(calc().normalizeModelName('gpt-x ', 'chat')).toBe('gpt-x');
    expect(calc().normalizeModelName(' o1x', 'chat')).toBeNull();
  });

  it('never resolves against a metadata registry or a missing category', () => {
    expect(calc().normalizeModelName('old-model', 'deprecated')).toBeNull();
    expect(calc().normalizeModelName('gpt-x', 'prices_checked')).toBeNull();
    expect(calc().normalizeModelName('gpt-x', 'nope')).toBeNull();
  });
});

describe('parameter count from a model name', () => {
  it.each([
    ['smollm2:360m', 0.36],
    ['llama3:7b', 7],
    ['llama3.1:70b', 70],
    ['acme-llama-1.5b-instruct', 1.5],
    ['MMPO_Gemma_7b_gamma1.1', 7],
    ['smollm2-135M_pretrained_400k', 0.135],
    ['gpt2', 0.124],
    ['gpt2-xl', 1.5],
    ['t5-small', 0.06],
    ['t5-xxl', 11],
    ['bert-base-uncased', 0.11],
    ['bert-large-uncased', 0.34],
    ['acme-tiny-model', 0.01],
    ['acme-model-xl', 1.5],
  ])('%s -> %sB', (model, expected) => {
    expect(calc().extractParamCountFromModelName(model)).toBeCloseTo(expected, 12);
  });

  it.each(['gemini-3.8-flash', 'minimax-m2p1', 'stabilityai/stablediffusionxl', 'tinyfish/search', 'acme-model-500k', 'unknown', ''])(
    '%j has none',
    (model) => {
      expect(calc().extractParamCountFromModelName(model)).toBeNull();
    },
  );
});

describe('local model price tiers', () => {
  it.each([
    [0.5, 0.0001, 0.0002],
    [1.0, 0.0003, 0.0006],
    [9.99, 0.0003, 0.0006],
    [10.0, 0.0005, 0.001],
    [19.99, 0.0005, 0.001],
    [20.0, 0.0008, 0.0008],
    [79.99, 0.0008, 0.0008],
    [80.0, 0.0012, 0.0012],
    [500.0, 0.0012, 0.0012],
  ])('%sB -> %s / %s per 1k', (params, prompt, completion) => {
    expect(calc().localModelPriceTier(params)).toEqual({ promptPrice: prompt, completionPrice: completion });
  });
});

describe('chat cost', () => {
  it('prompt and completion tokens at per-1k prices', () => {
    expect(calc().calculateCost('gpt-x', CHAT, 'chat')).toBe((1000 / 1000) * 0.0025 + (500 / 1000) * 0.01);
  });

  it('granular breakdown with cache read, cache write and reasoning', () => {
    const usage = {
      prompt_tokens: 1200,
      completion_tokens: 800,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 150 },
    };
    const claude = calc().calculateGranularCost('claude-s', usage, 'chat');
    expect(claude).toEqual({
      total: 1.2 * 0.003 + 0.8 * 0.015 + 0 + 0.3 * 0.0003 + 0.2 * 0.00375,
      prompt: 1.2 * 0.003,
      completion: 0.8 * 0.015,
      reasoning: 0,
      cache_read: 0.3 * 0.0003,
      cache_write: 0.2 * 0.00375,
    });
    const reasoner = calc().calculateGranularCost('reasoner-1', usage, 'chat');
    expect(reasoner?.reasoning).toBe(0.15 * 0.004);
    expect(reasoner?.cache_read).toBe(0);
    expect(reasoner?.cache_write).toBe(0);
  });

  it('a priced model with zero tokens or a zero price costs 0, which is a measurement', () => {
    expect(calc().calculateCost('gpt-x', {}, 'chat')).toBe(0);
    expect(calc().calculateCost('gpt-x', { total_tokens: 1500 }, 'chat')).toBe(0);
    expect(calc().calculateCost('free-model', CHAT, 'chat')).toBe(0);
    expect(calc().pricingSource('free-model')).toBe('table');
  });

  it('an unknown model has NO cost: null, never 0', () => {
    expect(calc().calculateCost('totally-unknown-model', CHAT, 'chat')).toBeNull();
    expect(calc().calculateGranularCost('totally-unknown-model', CHAT, 'chat')).toBeNull();
    expect(calc().calculateCost('gemini-99-ultra', CHAT, 'chat')).toBeNull();
    expect(calc().pricingSource('totally-unknown-model')).toBe('unpriced');
  });

  it('an unknown local model is estimated from its parameter count', () => {
    expect(calc().calculateCost('acme-llama:7b', CHAT, 'chat')).toBe(1 * 0.0003 + 0.5 * 0.0006);
    expect(calc().pricingSource('acme-llama:7b')).toBe('estimated');
  });

  it('refuses usage values that are not numbers, as the Python arithmetic does', () => {
    expect(() => calc().calculateCost('gpt-x', { prompt_tokens: null, completion_tokens: 5 }, 'chat')).toThrow(TypeError);
    expect(() => calc().calculateCost('gpt-x', { prompt_tokens: '12' }, 'chat')).toThrow(TypeError);
  });
});

describe('embedding cost', () => {
  it('prompt_tokens, falling back to total_tokens', () => {
    expect(calc().calculateCost('embed-small', { prompt_tokens: 1000 }, 'embedding')).toBe(0.00002);
    expect(calc().calculateCost('embed-small', { total_tokens: 2000 }, 'embedding')).toBe(2 * 0.00002);
    expect(calc().calculateCost('embed-small', { prompt_tokens: 400, total_tokens: 1000 }, 'embedding')).toBe(0.4 * 0.00002);
  });

  it('unknown embedding model is null; the plural call type is not a call type', () => {
    expect(calc().calculateCost('acme-embed', { prompt_tokens: 1000 }, 'embedding')).toBeNull();
    expect(calc().calculateCost('embed-small', { prompt_tokens: 1000 }, 'embeddings')).toBeNull();
  });

  it('granular cost for a non-chat call carries only the total', () => {
    expect(calc().calculateGranularCost('embed-small', { prompt_tokens: 1000 }, 'embedding')).toEqual({
      total: 0.00002,
      prompt: 0,
      completion: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });
});

describe('image cost', () => {
  it('per image, by quality and size', () => {
    expect(calc().calculateCost('img-1', { size: '1024x1024' }, 'image')).toBe(0.04);
    expect(calc().calculateCost('img-1', { size: '1024x1024', quality: 'hd', n: 3 }, 'image')).toBe(0.08 * 3);
  });

  it('per million pixels', () => {
    expect(calc().calculateCost('img-pixels', { height: 2048, width: 1024, n: 2 }, 'image')).toBe(
      ((2048 * 1024) / 1_000_000) * 0.025 * 2,
    );
    expect(calc().calculateCost('img-pixels', { n: 2 }, 'image')).toBe(0);
  });

  it('a known model that cannot be priced for this request is 0 with a warning', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    expect(calc().calculateCost('img-1', { quality: 'hd' }, 'image')).toBe(0);
    expect(calc().calculateCost('img-1', { size: '640x480' }, 'image')).toBe(0);
    expect(calc().calculateCost('img-1', { size: '1024x1024', quality: 'ultra' }, 'image')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('unknown image model is null', () => {
    expect(calc().calculateCost('acme-image', { size: '1024x1024' }, 'image')).toBeNull();
  });
});

describe('audio cost', () => {
  it('declared units', () => {
    expect(calc().calculateCost('tts-a', { characters: 2500 }, 'audio')).toBe((2500 / 1000) * 0.015);
    expect(calc().calculateCost('stt-a', { seconds: 90 }, 'audio')).toBe(90 * 0.0001);
    expect(calc().calculateCost('tok-a', { tokens: 1500 }, 'audio')).toBe((1500 / 1000) * 0.0025);
  });

  it('refuses a unit mismatch rather than assume a conversion', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    expect(calc().calculateCost('tts-a', { seconds: 90 }, 'audio')).toBe(0);
    expect(calc().calculateCost('tts-a', {}, 'audio')).toBe(0);
    expect(calc().calculateCost('odd-a', { seconds: 90 }, 'audio')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain('refusing to price');
  });

  it('legacy bare-number entries infer the unit from the usage', () => {
    expect(calc().calculateCost('legacy-a', { characters: 2500 }, 'audio')).toBe((2500 / 1000) * 0.1);
    expect(calc().calculateCost('legacy-a', { seconds: 90 }, 'audio')).toBe(90 * 0.1);
    expect(calc().calculateCost('legacy-a', { tokens: 10 }, 'audio')).toBe(0);
  });

  it('unknown audio model is null', () => {
    expect(calc().calculateCost('acme-voice', { seconds: 90 }, 'audio')).toBeNull();
  });
});

describe('call types', () => {
  it('an unknown call type is not priced, with a warning', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    expect(calc().calculateCost('gpt-x', CHAT, 'rerank')).toBeNull();
    expect(calc().calculateCost('gpt-x', CHAT, '')).toBeNull();
    expect(calc().calculateCost('asr-1', { prompt_tokens: 1000 }, 'speech_to_text')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('with no pricing data at all nothing is priced', () => {
    const empty = new CostCalculator({ pricingData: {} });
    expect(empty.calculateCost('gpt-x', CHAT, 'chat')).toBeNull();
    expect(empty.calculateGranularCost('gpt-x', CHAT, 'chat')).toBeNull();
    expect(empty.pricingSource('gpt-x')).toBe('unpriced');
  });
});

describe('pricingSource', () => {
  it('uses the call type as the table section only when a section has that name', () => {
    // "embedding" is not a section name ("embeddings" is), so the chat table is consulted -
    // and there the size word in the name makes it an "estimated" local model.
    expect(calc().pricingSource('embed-small', 'embedding')).toBe('estimated');
    expect(calc().pricingSource('embed-x9', 'embedding')).toBe('unpriced');
    expect(calc().pricingSource('embed-small', 'embeddings')).toBe('table');
    expect(calc().pricingSource('gpt-x', 'embedding')).toBe('table');
    expect(calc().pricingSource('asr-1', 'speech_to_text')).toBe('table');
    expect(calc().pricingSource('acme:7b', 'audio')).toBe('unpriced');
  });
});

describe('deprecation and price_checked', () => {
  it('reports a deprecation reason through the same alias resolution as pricing', () => {
    expect(calc().deprecation('old-model')).toBe('Retires 2026-12-31; migrate to gpt-x.');
    expect(calc().deprecation('vendor/old-model-2026-01-01')).toBe('Retires 2026-12-31; migrate to gpt-x.');
    expect(calc().deprecation('gpt-x')).toBeNull();
    expect(calc().deprecation('nope')).toBeNull();
  });

  it('finds a deprecation recorded under another category', () => {
    expect(calc().deprecation('stt-a')).toBe('Withdrawn.');
    expect(calc().deprecation('stt-a', 'audio')).toBe('Withdrawn.');
  });

  it('price_checked returns the ISO date or null', () => {
    expect(calc().priceChecked('gpt-x')).toBe('2026-08-13');
    expect(calc().priceChecked('tts-a')).toBe('2026-08-01');
    expect(calc().priceChecked('o1')).toBeNull();
  });

  it('both are null when the registry is absent', () => {
    const bare = new CostCalculator({ pricingData: { chat: { m: { promptPrice: 1, completionPrice: 1 } } } });
    expect(bare.deprecation('m')).toBeNull();
    expect(bare.priceChecked('m')).toBeNull();
  });

  it('stalePrices lists unverified entries and entries verified before the cutoff', () => {
    const stale = calc().stalePrices(1, true, new Date('2026-10-02T00:00:00Z'));
    expect(stale).toContainEqual(['o1', null]);
    expect(stale).toContainEqual(['gpt-x', '2026-08-13']);
    const verifiedOnly = calc().stalePrices(100000, false, new Date('2026-10-02T00:00:00Z'));
    expect(verifiedOnly).toEqual([]);
  });
});

describe('custom pricing', () => {
  it('adds a model, overrides a shipped price, leaves the rest alone', () => {
    const custom = JSON.stringify({
      chat: { 'acme-llm': { promptPrice: 0.001, completionPrice: 0.002 }, 'gpt-x': { promptPrice: 0.5, completionPrice: 1.0 } },
      embeddings: { 'acme-embed': 0.00005 },
    });
    const c = calc(custom);
    expect(c.calculateCost('acme-llm', CHAT, 'chat')).toBe(0.001 + 0.5 * 0.002);
    expect(c.calculateCost('gpt-x', CHAT, 'chat')).toBe(0.5 + 0.5 * 1.0);
    expect(c.calculateCost('o1', CHAT, 'chat')).toBe(0.015 + 0.5 * 0.06);
    expect(c.calculateCost('acme-embed', { prompt_tokens: 1000 }, 'embedding')).toBe(0.00005);
  });

  it('creates a category that the shipped table lacks', () => {
    const c = new CostCalculator({ pricingData: { chat: {} }, customPricingJson: '{"audio":{"v":{"per_second":1}}}' });
    expect(c.calculateCost('v', { seconds: 2 }, 'audio')).toBe(2);
  });

  it('ignores a category it does not accept, with a warning', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    const c = calc('{"speech_to_text":{"acme-asr":{"promptPrice":0.1,"completionPrice":0.1}}}');
    expect(c.pricingSource('acme-asr', 'speech_to_text')).toBe('unpriced');
    expect(String(warn.mock.calls[0]?.[0])).toContain("Unknown pricing category 'speech_to_text'");
  });

  it.each(['{not json', '[1, 2]', '"text"', '{"chat": 5}'])('malformed custom pricing %j is ignored with an error', (bad) => {
    const error = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error });
    const c = calc(bad);
    expect(c.calculateCost('gpt-x', CHAT, 'chat')).toBe(0.0025 + 0.5 * 0.01);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('an empty object changes nothing and says nothing', () => {
    const error = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error });
    expect(calc('{}').calculateCost('gpt-x', CHAT, 'chat')).toBe(0.0025 + 0.5 * 0.01);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('pricingData reassignment', () => {
  it('rebuilds the indices and drops memoised lookups', () => {
    const c = calc();
    expect(c.calculateCost('gpt-x', CHAT, 'chat')).not.toBeNull();
    expect(c.calculateCost('brand-new', CHAT, 'chat')).toBeNull();
    c.pricingData = { chat: { 'brand-new': { promptPrice: 1, completionPrice: 1 } } };
    expect(c.calculateCost('brand-new', CHAT, 'chat')).toBe(1.5);
    expect(c.calculateCost('gpt-x', CHAT, 'chat')).toBeNull();
  });

  it('a non-object value empties the table', () => {
    const c = calc();
    c.pricingData = null as unknown as PricingData;
    expect(c.pricingData).toEqual({});
    expect(c.calculateCost('gpt-x', CHAT, 'chat')).toBeNull();
  });
});
