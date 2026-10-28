/**
 * Spans for an application's own components - its agent loop, its tool
 * dispatcher, its retrieval, its pipelines - which no instrumentor can find,
 * because they are not a library. One call wraps each:
 *
 *   await traceAgent('assistant', { id: runId, input: text, output: (r) => r.reply }, () => run(text));
 *   await traceTool('get_weather', { arguments: args, description }, () => tools.call('get_weather', args));
 *   await traceRetrieval('memory', { query, documents: (hits) => hits.map(toDoc) }, () => search(query));
 *   await traceWorkflow('ingest', {}, () => ingest(file));
 *
 * They follow the GenAI semantic conventions (`invoke_agent`, `execute_tool`),
 * carry the OpenInference span kind, nest what runs inside them across `await`
 * (in every entry), and record content - inputs, outputs, tool arguments and
 * results, the query and document text - only when `instrument()` was given
 * `enableContentCapture`. Errors always record their type; their message only
 * with content capture, as it may quote content.
 */
import { type AttributeValue, type Context, context, ROOT_CONTEXT, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { OPENINFERENCE_SPAN_KIND } from './openinference';
import { addRetrievalAttributes, type RetrievedDocument } from './retrieval';
import { VERSION } from './version';

const TRACER = '@traceverse/genai-otel-instrument-node/app';

type Attrs = Record<string, AttributeValue | undefined>;

interface Capture {
  enabled: boolean;
  maxLength: number;
}

let capture: Capture = { enabled: false, maxLength: 200 };

/** Set by `instrument()` from `enableContentCapture` / `contentMaxLength`. */
export function setAppSpanContentCapture(enabled: boolean, maxLength: number): void {
  capture = { enabled, maxLength };
}

export interface AppSpanOptions {
  /** Extra attributes for the span. */
  attributes?: Attrs;
  /** Parent, when the work does not run inside its parent's callback. */
  parent?: Context;
}

/** Attributes known only once the work is done (counts, a status). Not content: always recorded. */
interface ResultAttributes<T> {
  resultAttributes?: (result: T) => Attrs;
}

function withResultAttributes<T>(options: ResultAttributes<T>, after?: (span: Span, result: T) => void) {
  return (span: Span, result: T): void => {
    const extra = options.resultAttributes?.(result);
    if (extra) span.setAttributes(clean(extra));
    after?.(span, result);
  };
}

function clean(attrs: Attrs): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) out[key] = value;
  return out;
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return undefined;
  return capture.maxLength > 0 && s.length > capture.maxLength ? `${s.slice(0, capture.maxLength)}…` : s;
}

/** Sets a content attribute when content capture is on. */
function setContent(span: Span, key: string, value: unknown): void {
  if (!capture.enabled) return;
  const s = text(value);
  if (s !== undefined) span.setAttribute(key, s);
}

async function run<T>(
  name: string,
  attrs: Attrs,
  options: AppSpanOptions,
  fn: () => Promise<T> | T,
  after?: (span: Span, result: T) => void,
): Promise<T> {
  const parent = options.parent ?? context.active();
  const span = trace
    .getTracer(TRACER, VERSION)
    .startSpan(name, { attributes: clean({ ...attrs, ...options.attributes }) }, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      const result = await fn();
      after?.(span, result);
      return result;
    } catch (error) {
      const type = error instanceof Error ? error.name : typeof error;
      span.setAttribute('error.type', type);
      if (capture.enabled) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: type });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface AgentSpanOptions<T> extends AppSpanOptions, ResultAttributes<T> {
  /** `gen_ai.agent.id`, e.g. the run's id. */
  id?: string;
  /** `gen_ai.conversation.id`. */
  conversationId?: string;
  /** The request (content). */
  input?: unknown;
  /** The reply, from the result (content). */
  output?: (result: T) => unknown;
  /** A failure the result reports instead of throwing (an error type such as `timeout`). */
  failure?: (result: T) => string | undefined;
}

/** One run of an agent: `invoke_agent {name}`, the parent of its model and tool calls. */
export function traceAgent<T>(name: string, options: AgentSpanOptions<T>, fn: () => Promise<T> | T): Promise<T> {
  return run(
    `invoke_agent ${name}`,
    {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': name,
      'gen_ai.agent.id': options.id,
      'gen_ai.conversation.id': options.conversationId,
      [OPENINFERENCE_SPAN_KIND]: 'AGENT',
    },
    options,
    async () => {
      const span = trace.getActiveSpan();
      if (span) setContent(span, 'gen_ai.input.messages', options.input);
      return fn();
    },
    withResultAttributes(options, (span, result) => {
      setContent(span, 'gen_ai.output.messages', options.output?.(result));
      const failure = options.failure?.(result);
      if (failure) {
        span.setAttribute('error.type', failure);
        span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
      }
    }),
  );
}

export interface ToolSpanOptions<T> extends AppSpanOptions, ResultAttributes<T> {
  /** `gen_ai.tool.call.id`. */
  callId?: string;
  /** `gen_ai.tool.description`: what the model was told the tool does. */
  description?: string;
  /** `gen_ai.tool.type`; `extension` when `mcpServer` is given, else `function`. */
  type?: 'function' | 'extension' | 'datastore';
  /** The MCP server the tool belongs to (`mcp.server`, `mcp.method.name = tools/call`). */
  mcpServer?: string;
  /** The arguments (content). */
  arguments?: unknown;
  /** What to record as the result (content); the whole result by default. */
  result?: (result: T) => unknown;
  /** A failure the result reports instead of throwing (an error code). */
  failure?: (result: T) => string | undefined;
}

/** One tool call: `execute_tool {name}`. */
export function traceTool<T>(name: string, options: ToolSpanOptions<T>, fn: () => Promise<T> | T): Promise<T> {
  return run(
    `execute_tool ${name}`,
    {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': name,
      'gen_ai.tool.type': options.type ?? (options.mcpServer ? 'extension' : 'function'),
      'gen_ai.tool.call.id': options.callId,
      'gen_ai.tool.description': options.description,
      'mcp.server': options.mcpServer,
      'mcp.method.name': options.mcpServer ? 'tools/call' : undefined,
      [OPENINFERENCE_SPAN_KIND]: 'TOOL',
    },
    options,
    async () => {
      const span = trace.getActiveSpan();
      if (span) setContent(span, 'gen_ai.tool.call.arguments', options.arguments);
      return fn();
    },
    withResultAttributes(options, (span, result) => {
      setContent(span, 'gen_ai.tool.call.result', options.result ? options.result(result) : result);
      const failure = options.failure?.(result);
      if (failure) {
        span.setAttribute('error.type', failure);
        span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
      }
    }),
  );
}

export interface RetrievalSpanOptions<T> extends AppSpanOptions, ResultAttributes<T> {
  /** The query (content). */
  query?: string;
  /** `db.system` (the contract's name for it), e.g. `sqlite`, `qdrant`. */
  system?: string;
  /** `db.vector.query.top_k`. */
  topK?: number;
  /** The documents the result holds, best first. Ids and scores are always recorded; text and metadata with content capture. */
  documents: (result: T) => RetrievedDocument[];
}

/** One search: `retrieve {collection}`, with the documents it returned in rank order. */
export function traceRetrieval<T>(
  collection: string,
  options: RetrievalSpanOptions<T>,
  fn: () => Promise<T> | T,
): Promise<T> {
  return run(
    `retrieve ${collection}`,
    {
      'gen_ai.operation.name': 'retrieval',
      'db.collection.name': collection,
      'db.system': options.system,
      'db.vector.query.top_k': options.topK,
      [OPENINFERENCE_SPAN_KIND]: 'RETRIEVER',
    },
    options,
    fn,
    withResultAttributes(options, (span, result) => {
      const documents = options.documents(result);
      span.setAttribute('db.response.returned_rows', documents.length);
      const scores = documents.map((d) => d.score).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
      if (scores.length) {
        const ordered = [...scores].sort((a, b) => b - a);
        span.setAttribute('rag.result.score_max', ordered[0]!);
        span.setAttribute('rag.result.score_min', ordered[ordered.length - 1]!);
        span.setAttribute('rag.result.score_mean', scores.reduce((a, b) => a + b, 0) / scores.length);
        if (ordered.length > 1) span.setAttribute('rag.result.score_margin', ordered[0]! - ordered[1]!);
      }
      if (capture.enabled) addRetrievalAttributes(span, documents, { query: options.query });
      else addRetrievalAttributes(span, documents.map((d) => ({ id: d.id, score: d.score })));
    }),
  );
}

export interface WorkflowSpanOptions<T> extends AppSpanOptions, ResultAttributes<T> {
  /** What went in (content). */
  input?: unknown;
  /** What came out, from the result (content). */
  output?: (result: T) => unknown;
}

/** A step or pipeline of the application (OpenInference CHAIN), the parent of what runs inside it. */
export function traceWorkflow<T>(name: string, options: WorkflowSpanOptions<T>, fn: () => Promise<T> | T): Promise<T> {
  return run(
    name,
    { [OPENINFERENCE_SPAN_KIND]: 'CHAIN' },
    options,
    async () => {
      const span = trace.getActiveSpan();
      if (span) setContent(span, 'input.value', options.input);
      return fn();
    },
    withResultAttributes(options, (span, result) => setContent(span, 'output.value', options.output?.(result))),
  );
}

/**
 * Starts `fn` outside the current trace: spans that the calls `fn` makes start synchronously -
 * an instrumented model call, a helper span - are children of `parent` (by default none: each
 * begins its own trace), and nothing else is. For background work, such as indexing documents
 * while the user runs something else.
 *
 * In React Native and browsers the active context is the most recent scope still open, so a
 * call a background task makes while a long workflow is running would otherwise become part of
 * that workflow. `detached` enters `parent` only while `fn` runs synchronously and opens no scope
 * that outlives it, so it never takes over the workflow's spans either. Spans started after an
 * `await` inside `fn` are not covered; wrap each call:
 *
 *   const vector = await detached(() => model.embed({ text }));
 */
export function detached<T>(fn: () => T, parent: Context = ROOT_CONTEXT): T {
  let result!: T;
  // The callback returns nothing, so the scope ends when it does, whatever `fn` returns.
  context.with(parent, () => {
    result = fn();
  });
  return result;
}
