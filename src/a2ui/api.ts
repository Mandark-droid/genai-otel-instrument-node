/**
 * The public A2UI API, for apps whose transport this library does not see (AG-UI, a custom
 * WebSocket, MCP Apps, a renderer with no A2A client). Each call adds the attributes of
 * `a2ui.*` to the current span, or opens a short INTERNAL span when none is recording.
 *
 *   recordA2uiReceived(messages)      the agent's messages, as the renderer received them
 *   recordA2uiSent(message)           a renderer message the app sent: an action, a function call, an error
 *   recordA2uiRendererError(error)    a renderer-side failure: an `error` message, or a thrown error
 *
 * The same content rule as everywhere else: identifiers, counts and codes always; messages, the
 * data model, an action's context and error paths and messages only with content capture on, and the
 * content of image or file URLs never. Several calls on one span accumulate into it. None of them
 * ever throws, and none sets the span's status: a renderer error is a fact about the UI, not a
 * failure of the span the call was made under.
 *
 * Exported from the Node, browser and React Native entries.
 */
import { context, SpanKind, trace, type Span } from '@opentelemetry/api';
import { VERSION } from '../version';
import { logger } from '../logger';
import { SIDE_AGENT, SIDE_RENDERER, SPAN_RECEIVE, SPAN_RENDERER_ERROR, SPAN_SEND } from './attributes';
import { A2uiObservation, applyToSpan, snake, unwrapMessageList, AGENT_KINDS, RENDERER_KINDS } from './extract';
import { a2uiSettings, contentWriter } from './settings';

type Obj = Record<string, unknown>;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const TRACER = 'genai_otel.a2ui';

interface Entry {
  obs: A2uiObservation;
  /** Events already written, so a second call adds only the new ones. */
  events: number;
}

/** What each span already carries, so calls on one span accumulate instead of overwriting. */
const entries = new WeakMap<object, Entry>();

const put = contentWriter(() => a2uiSettings());

/** The current span when it records, else a new short INTERNAL span (named by `name`) that `fn` fills and ends. */
function onSpan(name: () => string, fn: (obs: A2uiObservation) => void): void {
  try {
    if (!a2uiSettings().a2uiEnabled) return;
    const active = trace.getSpan(context.active());
    if (active?.isRecording()) {
      let entry = entries.get(active);
      if (!entry) {
        entry = { obs: new A2uiObservation(a2uiSettings().enableContentCapture), events: 0 };
        entries.set(active, entry);
      }
      fn(entry.obs);
      applyToSpan(active, entry.obs, put, entry.events);
      entry.events = entry.obs.errors.length;
      return;
    }
    const obs = new A2uiObservation(a2uiSettings().enableContentCapture);
    fn(obs);
    const span: Span = trace.getTracer(TRACER, VERSION).startSpan(name(), { kind: SpanKind.INTERNAL });
    try {
      applyToSpan(span, obs, put);
    } finally {
      span.end();
    }
  } catch (error) {
    logger.debug(`Could not record A2UI: ${String(error)}`);
  }
}

/** Record the agent's messages as the renderer received them: one message, a list, or a `{ messages }` wrapper. */
export function recordA2uiReceived(messages: unknown): void {
  onSpan(
    () => SPAN_RECEIVE,
    (obs) => obs.addPayload(unwrapMessageList(messages), SIDE_AGENT),
  );
}

function kindOf(message: unknown): string | undefined {
  if (!isMapping(message)) return undefined;
  return Object.keys(message).find((key) => RENDERER_KINDS.has(key) || AGENT_KINDS.has(key));
}

/** Record a message the renderer sent to the agent: an `action`, a `callAgentFunction`, an `error`. */
export function recordA2uiSent(message: unknown): void {
  onSpan(
    () => {
      const kind = kindOf(message);
      return kind ? `${SPAN_SEND} ${snake(kind)}` : SPAN_SEND;
    },
    (obs) => obs.addPayload(unwrapMessageList(message), SIDE_RENDERER),
  );
}

/**
 * The body of a renderer error for whatever the app has: a thrown error (`code`, `surfaceId` and
 * `path` are read from it when it has them; its class name stands in for a missing code) or a bare
 * `{ code, surfaceId, path, message }`. An `error` message envelope is handled by the caller.
 */
function errorBodyOf(error: unknown): Obj {
  const body: Obj = {};
  if (error instanceof Error || isMapping(error)) {
    const source = error as unknown as Obj;
    const code = typeof source.code === 'string' && source.code ? source.code : error instanceof Error ? error.constructor?.name || error.name : undefined;
    if (code) body.code = code;
    for (const key of ['surfaceId', 'path', 'message'] as const) {
      if (typeof source[key] === 'string' && source[key]) body[key] = source[key];
    }
  } else if (typeof error === 'string') {
    body.message = error;
  }
  return body;
}

/** Record a renderer-side failure (a validation error, an unknown component, a function error). */
export function recordA2uiRendererError(error: unknown): void {
  onSpan(
    () => SPAN_RENDERER_ERROR,
    (obs) => {
      // A message envelope (`{ version, error: {...} }`) is read as a message; anything else as an error.
      if (isMapping(error) && isMapping(error.error)) obs.addMessage(error, SIDE_RENDERER);
      else obs.addRendererError(errorBodyOf(error));
    },
  );
}
