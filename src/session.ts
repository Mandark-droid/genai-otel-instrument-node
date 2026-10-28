/**
 * Session scope: one `session.id` across every span of a conversation.
 *
 * Backends group traces into sessions by `session.id` (or `gen_ai.conversation.id`); a run
 * whose spans carry neither produces no session at all. The reference library resolves it per
 * span (`session_id_extractor`, ported as `sessionIdExtractor`) and, from 1.45.0, also:
 *
 *   withSession('chat-41', () => handle(request))   // everything started inside (Python: session())
 *   setSession('chat-41')                            // everything from now on (this SDK only)
 *
 * Both put `session.id` and `gen_ai.conversation.id` (and `user.id`, when given) on every span
 * started in scope, whichever instrumentation starts it. An extractor, where configured, still
 * wins for the spans it applies to.
 *
 * As in Python 1.45.0, `SessionSpanProcessor` also fills those keys on a span that lacks them from
 * its parent span, so a session an instrumentor resolves for a framework span (a LangGraph thread,
 * a CrewAI crew) reaches every span beneath it; OpenInference `setSession()` / `setUser()` context
 * values are read by their key names, without depending on OpenInference. Turned off with
 * GENAI_ENABLE_SESSION_PROPAGATION=false (explicit `withSession` / `setSession` still apply).
 *
 * Across services the ids can travel as W3C baggage (Python 1.46.0), opt-in on each side, because
 * baggage reaches every outbound call and inbound baggage is whatever the caller chose to send:
 *
 * - GENAI_SESSION_BAGGAGE_KEYS: the ids a service sends (`withSession` puts them in baggage).
 * - GENAI_SESSION_BAGGAGE_ACCEPT: the ids it takes from inbound baggage. Set it only where callers
 *   are trusted, never on a service browsers reach. An accepted id ranks below every id the
 *   service resolves itself.
 *
 * `SessionBaggagePropagator` enforces both lists on the wire. A key a span already carries is
 * never overwritten.
 */
import {
  type Baggage,
  type Context,
  context,
  createContextKey,
  diag,
  propagation,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  trace,
} from '@opentelemetry/api';
import { W3CBaggagePropagator } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { logger } from './logger';
import { ATTR } from './semconv';
import { globalState } from './state';

export interface SessionScope {
  sessionId?: string;
  userId?: string;
}

export interface SessionOptions {
  userId?: string;
}

// createContextKey is Symbol.for(): every copy of this package shares the key.
const SESSION_KEY = createContextKey('traceverse.genai-otel-instrument.session');
const DEFAULT_SLOT = 'session.default';

// OpenInference's setSession() / setUser() store the ids under these keys (also Symbol.for()), so
// reading them by name keeps those blocks working for our spans with no dependency on it.
const OPENINFERENCE_SESSION_KEY = createContextKey('OpenInference SDK Context Key session.id');
const OPENINFERENCE_USER_KEY = createContextKey('OpenInference SDK Context Key user.id');

const SUPPORTED_BAGGAGE_KEYS = [ATTR.SESSION_ID, ATTR.USER_ID] as const;
type BaggageKey = (typeof SUPPORTED_BAGGAGE_KEYS)[number];

// An accepted id is an attribute value chosen by another process. Anything longer or containing
// control characters is dropped rather than recorded.
const MAX_BAGGAGE_ID_LENGTH = 256;

interface Propagation {
  enabled: boolean;
  send: BaggageKey[];
  accept: BaggageKey[];
}

let settings: Propagation = { enabled: true, send: [], accept: [] };

/** A GENAI_SESSION_BAGGAGE_* value as keys. Unset or empty means none; unknown names are ignored. */
export function parseBaggageKeys(raw: string | undefined): BaggageKey[] {
  if (!raw) return [];
  const keys = new Set(raw.split(',').map((key) => key.trim()));
  return SUPPORTED_BAGGAGE_KEYS.filter((key) => keys.has(key));
}

/** Set by `instrument()`: GENAI_ENABLE_SESSION_PROPAGATION and the baggage keys. */
export function configureSessionPropagation(options: {
  enabled?: boolean;
  send?: readonly string[];
  accept?: readonly string[];
}): void {
  const enabled = options.enabled ?? true;
  const known = (keys: readonly string[] | undefined) => SUPPORTED_BAGGAGE_KEYS.filter((key) => keys?.includes(key));
  settings = { enabled, send: enabled ? known(options.send) : [], accept: enabled ? known(options.accept) : [] };
}

/** Whether any session id crosses a process boundary, in either direction. */
export function sessionBaggageEnabled(): boolean {
  return settings.send.length > 0 || settings.accept.length > 0;
}

function validId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_BAGGAGE_ID_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  return value;
}

function without(ctx: Context, keys: readonly string[]): Context {
  const bag = propagation.getBaggage(ctx);
  if (!bag || !keys.some((key) => bag.getEntry(key))) return ctx;
  let next: Baggage = bag;
  for (const key of keys) next = next.removeEntry(key);
  return propagation.setBaggage(ctx, next);
}

/**
 * W3C baggage, with `session.id` / `user.id` limited to the configured keys. On inject, our keys
 * not in GENAI_SESSION_BAGGAGE_KEYS are left out, so an id a caller sent is not forwarded on to
 * every service and API this one calls. On extract, our keys not in GENAI_SESSION_BAGGAGE_ACCEPT,
 * or not a valid id, are dropped. All other baggage passes through as the stock propagator does.
 */
export class SessionBaggagePropagator implements TextMapPropagator {
  private readonly w3c = new W3CBaggagePropagator();

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const drop = SUPPORTED_BAGGAGE_KEYS.filter((key) => !settings.send.includes(key));
    this.w3c.inject(without(ctx, drop), carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const extracted = this.w3c.extract(ctx, carrier, getter);
    const bag = propagation.getBaggage(extracted);
    const drop: string[] = SUPPORTED_BAGGAGE_KEYS.filter((key) => !settings.accept.includes(key));
    for (const key of settings.accept) {
      const entry = bag?.getEntry(key);
      if (entry && validId(entry.value) === undefined) drop.push(key);
    }
    return without(extracted, drop);
  }

  fields(): string[] {
    return this.w3c.fields();
  }
}

function scopeOf(sessionId: string | undefined, options: SessionOptions | undefined): SessionScope {
  const scope: SessionScope = {};
  if (sessionId) scope.sessionId = String(sessionId);
  if (options?.userId) scope.userId = String(options.userId);
  return scope;
}

/**
 * Run `fn` with a session in force. Returns what `fn` returns; rethrows what it throws. The ids
 * named in GENAI_SESSION_BAGGAGE_KEYS also go out as baggage, so services `fn` calls can tag their
 * spans with the same session.
 */
export function withSession<T>(sessionId: string, fn: () => T, options?: SessionOptions): T {
  const scope = scopeOf(sessionId, options);
  let ctx = context.active().setValue(SESSION_KEY, scope);
  // An id this scope does not set must not ride along from an outer scope or a caller, so our
  // keys are replaced or removed, never left as they were.
  ctx = without(ctx, SUPPORTED_BAGGAGE_KEYS);
  const send: [BaggageKey, string | undefined][] = [
    [ATTR.SESSION_ID, scope.sessionId],
    [ATTR.USER_ID, scope.userId],
  ];
  const entries = send.filter(([key, value]) => value && settings.send.includes(key));
  if (entries.length) {
    let bag = propagation.getBaggage(ctx) ?? propagation.createBaggage();
    for (const [key, value] of entries) bag = bag.setEntry(key, { value: value! });
    ctx = propagation.setBaggage(ctx, bag);
  }
  return context.with(ctx, fn);
}

/**
 * A context in which `sessionId` is in force - unless one already is. Used by
 * the instrumentors: a span that was started with a session id of its own (a
 * graph run on a thread, an agent call with a session) carries it to the calls
 * made inside it. An explicit `withSession` scope is never replaced.
 */
export function contextWithSessionId(ctx: Context, sessionId: unknown): Context {
  if (typeof sessionId !== 'string' || !sessionId) return ctx;
  if (ctx.getValue(SESSION_KEY) !== undefined) return ctx;
  return ctx.setValue(SESSION_KEY, { sessionId });
}

/** The session for every span outside a `withSession` scope. `undefined` clears it. */
export function setSession(sessionId: string | undefined, options?: SessionOptions): void {
  if (sessionId === undefined) delete globalState()[DEFAULT_SLOT];
  else globalState()[DEFAULT_SLOT] = scopeOf(sessionId, options);
}

function nonEmpty(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** The session in force: the innermost `withSession` scope, else the `setSession` default. */
export function currentSession(ctx: Context = context.active()): SessionScope {
  const scoped = ctx.getValue(SESSION_KEY) as SessionScope | undefined;
  if (scoped) return { ...scoped };
  return { ...(globalState()[DEFAULT_SLOT] as SessionScope | undefined) };
}

/** The session of an enclosing `withSession` scope only (Python: `session()`), not the default. */
export function scopedSession(ctx: Context = context.active()): SessionScope {
  return { ...(ctx.getValue(SESSION_KEY) as SessionScope | undefined) };
}

/** The `setSession` default, if any. */
export function defaultSession(): SessionScope {
  return { ...(globalState()[DEFAULT_SLOT] as SessionScope | undefined) };
}

/** A session / user an upstream service sent as baggage, when this service accepts it. Ranks last. */
export function inboundSession(ctx: Context = context.active()): SessionScope {
  const bag = propagation.getBaggage(ctx);
  const read = (key: BaggageKey) => (settings.accept.includes(key) ? validId(bag?.getEntry(key)?.value) : undefined);
  const scope: SessionScope = {};
  const sessionId = read(ATTR.SESSION_ID);
  const userId = read(ATTR.USER_ID);
  if (sessionId) scope.sessionId = sessionId;
  if (userId) scope.userId = userId;
  return scope;
}

/** Session and user ids on the live parent span, read at the child's start. */
function parentIds(ctx: Context): SessionScope {
  const parent = trace.getSpan(ctx) as unknown as { attributes?: Record<string, unknown> } | undefined;
  const attributes = parent?.attributes;
  if (!attributes) return {};
  return { sessionId: nonEmpty(attributes[ATTR.SESSION_ID]), userId: nonEmpty(attributes[ATTR.USER_ID]) };
}

/**
 * Logs once when session baggage is configured but the global propagator is no longer ours: code
 * that sets one after `instrument()` replaces it, and then inbound session ids are forwarded
 * unfiltered, or no session crosses at all.
 */
export function warnIfPropagatorReplaced(): boolean {
  if (!sessionBaggageEnabled()) return false;
  try {
    const global = (propagation as unknown as { _getGlobalPropagator?: () => unknown })._getGlobalPropagator?.();
    if (global === undefined || hasSessionPropagator(global)) return false;
  } catch {
    return false; // a diagnostic must never break a span
  }
  logger.warn(
    'GENAI_SESSION_BAGGAGE_KEYS/_ACCEPT is set, but the global propagator was replaced after instrument(). ' +
      'session.id / user.id baggage is not filtered and may not cross at all. Remove the later ' +
      'setGlobalPropagator() call, or include SessionBaggagePropagator in it.',
  );
  return true;
}

function hasSessionPropagator(propagator: unknown): boolean {
  if (propagator instanceof SessionBaggagePropagator) return true;
  const inner = (propagator as { _propagators?: unknown[] })._propagators;
  return Array.isArray(inner) && inner.some(hasSessionPropagator);
}

/**
 * Gives every span the session and user in force: a `withSession` scope (or an OpenInference
 * session block), else its parent span's, else the `setSession` default, else an id an upstream
 * service sent as accepted baggage. Installed by `instrument()`.
 */
export class SessionSpanProcessor implements SpanProcessor {
  // Checked at the first span rather than at setup: an application that overrides the propagator
  // does so right after instrument() returns.
  private propagatorChecked = false;

  onStart(span: Span, parentContext: Context): void {
    if (!this.propagatorChecked) {
      this.propagatorChecked = true;
      warnIfPropagatorReplaced();
    }
    try {
      const present = span.attributes;
      const hasSession = ATTR.SESSION_ID in present;
      const hasUser = ATTR.USER_ID in present;
      if (hasSession && hasUser && ATTR.GEN_AI_CONVERSATION_ID in present) return;

      const scoped = parentContext.getValue(SESSION_KEY) as SessionScope | undefined;
      const fallback = globalState()[DEFAULT_SLOT] as SessionScope | undefined;
      let sessionId = scoped?.sessionId;
      let userId = scoped?.userId;
      if (settings.enabled) {
        sessionId ??= nonEmpty(parentContext.getValue(OPENINFERENCE_SESSION_KEY));
        userId ??= nonEmpty(parentContext.getValue(OPENINFERENCE_USER_KEY));
        if (sessionId === undefined || userId === undefined) {
          const parent = parentIds(parentContext);
          sessionId ??= parent.sessionId;
          userId ??= parent.userId;
        }
      }
      // The setSession default stands in only where no scope is in force: a scope replaces it
      // whole, so the default's user does not leak into a scope that named another session.
      if (!scoped) {
        sessionId ??= fallback?.sessionId;
        userId ??= fallback?.userId;
      }
      if (settings.enabled) {
        const inbound = inboundSession(parentContext);
        sessionId ??= inbound.sessionId;
        userId ??= inbound.userId;
      }

      if (!hasSession && sessionId) span.setAttribute(ATTR.SESSION_ID, sessionId);
      const effective = nonEmpty(present[ATTR.SESSION_ID]) ?? sessionId;
      if (effective && !(ATTR.GEN_AI_CONVERSATION_ID in present)) span.setAttribute(ATTR.GEN_AI_CONVERSATION_ID, effective);
      if (!hasUser && userId) span.setAttribute(ATTR.USER_ID, userId);
    } catch (error) {
      diag.debug(`Failed to add session attributes: ${String(error)}`); // never breaks a span
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
