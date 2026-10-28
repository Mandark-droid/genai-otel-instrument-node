/**
 * A small bounded cache of detector results. Port of
 * `genai_otel/evaluation/result_cache.py`.
 *
 * A detector is asked about the same text more often than it looks: a block
 * policy checks the prompt before the request and again when the span ends, a
 * retry or an agent loop repeats a request word for word, and a toxicity score
 * awaited ahead of a span's end is asked for again when the span is annotated.
 * Each detector keeps its last results so that the analysis runs once.
 *
 * The key is a digest of the analysed text, its length, and every setting the
 * result depends on - never the text itself. Entries are stored without the
 * analysed text (and, for PII, without the text of each finding or the redacted
 * copy); the detector puts those back from the caller's text on a hit.
 *
 * `cacheSize: 0` (`GENAI_EVALUATION_CACHE_SIZE=0`) keeps nothing at all.
 */

/** A setting a result depends on; arrays stand for Python tuples, `Set`s for frozensets. */
export type CacheSetting = string | number | boolean | null | readonly CacheSetting[] | ReadonlySet<string>;

/** `max(0, int(size))`; anything that is not a number keeps nothing. */
function sizeOf(size: unknown): number {
  const value = typeof size === 'number' ? size : typeof size === 'string' && size.trim() !== '' ? Number(size) : NaN;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function settingKey(setting: CacheSetting): unknown {
  if (setting instanceof Set) return { set: [...setting].sort() };
  if (Array.isArray(setting)) return (setting as readonly CacheSetting[]).map(settingKey);
  return setting;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Least-recently-used results, keyed by a digest of the analysed text. Values are copied in and out. */
export class ResultCache<T> {
  private readonly maxSize: number;
  private readonly entries = new Map<string, T>();

  constructor(maxSize: unknown) {
    this.maxSize = sizeOf(maxSize);
  }

  get enabled(): boolean {
    return this.maxSize > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The key for `text` analysed under `settings`, or `undefined` when this
   * call is not to be cached: the cache is off, or the input is not text.
   */
  key(text: unknown, ...settings: CacheSetting[]): string | undefined {
    if (this.maxSize <= 0 || typeof text !== 'string') return undefined;
    // UTF-16 code units, so that text with a lone surrogate keeps a digest of its own.
    const digest = textDigest(text);
    try {
      return JSON.stringify([digest, text.length, ...settings.map(settingKey)]);
    } catch {
      return undefined;
    }
  }

  get(key: string | undefined): T | undefined {
    if (key === undefined) return undefined;
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Most recently used goes last.
    this.entries.delete(key);
    this.entries.set(key, value);
    return clone(value);
  }

  put(key: string | undefined, value: T): void {
    if (key === undefined || this.maxSize <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, clone(value));
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * A 106-bit digest of a string's UTF-16 code units (two independently seeded 53-bit cyrb53 hashes),
 * so a cache key never holds the text itself. Plain JavaScript: this file is part of the browser and
 * React Native bundles, which cannot use node:crypto. It only has to keep a few hundred cached
 * results apart (the key also carries the text's length and the settings), not resist an attacker.
 */
function textDigest(text: string): string {
  const half = (seed: number): string => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return half(0x9e3779b9) + half(0x85ebca6b);
}
