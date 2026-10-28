/**
 * What the framework instrumentors share.
 *
 * Two rules live here.
 *
 * Content. The reference records prompts, instructions and outputs of
 * frameworks on every span, bounded to 200 characters. Here those attributes
 * are written only when content capture is on - the rule the rest of this SDK
 * follows - and bounded the same way. Names, counts and identifiers are always
 * recorded.
 *
 * Session. A framework call belongs to a session. In order: one named in the
 * call, the configured extractor, the session in scope (`withSession`), and
 * last - as the reference does for LangChain and LangGraph - a generated one.
 */
import type { UsageDict } from '../instrumentors/base';
import { PatchingInstrumentor } from '../instrumentors/patching';
import { pyStr, pyTruncate } from '../pycompat';
import { defaultSession, inboundSession, scopedSession } from '../session';

export type Obj = Record<string, unknown>;
export const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/** A version 4 UUID from whatever randomness the runtime has. */
export function uuid4(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export abstract class FrameworkInstrumentor extends PatchingInstrumentor {
  /** Most framework spans carry no usage of their own: the model calls inside them do. */
  protected extractUsage(_result: unknown): UsageDict | null {
    return null;
  }

  /** Bound text to the configured content length; `fallback` characters when none is configured, 0 meaning unlimited. */
  protected bounded(value: unknown, fallback = 200): string {
    const text = typeof value === 'string' ? value : pyStr(value);
    const configured = this.config?.contentMaxLength;
    const limit = typeof configured === 'number' ? configured : fallback;
    return limit > 0 ? pyTruncate(text, limit) : text;
  }

  /** Content for a span attribute: bounded, and only when content capture is on. */
  protected content(value: unknown, fallback = 200): string | undefined {
    if (!this.config?.enableContentCapture || value === undefined || value === null) return undefined;
    return this.bounded(value, fallback);
  }

  /**
   * The session a framework call belongs to. `generate` is the reference's
   * last resort for LangChain and LangGraph: a random id, so that the spans of
   * one call can at least be grouped with each other.
   */
  /**
   * The session of a framework call, as the Python library ranks it (1.46.0): an id in the call's
   * own input, an enclosing `withSession` scope, the framework's own fallbacks (`afterScope`: a
   * LangGraph thread_id), the extractor, then - this SDK only - the `setSession` default, an id an
   * upstream service sent as accepted baggage, and lastly a generated one.
   */
  protected resolveSessionId(
    candidates: unknown[],
    instance: unknown,
    args: unknown[],
    generate: boolean,
    afterScope: unknown[] = [],
  ): string | undefined {
    const first = (values: unknown[]) => values.find((v): v is string => typeof v === 'string' && v.length > 0);
    const own = first(candidates);
    if (own) return own;
    const scoped = scopedSession().sessionId;
    if (scoped) return scoped;
    const framework = first(afterScope);
    if (framework) return framework;
    const extractor = this.config?.sessionIdExtractor;
    if (extractor) {
      try {
        const extracted = extractor(instance, args, isObject(args[0]) ? args[0] : {});
        if (extracted) return String(extracted);
      } catch {
        // an extractor that throws is not a reason to lose the call
      }
    }
    const fallback = defaultSession().sessionId ?? inboundSession().sessionId;
    if (fallback) return fallback;
    return generate ? uuid4() : undefined;
  }
}
