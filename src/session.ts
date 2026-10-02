/**
 * Session scope.
 *
 * The platform builds a session from spans that carry `session.id` (or
 * `gen_ai.conversation.id`); a run whose spans carry neither produces no session
 * at all. The reference library offers only `session_id_extractor`, a callback
 * that derives the id from each call's arguments (ported: `sessionIdExtractor`).
 * This adds the direct way to say it - not present in Python:
 *
 *   withSession('chat-41', () => handle(request))   // everything started inside
 *   setSession('chat-41')                            // everything from now on
 *
 * Both put `session.id` and `gen_ai.conversation.id` (and `user.id`, when
 * given) on every span started in scope, whichever instrumentation starts it.
 * An extractor, where configured, still wins for the spans it applies to.
 *
 * `withSession` rides on the OpenTelemetry context, so it holds across `await`
 * only where a context manager does (Node). In a browser or React Native app,
 * where one app instance is one user's session, use `setSession`.
 */
import { context, createContextKey, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
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

function scopeOf(sessionId: string | undefined, options: SessionOptions | undefined): SessionScope {
  const scope: SessionScope = {};
  if (sessionId) scope.sessionId = String(sessionId);
  if (options?.userId) scope.userId = String(options.userId);
  return scope;
}

/** Run `fn` with a session in force. Returns what `fn` returns; rethrows what it throws. */
export function withSession<T>(sessionId: string, fn: () => T, options?: SessionOptions): T {
  return context.with(context.active().setValue(SESSION_KEY, scopeOf(sessionId, options)), fn);
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

/** The session in force: the innermost `withSession` scope, else the `setSession` default. */
export function currentSession(ctx: Context = context.active()): SessionScope {
  const scoped = ctx.getValue(SESSION_KEY) as SessionScope | undefined;
  if (scoped) return { ...scoped };
  return { ...(globalState()[DEFAULT_SLOT] as SessionScope | undefined) };
}

/** Stamps the session in force on every span as it starts. Installed by `instrument()`. */
export class SessionSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const { sessionId, userId } = currentSession(parentContext);
    const present = span.attributes;
    if (sessionId) {
      if (!(ATTR.SESSION_ID in present)) span.setAttribute(ATTR.SESSION_ID, sessionId);
      if (!(ATTR.GEN_AI_CONVERSATION_ID in present)) span.setAttribute(ATTR.GEN_AI_CONVERSATION_ID, sessionId);
    }
    if (userId && !(ATTR.USER_ID in present)) span.setAttribute(ATTR.USER_ID, userId);
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
