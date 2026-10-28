/** Detector result caches (Python 1.46.0 `result_cache.py`) and the settings that shape them. */
import { describe, expect, it, vi } from 'vitest';
import {
  BiasDetector,
  HallucinationDetector,
  PIIDetector,
  RestrictedTopicsDetector,
  ToxicityDetector,
} from '../../src/evaluation';
import { ResultCache } from '../../src/evaluation/result-cache';
import { loadConfig } from '../../src/config';

describe('ResultCache', () => {
  it('size: a number or numeric string, truncated, never negative; anything else keeps nothing', () => {
    expect(new ResultCache('3').enabled).toBe(true);
    expect(new ResultCache(2.9).enabled).toBe(true);
    for (const size of [0, -4, ' ', 'many', NaN, Infinity, null, {}]) expect(new ResultCache(size).enabled).toBe(false);
  });

  it('keys: text only, settings as sets and lists, the same text and settings give the same key', () => {
    const cache = new ResultCache<number>(4);
    expect(cache.key(42 as unknown as string)).toBeUndefined();
    const a = cache.key('hello', new Set(['b', 'a']), [1, [2, 3]], null);
    expect(a).toBe(cache.key('hello', new Set(['a', 'b']), [1, [2, 3]], null));
    expect(a).not.toBe(cache.key('hello', new Set(['a']), [1, [2, 3]], null));
    expect(cache.key('hellp')).not.toBe(cache.key('hello'));
    // Not serialisable: not cached.
    expect(cache.key('hello', BigInt(10) as never)).toBeUndefined();
    expect(new ResultCache(0).key('hello')).toBeUndefined();
  });

  it('least recently used goes first; values are copies; clear empties it', () => {
    const cache = new ResultCache<{ n: number }>(2);
    const [a, b, c] = ['a', 'b', 'c'].map((t) => cache.key(t));
    cache.put(a, { n: 1 });
    cache.put(b, { n: 2 });
    // A copy: the cached value is untouched, and a is now the most recent.
    cache.get(a)!.n = 99;
    cache.put(c, { n: 3 });
    expect(cache.get(a)).toEqual({ n: 1 });
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(undefined)).toBeUndefined();
    cache.put(undefined, { n: 4 });
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('detector caches', () => {
  it('PII: a repeated text is answered from the cache, entities and redaction rebuilt for it', () => {
    const detector = new PIIDetector({ enabled: true, mode: 'redact', cacheSize: 8 });
    const first = detector.detect('mail jane.doe@example.com now');
    const second = detector.detect('mail jane.doe@example.com now');
    expect(second).toEqual(first);
    expect(second.entities[0]!.text).toBe('jane.doe@example.com');
    expect(new PIIDetector({ enabled: true, cacheSize: 0 }).detect('jane.doe@example.com').hasPii).toBe(true);
  });

  it('bias, restricted topics and hallucination answer a repeated text from the cache, with its own text', () => {
    const bias = new BiasDetector({ enabled: true, cacheSize: 8 });
    expect(bias.detect('Women are bad drivers')).toEqual(bias.detect('Women are bad drivers'));
    const topics = new RestrictedTopicsDetector({ enabled: true, cacheSize: 8, restrictedTopics: ['medical_advice'] });
    expect(topics.detect('What dosage of insulin should I take?')).toEqual(topics.detect('What dosage of insulin should I take?'));
    const hallucination = new HallucinationDetector({ enabled: true, cacheSize: 8 });
    const claim = 'Studies show that 97% of users agree, according to experts.';
    expect(hallucination.detect(claim, 'a context')).toEqual(hallucination.detect(claim, 'a context'));
    expect(hallucination.detect(claim).isHallucination).toBe(hallucination.detect(claim, '').isHallucination);
  });

  it('toxicity: a scored result is cached, a failed one is asked again; an async failure is logged, not thrown', async () => {
    const scorer = vi.fn(() => ({ toxicity: 0.9 }));
    const detector = new ToxicityDetector({ enabled: true, cacheSize: 8, quantize: true }, scorer);
    expect(detector.detect('you idiot').isToxic).toBe(true);
    expect(detector.detect('you idiot').isToxic).toBe(true);
    expect(scorer).toHaveBeenCalledTimes(1);

    const failing = new ToxicityDetector({ enabled: true, cacheSize: 8 }, () => Promise.reject(new Error('down')));
    await expect(failing.measureAsync('text')).resolves.toBeUndefined();
    expect(failing.measure('text')).toBeUndefined();
  });
});

describe('evaluation settings (OTelConfig.__post_init__)', () => {
  const load = (overrides: Record<string, unknown>, env: Record<string, string> = {}) => loadConfig(overrides as never, env);

  it('an unknown evaluation mode warns and becomes background; known modes are kept', () => {
    expect(load({}, { GENAI_EVALUATION_MODE: 'Inline' }).evaluationMode).toBe('inline');
    expect(load({}, { GENAI_EVALUATION_MODE: 'later' }).evaluationMode).toBe('background');
  });

  it.each([
    ['nan', 5],
    ['-1', 5],
    ['inf', 5],
    ['99999', 3600],
    ['2.5', 2.5],
  ])('shutdown timeout %s -> %s', (raw, expected) => {
    expect(load({}, { GENAI_EVALUATION_SHUTDOWN_TIMEOUT: raw }).evaluationShutdownTimeout).toBe(expected);
  });

  it('shutdown timeout given as an option: a number, a boolean, anything else is the default', () => {
    expect(load({ evaluationShutdownTimeout: 7 }).evaluationShutdownTimeout).toBe(7);
    expect(load({ evaluationShutdownTimeout: true }).evaluationShutdownTimeout).toBe(1);
    expect(load({ evaluationShutdownTimeout: {} }).evaluationShutdownTimeout).toBe(5);
  });

  it('cache size: negative is none, a boolean or garbage is the default', () => {
    expect(load({ evaluationCacheSize: -3 }).evaluationCacheSize).toBe(0);
    expect(load({ evaluationCacheSize: '12' }).evaluationCacheSize).toBe(12);
    expect(load({ evaluationCacheSize: true }).evaluationCacheSize).toBe(256);
    expect(load({ evaluationCacheSize: 'lots' }).evaluationCacheSize).toBe(256);
    expect(load({ evaluationCacheSize: Infinity }).evaluationCacheSize).toBe(256);
  });

  it('character limits default when unset, never negative; zero under a hardened profile', () => {
    expect(load({ evaluationMaxChars: null }).evaluationMaxChars).toBe(1500);
    expect(load({ evaluationMaxChars: -9 }).evaluationMaxChars).toBe(0);
    expect(load({ toxicityMaxChars: 'x' }).toxicityMaxChars).toBe(500);
    expect(load({}, { GENAI_PROFILE: 'strict' }).evaluationMaxChars).toBe(0);
  });

  it('queue size at least one; torch threads a positive whole number or unset', () => {
    expect(load({ evaluationQueueSize: 0 }).evaluationQueueSize).toBe(1);
    expect(load({ evaluationQueueSize: 'x' }).evaluationQueueSize).toBe(1000);
    const threads: [unknown, number | undefined][] = [['4', 4], [2, 2], [0, undefined], [true, undefined], [null, undefined], ['x', undefined], [1.5, undefined]];
    for (const [value, expected] of threads) expect(load({ toxicityTorchThreads: value }).toxicityTorchThreads).toBe(expected);
    expect(load({ toxicityQuantize: 'yes' }).toxicityQuantize).toBe(true);
  });

  it('a blank or invalid number in the environment is the default', () => {
    expect(load({}, { GENAI_EVALUATION_QUEUE_SIZE: '  ' }).evaluationQueueSize).toBe(1000);
    expect(load({}, { GENAI_EVALUATION_QUEUE_SIZE: 'many' }).evaluationQueueSize).toBe(1000);
  });
});
