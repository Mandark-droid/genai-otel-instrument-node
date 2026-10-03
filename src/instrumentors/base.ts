/**
 * Base class for the provider instrumentors.
 *
 * A port of `genai_otel/instrumentors/base.py`: the span wrapper, provider-name
 * aliasing, token / cost / finish-reason recording, and streaming measurement
 * (time to first token, time between tokens, time per output token).
 * `contract/semconv.json` (`span_emission`) holds the spans the Python wrapper
 * produced for a set of scenarios, and the contract test reproduces each one.
 *
 * Not ported in this phase, each belonging to a later one: multimodal content
 * capture, evaluation checks and pre-call blocking, agent-budget accounting and
 * the server concurrency gauge.
 *
 * Where this deliberately differs from the Python wrapper:
 *
 * - A stream that is cancelled (the consumer stops iterating, or aborts) ends
 *   its span with ERROR status and the tokens seen so far. Python closes an
 *   abandoned stream as OK. A stream that fails part-way also keeps the tokens
 *   it saw; Python drops them. Neither records a cost: a partial cost is not a
 *   measurement.
 * - An unpriced model increments `gen_ai.usage.cost.pricing_missing`.
 */
import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { BudgetFrame, consumptionAttributes, recordInference, utilization, withBudgetFrame } from '../agent-budget';
import type { OTelConfig } from '../config';
import { costCalculatorFor, getDefaultCostCalculator, recordPricingMissing, type CostCalculator, type Usage } from '../cost';
import { logger } from '../logger';
import { getSharedMetrics, type SharedMetrics } from '../metrics';
import { pyJsonDumps, pyStr, pyTruncate } from '../pycompat';
import { AGENT_OPERATION_MARKERS, ATTR, genaiSemconvModes, SemanticConvention as SC, TOKEN_MODALITIES } from '../semconv';
import { activeEvaluation, PolicyViolationError, promptForEvaluation, rememberTexts, responseForEvaluation } from '../evaluation/engine';
import { llamacppLatencyAttributes } from '../engine-latency';
import { emitMedia } from '../media/emit';
import { chunkText, completionText, ensureContent, StreamText, withoutContent } from './content';
import { getServerMetrics } from '../server-metrics';
import { contextWithSessionId } from '../session';
import { stateSlot } from '../state';
import { holders, USAGE_HOLDERS, USAGE_RECORDED_BY, usageRecordedBelow, type UsageHolder } from '../usage-holders';
import type { Instrumentor } from './registry';

/** Instrumentation scope of the spans, as in the Python library. */
export const BASE_TRACER_NAME = 'genai_otel.instrumentors.base';

export type UsageDict = Usage;
export type Params = Record<string, unknown>;
export type AttributeExtractor = (instance: unknown, args: unknown[], params: Params) => Record<string, unknown>;

/** Error type recorded for a stream its consumer stopped reading. */
export const STREAM_CANCELLED = 'StreamCancelled';

// ---------------------------------------------------------------------------
// Base-URL claims
// ---------------------------------------------------------------------------

/**
 * base URL substrings claimed by dedicated aggregator instrumentors
 * (OpenRouter, CometAPI). The generic OpenAI / Anthropic instrumentors consult
 * this before tracing a call: a client whose base URL is claimed gets its span
 * and metrics from the dedicated instrumentor only.
 */
function claims(): Map<string, string> {
  return stateSlot('baseUrlClaims', () => new Map<string, string>());
}

export function registerBaseUrlClaim(domainSubstring: string, instrumentorName: string): void {
  claims().set(domainSubstring.toLowerCase(), instrumentorName);
}

export function clearBaseUrlClaims(): void {
  claims().clear();
}

/**
 * Whether `baseUrl` points at `domain`: its host is the domain or a subdomain
 * of it. The reference looks for the domain anywhere in the URL, which also
 * claims `https://gateway.example.com/openrouter.ai/v1`.
 */
export function hostMatches(baseUrl: unknown, domain: string): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(String(baseUrl)).hostname.toLowerCase();
  } catch {
    return false;
  }
  const wanted = domain.toLowerCase();
  return host === wanted || host.endsWith(`.${wanted}`);
}

/** The name of the dedicated instrumentor claiming `baseUrl`, or undefined. */
export function findBaseUrlClaim(baseUrl: unknown): string | undefined {
  for (const [domain, name] of claims()) if (hostMatches(baseUrl, domain)) return name;
  return undefined;
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/** Paths walked to find the SDK client's base URL: the method's owner is a resource, not the client. */
const BASE_URL_PATHS: readonly (readonly string[])[] = [
  ['baseURL'],
  ['_client', 'baseURL'],
  ['_client', '_client', 'baseURL'],
  // Speakeasy-generated clients (Mistral).
  ['_baseURL'],
  // ollama.
  ['config', 'host'],
  // Fern-generated clients (Cohere, ElevenLabs, Sarvam).
  ['_options', 'baseUrl'],
  ['_options', 'environment'],
];

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'https:': 443, 'http:': 80 };

/** The base URL of the SDK client an instrumented method belongs to, if it exposes one. */
export function clientBaseUrl(instance: unknown): unknown {
  for (const path of BASE_URL_PATHS) {
    let target: unknown = instance;
    for (const step of path) {
      target = typeof target === 'object' && target !== null ? (target as Record<string, unknown>)[step] : undefined;
      if (target === undefined || target === null) break;
    }
    // A Fern client may hold a supplier function here; only a value is a URL.
    if (target !== undefined && target !== null && typeof target !== 'function') return target;
  }
  return undefined;
}

/**
 * `server.address` / `server.port` from the SDK client's base URL.
 *
 * Empty when no base URL can be observed. An absent attribute reads as
 * "endpoint unknown"; defaulting to the provider's public host would
 * misattribute self-hosted, proxied and gateway traffic to the vendor.
 */
export function serverAttributes(instance: unknown): Record<string, unknown> {
  const baseUrl = clientBaseUrl(instance);
  if (baseUrl === undefined) return {};
  let parsed: URL;
  try {
    parsed = new URL(String(baseUrl));
  } catch {
    return {};
  }
  if (!parsed.hostname) return {};
  const attributes: Record<string, unknown> = { [SC.SERVER_ADDRESS]: parsed.hostname.replace(/^\[(.*)\]$/, '$1') };
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  if (port !== undefined && Number.isFinite(port)) attributes[SC.SERVER_PORT] = port;
  return attributes;
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/**
 * Common request parameters -> the conventions' request attributes. Only
 * parameters the caller actually passed are recorded.
 */
export function requestParameterAttributes(params: Params): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  if (isInt(params.seed)) attributes[SC.GEN_AI_REQUEST_SEED] = params.seed;
  if ('stream' in params && params.stream !== undefined) attributes[SC.GEN_AI_REQUEST_STREAM] = Boolean(params.stream);
  if (typeof params.top_k === 'number') attributes[SC.GEN_AI_REQUEST_TOP_K] = params.top_k;

  // `n` is the OpenAI spelling; `candidate_count` is Google's.
  for (const key of ['n', 'candidate_count']) {
    const count = params[key];
    if (isInt(count) && count > 0) {
      attributes[SC.GEN_AI_REQUEST_CHOICE_COUNT] = count;
      break;
    }
  }

  // The shape the caller asked for, so derived from the request.
  const responseFormat = params.response_format;
  if (responseFormat !== undefined && responseFormat !== null) {
    let format: unknown = responseFormat;
    if (typeof format === 'object') format = (format as Record<string, unknown>).type;
    const text = String(format ?? '').toLowerCase();
    if (text.startsWith('json')) attributes[SC.GEN_AI_OUTPUT_TYPE] = 'json';
    else if (text === 'text') attributes[SC.GEN_AI_OUTPUT_TYPE] = 'text';
  }
  return attributes;
}

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const isPositive = (value: unknown): value is number => typeof value === 'number' && value > 0;

/** The first argument of an SDK method is its parameter object ("kwargs"). */
function paramsOf(args: unknown[]): Params {
  const first = args[0];
  return typeof first === 'object' && first !== null && !Array.isArray(first) ? (first as Params) : {};
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

/** `type(e).__name__` */
export function errorTypeName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const constructorName = (error as { constructor?: { name?: string } }).constructor?.name;
  const ownName = (error as { name?: unknown }).name;
  if (constructorName && constructorName !== 'Error') return constructorName;
  if (typeof ownName === 'string' && ownName) return ownName;
  return constructorName || 'Error';
}

/** `str(e)` */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function recordException(span: Span, error: unknown): void {
  try {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // never let telemetry break the call
  }
}

/** Seconds since the epoch, with sub-millisecond resolution. */
export function epochSeconds(): number {
  // React Native's `performance` has no timeOrigin; a browser's and Node's do.
  const origin = typeof performance === 'object' ? performance.timeOrigin : undefined;
  return typeof origin === 'number' && origin > 0 ? (origin + performance.now()) / 1000 : Date.now() / 1000;
}
const now = epochSeconds;
/** The same clock in milliseconds: a span end time. */
const wallClockMs = (): number => epochSeconds() * 1000;

/** `gen_ai.operation.name` marks an agent invocation (`agent.run`, `graph.execution`, `runner.run`, ...). */
function isAgentInvocation(attributes: Attributes): boolean {
  const operation = String(attributes[ATTR.GEN_AI_OPERATION_NAME] ?? '').toLowerCase();
  return operation !== '' && AGENT_OPERATION_MARKERS.some((marker) => operation.includes(marker));
}

/** Attributes already written to a recording span; empty for a non-recording one. */
function spanAttributes(span: Span): Attributes {
  return ((span as unknown as { attributes?: Attributes }).attributes ?? {}) as Attributes;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// One model call, one usage record (SDK_ADDITIONS.md section 8)
// ---------------------------------------------------------------------------

/** Media uploads a span waits for before it ends. */
const mediaWork = (): WeakMap<object, Promise<void>> => stateSlot('media.work', () => new WeakMap<object, Promise<void>>());

/** The operation of a model call the instrumentor did not name, from its request type or span name. */
function operationFor(spanName: string, requestType: unknown): string | undefined {
  if (requestType === 'embedding' || /embed/i.test(spanName)) return 'embeddings';
  if (requestType === 'chat' || /(chat|complet|messages|generate|converse|invoke_model)/i.test(spanName)) return 'chat';
  return undefined;
}

/** Latency bookkeeping for one streamed response. */
export class StreamTiming {
  /** null until the first chunk actually arrives. */
  ttft: number | null = null;
  lastChunkTime: number;
  chunkCount = 0;
  lastChunk: unknown = undefined;
  /**
   * Usage assembled across chunks by a provider that splits it over several
   * events. Stays null for providers that report it on the final chunk.
   */
  usage: UsageDict | null = null;
  /** The completion as it streams; only with content capture on. */
  text: StreamText | undefined;

  constructor(readonly startTime: number) {
    this.lastChunkTime = startTime;
  }
}

type StreamOutcome = { kind: 'completed' } | { kind: 'cancelled' } | { kind: 'error'; error: unknown };

/**
 * Ends the span of a call whose result nobody ever consumed - a streamed
 * response that was never iterated, a promise that was dropped. Without this
 * such a span would stay open for the life of the process.
 */
const abandoned: Pick<FinalizationRegistry<() => void>, 'register'> =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<() => void>((finish) => {
        try {
          finish();
        } catch {
          // nothing to report to
        }
      })
    : // An engine without it (older Hermes): such a span is simply never closed.
      { register: () => {} };

/** After the current task and its microtasks. `setImmediate` is Node's; elsewhere a zero timer. */
const defer: (task: () => void) => void =
  typeof setImmediate === 'function' ? (task) => void setImmediate(task) : (task) => void setTimeout(task, 0);

interface ApiPromiseLike {
  responsePromise: PromiseLike<unknown>;
  parseResponse: (...args: unknown[]) => unknown;
  asResponse?: (...args: unknown[]) => unknown;
}

function isApiPromise(value: unknown): value is ApiPromiseLike {
  const candidate = value as Partial<ApiPromiseLike> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.parseResponse === 'function' &&
    isThenable(candidate.responsePromise)
  );
}

export interface SpanWrapperOptions {
  /**
   * The method returns a stream (`chat.stream()`), whatever its parameters
   * say; or a function deciding it per call.
   */
  streaming?: boolean | ((params: Params, args: unknown[]) => boolean);
  /** A span name that depends on the request, where the reference builds one. */
  spanName?: (params: Params, args: unknown[]) => string;
  /** Where the request parameters are, when they are not the first argument (`client.send(command)`). */
  params?: (args: unknown[]) => Params;
  /** Where the stream is in a streamed call's result, when it is not the result itself (`{ stream }`). */
  streamOf?: (result: unknown) => unknown;
}

interface Call {
  span: Span;
  spanName: string;
  startTime: number;
  params: Params;
  isStreaming: boolean;
  /** The model the caller asked for, as written on the span. */
  model: string;
  done: boolean;
  streamOf?: (result: unknown) => unknown;
  /** Set for an agent invocation: what the model calls inside it consumed. */
  budget?: BudgetFrame;
  /** The prompt was handed to the evaluation. */
  evaluated?: boolean;
  failed?: boolean;
  /** Counted among the requests in flight. */
  counted?: boolean;
  /** Marked in flight under the usage holders of the spans above it. */
  holdersHeld?: boolean;
  /** The context the call runs in; a stream is read in it too. */
  context?: Context;
}

// ---------------------------------------------------------------------------
// BaseInstrumentor
// ---------------------------------------------------------------------------

export abstract class BaseInstrumentor implements Instrumentor {
  protected config: OTelConfig | undefined;
  /** The shared default until `setupConfig()`; then the configuration's, custom pricing included. */
  protected costCalculator: CostCalculator = getDefaultCostCalculator();
  protected instrumented = false;

  abstract instrument(config: OTelConfig): void | Promise<void>;
  abstract uninstrument(): void;

  /**
   * A call that returned normally but did not succeed, for engines that report
   * failure in the result instead of throwing. The message becomes the span's
   * error status; no tokens and no cost are recorded.
   */
  protected resultFailure?(result: unknown): string | undefined;

  /**
   * Token usage of a result, or of one streamed chunk: `prompt_tokens`,
   * `completion_tokens`, `total_tokens`, plus optional cache / reasoning /
   * per-modality keys. null when the object carries none.
   */
  protected abstract extractUsage(result: unknown): UsageDict | null;

  /** Response attributes (id, model, finish reasons, tool calls). */
  protected extractResponseAttributes?(result: unknown): Record<string, unknown>;

  /** The message format of the provider, for media capture (`openai`, `anthropic`, `google`, `groq`); none: no media capture. */
  protected readonly mediaProvider: string | undefined = undefined;

  /** The completion text of a buffered response, for content capture. */
  protected completionTextForContent(result: unknown): string | undefined {
    return completionText(result);
  }

  /** The text one streamed chunk adds to the completion, for content capture. */
  protected streamChunkTextForContent(chunk: unknown): string | undefined {
    return chunkText(chunk);
  }

  /** Bound a captured text to `contentMaxLength` (0: unlimited). */
  protected capText(text: string): string {
    const maxLength = this.config?.contentMaxLength ?? 200;
    return maxLength > 0 ? pyTruncate(text, maxLength) : text;
  }

  /** The response text the evaluation reads. The reference reads the OpenAI shape only; an instrumentor may know better. */
  protected responseTextForEvaluation(result: unknown): string | undefined {
    return responseForEvaluation(result);
  }

  protected extractFinishReason?(result: unknown): string | null | undefined;

  /** Prompt / completion content as span events. Called only when content capture is on. */
  protected addContentEvents?(span: Span, result: unknown, params: Params): void;

  /** Best-effort token estimate for providers whose response omits usage. Default: none. */
  protected estimateUsage(_result: unknown, _params: Params): UsageDict | null {
    return null;
  }

  /**
   * Fold usage reported part-way through a stream. Default: nothing - most
   * providers repeat the full usage on the final chunk. An instrumentor that
   * overrides this sets `timing.usage`; the finalizer prefers it.
   */
  protected accumulateStreamUsage(_timing: StreamTiming, _chunk: unknown): void {}

  /** True when a call must pass through untouched (claimed base URL, nested helper call). */
  protected shouldBypass(_instance: unknown, _args: unknown[], _params: Params): boolean {
    return false;
  }

  protected get tracer(): Tracer {
    return trace.getTracer(BASE_TRACER_NAME);
  }

  protected get metrics(): SharedMetrics {
    return getSharedMetrics();
  }

  /**
   * Attach the configuration, and with it the cost calculator: the shared
   * default one, or the configuration's custom-priced one. Every instrumentor
   * calls this from `instrument()`.
   */
  protected setupConfig(config: OTelConfig): void {
    this.config = config;
    this.costCalculator = costCalculatorFor(config.customPricingJson);
    if (config.customPricingJson) logger.info('Cost calculator uses custom pricing');
  }

  private get emitSuperseded(): boolean {
    return genaiSemconvModes(this.config?.semconvStabilityOptIn).emitSuperseded;
  }

  /**
   * A JSON `{"role": ..., "content": ...}` of the first message, honouring
   * `enableContentCapture` and `contentMaxLength`. null when capture is off or
   * there are no messages. With no config attached it captures with a 200
   * character limit, as the Python method does.
   */
  protected buildFirstMessage(messages: unknown): string | null {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const config = this.config;
    if (config && !config.enableContentCapture) return null;

    const message: unknown = messages[0];
    let role: unknown = 'user';
    let content: string;
    if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
      const record = message as Record<string, unknown>;
      role = record.role ?? 'user';
      content = pyStr(record.content ?? '');
    } else {
      content = pyStr(message);
    }
    const maxLength = config ? config.contentMaxLength : 200;
    if (maxLength > 0) content = pyTruncate(content, maxLength);
    return pyJsonDumps({ role, content });
  }

  /**
   * The provider under both accepted spellings. `gen_ai.system` was renamed
   * `gen_ai.provider.name`; instrumentors write the old one and this mirrors
   * it. Never overwrites a value set deliberately.
   */
  protected withProviderAliases(attributes: Record<string, unknown>): Record<string, unknown> {
    const current = attributes[SC.GEN_AI_PROVIDER_NAME];
    const superseded = attributes[SC.GEN_AI_SYSTEM];
    if (current === superseded) return attributes; // both absent, or already consistent
    const mirrored = { ...attributes };
    if (current === undefined || current === null) mirrored[SC.GEN_AI_PROVIDER_NAME] = superseded;
    else if ((superseded === undefined || superseded === null) && this.emitSuperseded) mirrored[SC.GEN_AI_SYSTEM] = current;
    return mirrored;
  }

  /** Embeddings request shape under the registry spellings, plus the older ones under the dup policy. */
  protected addEmbeddingRequestAttributes(
    attributes: Record<string, unknown>,
    dimensions: unknown,
    encodingFormat: unknown,
  ): Record<string, unknown> {
    const emitSuperseded = this.emitSuperseded;
    if (dimensions !== undefined && dimensions !== null) {
      attributes[SC.GEN_AI_EMBEDDINGS_DIMENSION_COUNT] = dimensions;
      if (emitSuperseded) attributes[SC.GEN_AI_REQUEST_DIMENSIONS] = dimensions;
    }
    if (encodingFormat !== undefined && encodingFormat !== null) {
      const formats = Array.isArray(encodingFormat) ? encodingFormat : [encodingFormat];
      attributes[SC.GEN_AI_REQUEST_ENCODING_FORMATS] = formats.map((format) => pyStr(format));
      if (emitSuperseded) attributes[SC.GEN_AI_REQUEST_ENCODING_FORMAT] = encodingFormat;
    }
    return attributes;
  }

  /** Current token attribute names always; the superseded ones only under `gen_ai/dup`. */
  protected setTokenUsageAttributes(span: Span, promptTokens: unknown, completionTokens: unknown): void {
    const emitSuperseded = this.emitSuperseded;
    if (isPositive(promptTokens)) {
      span.setAttribute(SC.GEN_AI_USAGE_INPUT_TOKENS, Math.trunc(promptTokens));
      if (emitSuperseded) span.setAttribute(SC.GEN_AI_USAGE_PROMPT_TOKENS, Math.trunc(promptTokens));
    }
    if (isPositive(completionTokens)) {
      span.setAttribute(SC.GEN_AI_USAGE_OUTPUT_TOKENS, Math.trunc(completionTokens));
      if (emitSuperseded) span.setAttribute(SC.GEN_AI_USAGE_COMPLETION_TOKENS, Math.trunc(completionTokens));
    }
  }

  /**
   * `gen_ai.usage.<modality>.*` token counts when a provider reports them.
   * Absent modalities are omitted, not zero.
   */
  private setModalityTokenAttributes(span: Span, usage: UsageDict): void {
    for (const modality of TOKEN_MODALITIES) {
      for (const [key, template] of [
        [`${modality}_input_tokens`, SC.GEN_AI_USAGE_MODALITY_INPUT_TOKENS],
        [`${modality}_output_tokens`, SC.GEN_AI_USAGE_MODALITY_OUTPUT_TOKENS],
        [`${modality}_cache_read_input_tokens`, SC.GEN_AI_USAGE_MODALITY_CACHE_READ_INPUT_TOKENS],
      ] as const) {
        const value = usage[key];
        if (isPositive(value)) span.setAttribute(template.replace('{modality}', modality), Math.trunc(value));
      }
    }
  }

  /** Python's wrapper keeps primitives and stringifies everything else. */
  private initialAttributes(
    spanName: string,
    extractAttributes: AttributeExtractor | undefined,
    instance: unknown,
    args: unknown[],
    params: Params,
  ): Attributes {
    const initial: Attributes = {};
    if (extractAttributes) {
      try {
        const extracted = this.withProviderAliases(extractAttributes(instance, args, params));
        for (const [key, value] of Object.entries(extracted)) {
          if (value === undefined || value === null) continue;
          initial[key] = isPrimitive(value) ? value : pyStr(value);
        }
      } catch (error) {
        logger.warn(`Failed to extract attributes for span '${spanName}': ${String(error)}`);
      }
    }
    // Endpoint identity and request parameters, derived centrally. Never
    // overwrites a value the instrumentor set itself.
    try {
      for (const derived of [serverAttributes(instance), requestParameterAttributes(params)]) {
        for (const [key, value] of Object.entries(derived)) {
          if (!(key in initial)) initial[key] = value as AttributeValue;
        }
      }
    } catch (error) {
      logger.debug(`Could not derive span attributes for '${spanName}': ${String(error)}`);
    }
    // Every model-call span names its operation, also where the reference leaves it out
    // (Groq, Mistral, hand-built spans): the platform selects single model requests by it.
    if (initial[ATTR.GEN_AI_OPERATION_NAME] === undefined) {
      const operation = operationFor(spanName, initial[ATTR.GEN_AI_REQUEST_TYPE]);
      if (operation) initial[ATTR.GEN_AI_OPERATION_NAME] = operation;
    }
    // Content reaches a span only with content capture on, whatever was extracted.
    return this.config && !this.config.enableContentCapture ? withoutContent(initial) : initial;
  }

  private applySessionAndUser(span: Span, instance: unknown, args: unknown[], params: Params): void {
    const config = this.config;
    if (!config) return;
    if (config.sessionIdExtractor) {
      try {
        const sessionId = config.sessionIdExtractor(instance, args, params);
        if (sessionId) {
          span.setAttribute(ATTR.SESSION_ID, sessionId);
          // Cross-framework conversation correlation.
          span.setAttribute(ATTR.GEN_AI_CONVERSATION_ID, sessionId);
        }
      } catch (error) {
        logger.debug(`Failed to extract session ID: ${String(error)}`);
      }
    }
    if (config.userIdExtractor) {
      try {
        const userId = config.userIdExtractor(instance, args, params);
        if (userId) span.setAttribute(ATTR.USER_ID, userId);
      } catch (error) {
        logger.debug(`Failed to extract user ID: ${String(error)}`);
      }
    }
  }

  /**
   * Wrap an SDK method in a span.
   *
   * The wrapped method returns exactly what the original returned: the same
   * promise object, and for a streamed call the same stream object, observed
   * in place. Instrumentation failures never reach the caller; the original
   * method is never invoked twice.
   */
  protected createSpanWrapper(
    baseSpanName: string,
    extractAttributes?: AttributeExtractor,
    options: SpanWrapperOptions = {},
  ): <F extends (...args: never[]) => unknown>(original: F) => F {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return <F extends (...args: never[]) => unknown>(original: F): F => {
      const invoke = (self: unknown, args: unknown[]): unknown =>
        (original as unknown as (...a: unknown[]) => unknown).apply(self, args);

      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        // If instrumentation is not active, call the original directly.
        if (!instrumentor.instrumented) return invoke(this, args);

        let call: Call | undefined;
        let ctx = context.active();
        let spanName = baseSpanName;
        try {
          const params = options.params ? options.params(args) : paramsOf(args);
          if (options.spanName) spanName = options.spanName(params, args);
          if (instrumentor.shouldBypass(this, args, params)) return invoke(this, args);

          const initial = instrumentor.initialAttributes(spanName, extractAttributes, this, args, params);
          const span = instrumentor.tracer.startSpan(spanName, { attributes: initial });
          ctx = trace.setSpan(ctx, span);
          call = {
            span,
            spanName,
            startTime: now(),
            params,
            isStreaming:
              typeof options.streaming === 'function' ? options.streaming(params, args) : (options.streaming ?? Boolean(params.stream)),
            streamOf: options.streamOf,
            model: String(params.model ?? initial[ATTR.GEN_AI_REQUEST_MODEL] ?? 'unknown'),
            done: false,
          };
          // A usage holder for this span, under those of the spans it runs in.
          {
            const above = (ctx.getValue(USAGE_HOLDERS) as UsageHolder[] | undefined) ?? [];
            const holder: UsageHolder = { descendantRecorded: false, inFlight: 0 };
            holders().set(span, { holder, above });
            for (const enclosing of above) enclosing.inFlight += 1;
            call.holdersHeld = true;
            ctx = ctx.setValue(USAGE_HOLDERS, [...above, holder]);
          }
          // One more of this SDK's own calls in flight ("client", SDK_ADDITIONS.md section 12), until the span ends.
          const server = getServerMetrics();
          if (server) {
            server.clientCallStarted();
            call.counted = true;
          }
          if (span.isRecording()) instrumentor.applySessionAndUser(span, this, args, params);
          // A span that carries a session id of its own scopes the calls made inside it.
          ctx = contextWithSessionId(ctx, spanAttributes(span)[ATTR.SESSION_ID] ?? initial[ATTR.SESSION_ID]);
          // An agent invocation: the model calls made inside it are accounted to it.
          if (isAgentInvocation(initial)) {
            call.budget = new BudgetFrame();
            ctx = withBudgetFrame(ctx, call.budget);
          }
        } catch (error) {
          // Failure during span setup, before the call ran: instrumentation must
          // never break the host application.
          logger.error(`Span creation failed for '${spanName}': ${String(error)}`);
          return invoke(this, args);
        }

        const active = call;
        active.context = ctx;
        // Evaluation: the prompt is checked before the provider is called when a
        // policy blocks, and handed to the span's evaluation either way.
        const evaluation = activeEvaluation();
        if (evaluation) {
          let prompt: string | undefined;
          try {
            prompt = promptForEvaluation(active.params);
            if (prompt !== undefined) rememberTexts(active.span, { prompt });
            active.evaluated = true;
          } catch (error) {
            logger.debug(`Could not read the prompt for evaluation: ${String(error)}`);
          }
          if (evaluation.blockingActive) {
            try {
              evaluation.enforcePreCall(active.span, prompt);
            } catch (error) {
              if (!(error instanceof PolicyViolationError)) {
                logger.warn(`Pre-call policy check failed: ${String(error)}`);
              } else {
                // A decision the application asked for: the call is not made.
                instrumentor.failCall(active, error);
                throw error;
              }
            }
          }
        }
        let result: unknown;
        try {
          // The span is the active one for the duration of the call, so nested
          // work (HTTP client spans, tool calls) parents to it.
          result = context.with(ctx, () => invoke(this, args));
        } catch (error) {
          instrumentor.failCall(active, error);
          throw error;
        }

        try {
          if (!active.span.isRecording()) return instrumentor.observeUnsampled(active, result);
          if (isThenable(result)) return instrumentor.observePromise(active, result);
          return instrumentor.completeCall(active, result);
        } catch (error) {
          // Our own bookkeeping failed after the call ran. Close the span and
          // hand back what the SDK returned; never re-invoke.
          logger.warn(`Instrumentation failed for span '${spanName}': ${String(error)}`);
          instrumentor.endOnce(active);
          return result;
        }
      };
      Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
      return wrapped as unknown as F;
    };
  }

  /** Budget consumption and utilisation onto an agent span, just before it ends. */
  private finishAgentBudget(call: Call | StreamCall): void {
    const frame = (call as Call).budget;
    if (!frame) return;
    (call as Call).budget = undefined;
    try {
      const consumed = consumptionAttributes(frame);
      for (const [key, value] of Object.entries(consumed)) call.span.setAttribute(key, value);
      const attributes = spanAttributes(call.span);
      const ratio = utilization(consumed[SC.GEN_AI_AGENT_TOKEN_BUDGET_CONSUMED], attributes[SC.GEN_AI_AGENT_TOKEN_BUDGET]);
      if (ratio !== undefined) {
        this.metrics.histograms.tokenBudgetUtilization.record(ratio, {
          'gen_ai.operation.name': String(attributes[ATTR.GEN_AI_OPERATION_NAME] ?? ''),
          'gen_ai.agent.name': String(attributes[ATTR.GEN_AI_AGENT_NAME] ?? ''),
        });
      }
    } catch (error) {
      logger.debug(`Could not finish agent budget accounting: ${String(error)}`);
    }
  }

  private endOnce(call: Call): boolean {
    if (call.done) return false;
    call.done = true;
    this.finishAgentBudget(call);
    this.requestFinished(call);
    this.releaseHolders(call);
    this.endSpan(call.span, call.evaluated === true && !call.failed);
    return true;
  }

  /** The media of the request onto the span, uploading what is to be uploaded; the span waits for it. */
  protected startMedia(span: Span, params: Params): void {
    try {
      const work = emitMedia(span, this.mediaProvider, params, this.config);
      if (work) mediaWork().set(span, work);
    } catch (error) {
      logger.warn(`Failed to emit media attributes: ${String(error)}`);
    }
  }

  /** This call is no longer in flight under the spans above it. Once per call. */
  private releaseHolders(call: { span: Span; holdersHeld?: boolean }): void {
    if (!call.holdersHeld) return;
    call.holdersHeld = false;
    for (const enclosing of holders().get(call.span)?.above ?? []) enclosing.inFlight = Math.max(0, enclosing.inFlight - 1);
  }

  /** Usage was recorded on `span`: the spans above it must not record it again. */
  private markUsageRecorded(span: Span): void {
    for (const enclosing of holders().get(span)?.above ?? []) enclosing.descendantRecorded = true;
  }

  /**
   * Whether `span` may record usage: not when a span beneath it recorded, or is
   * still recording, the same call. It then says so on the span.
   */
  private mayRecordUsage(span: Span): boolean {
    if (!usageRecordedBelow(span)) return true;
    span.setAttribute(USAGE_RECORDED_BY, 'descendant');
    return false;
  }

  /** The request is no longer in flight. Once per call, whichever path ends it. */
  private requestFinished(call: { counted?: boolean }): void {
    if (!call.counted) return;
    call.counted = false;
    try {
      getServerMetrics()?.clientCallEnded();
    } catch {
      // metrics must never break the call
    }
  }

  /**
   * End the span - after whatever its evaluation has to wait for (a scorer
   * that answers with a promise). The span's end time is now, not when the
   * scorer answers.
   */
  private endSpan(span: Span, awaitEvaluation: boolean): void {
    try {
      const evaluation = awaitEvaluation ? activeEvaluation()?.prepare(span) : undefined;
      const media = mediaWork().get(span);
      const pending = evaluation && media ? Promise.all([evaluation, media]) : (evaluation ?? media);
      if (!pending) {
        span.end();
        return;
      }
      const endTime = wallClockMs();
      void pending.then(() => {
        try {
          span.end(endTime);
        } catch {
          // ending a span must not throw into the host
        }
      });
    } catch {
      // ending a span must not throw into the host
    }
  }

  /**
   * A sampled-out span: skip all extraction (it would be discarded) and record
   * only the request count and latency, so client metrics stay independent of
   * trace sampling.
   */
  private observeUnsampled(call: Call, result: unknown): unknown {
    const settle = (ok: boolean): void => {
      if (!this.endOnce(call)) return;
      if (!ok) return;
      try {
        this.metrics.counters.requests.add(1, { operation: call.spanName });
        this.metrics.histograms.latency.record(now() - call.startTime, { operation: call.spanName });
      } catch {
        // metrics must never break the call
      }
    };
    if (isApiPromise(result)) {
      let parsing = false;
      this.hookApiPromise(result, {
        onParseStart: () => {
          parsing = true;
        },
        onResult: (data) => {
          settle(true);
          return data;
        },
        onError: () => settle(false),
        onUnparsed: () => {
          if (!parsing) settle(true);
        },
      });
      return result;
    }
    if (isThenable(result)) {
      return result.then(
        (value) => {
          settle(true);
          return value;
        },
        (error: unknown) => {
          settle(false);
          throw error;
        },
      );
    }
    settle(true);
    return result;
  }

  private observePromise(call: Call, result: PromiseLike<unknown>): unknown {
    const onResult = (value: unknown): unknown => {
      try {
        return this.completeCall(call, value);
      } catch (error) {
        logger.warn(`Instrumentation failed for span '${call.spanName}': ${String(error)}`);
        this.endOnce(call);
        return value;
      }
    };
    const onError = (error: unknown): void => this.failCall(call, error);

    if (isApiPromise(result)) {
      // Set once the SDK starts parsing the body. From then on the call is
      // closed by onResult / onError - for a streamed call, by the stream - and
      // never by onUnparsed, which may still fire later: the promise is usually
      // garbage long before its stream has been read to the end.
      let parsing = false;
      this.hookApiPromise(result, {
        onParseStart: () => {
          parsing = true;
        },
        onResult,
        onError,
        // The body was never parsed here: the caller took the raw HTTP response
        // to read it itself, or dropped the promise. The call is over, and its
        // usage is not observable.
        onUnparsed: () => {
          if (parsing || call.done) return;
          try {
            this.metrics.counters.requests.add(1, { operation: call.spanName });
            this.metrics.histograms.latency.record(now() - call.startTime, { operation: call.spanName });
          } catch {
            // metrics must never break the call
          }
          call.span.setStatus({ code: SpanStatusCode.OK });
          this.endOnce(call);
        },
      });
      return result;
    }
    // Observed on a branch of its own; the caller gets the very object the SDK
    // returned. Several clients return a Promise subclass with methods of its
    // own (`withRawResponse()`), which a derived promise would not have.
    void result.then(onResult, onError);
    return result;
  }

  /**
   * Observe an SDK `APIPromise` without replacing it.
   *
   * The SDKs return a Promise subclass with extra methods (`withResponse()`,
   * `asResponse()`) and parse the body lazily. Returning a plain derived
   * promise would take those methods away from the caller, so the original
   * object is kept and its `parseResponse` step is observed instead.
   */
  private hookApiPromise(
    promise: ApiPromiseLike,
    handlers: {
      onParseStart: () => void;
      onResult: (data: unknown) => unknown;
      onError: (error: unknown) => void;
      onUnparsed: () => void;
    },
  ): void {
    const state = { parseStarted: false, rawRequested: false };

    const originalParse = promise.parseResponse;
    promise.parseResponse = function (this: unknown, ...args: unknown[]): unknown {
      state.parseStarted = true;
      handlers.onParseStart();
      let parsed: unknown;
      try {
        parsed = originalParse.apply(this, args);
      } catch (error) {
        handlers.onError(error);
        throw error;
      }
      return Promise.resolve(parsed).then(
        (data) => handlers.onResult(data),
        (error: unknown) => {
          handlers.onError(error);
          throw error;
        },
      );
    };

    const originalAsResponse = promise.asResponse;
    if (typeof originalAsResponse === 'function') {
      promise.asResponse = function (this: unknown, ...args: unknown[]): unknown {
        state.rawRequested = true;
        return originalAsResponse.apply(this, args);
      };
    }

    // The request failed: parsing never starts. Observed on a branch of its
    // own, so the caller's promise rejects exactly as before.
    Promise.resolve(promise.responsePromise).then(
      () => {
        // `withResponse()` asks for both; let the parse step register first.
        defer(() => {
          if (!state.parseStarted && state.rawRequested) handlers.onUnparsed();
        });
      },
      (error: unknown) => handlers.onError(error),
    );

    // Neither awaited nor asked for raw: closed when the promise is collected.
    //
    // The held value must not be able to reach the promise, or the promise is
    // never collected. A closure created HERE can: this scope holds the SDK's
    // own parse function, whose scope holds the promise. `onUnparsed` was created
    // by the caller, where nothing of the SDK's is in scope - pass it as it is.
    abandoned.register(promise, handlers.onUnparsed);
  }

  /** The wrapped call returned (or its promise resolved). */
  private completeCall(call: Call, result: unknown): unknown {
    if (call.done) return result;
    const { span, spanName } = call;

    // A streamed call resolves to the stream, not to the answer: the model has
    // produced nothing yet. The stream wrapper owns the span from here.
    if (call.isStreaming && this.installStreamMeasurement(call, call.streamOf ? call.streamOf(result) : result)) {
      this.metrics.counters.requests.add(1, { operation: spanName });
      return result;
    }

    this.metrics.counters.requests.add(1, { operation: spanName });
    const failure = this.resultFailure?.(result);
    if (failure !== undefined) {
      this.metrics.counters.errors.add(1, { operation: spanName, error_type: 'ResultFailure' });
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
      this.endOnce(call);
      return result;
    }
    try {
      this.recordResultMetrics(span, spanName, result, call.startTime, call.params);
      this.startMedia(span, call.params);
    } catch (error) {
      logger.warn(`Failed to record metrics for span '${spanName}': ${String(error)}`);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    this.endOnce(call);
    return result;
  }

  /** The wrapped call threw (or its promise rejected). */
  private failCall(call: Call, error: unknown): void {
    if (call.done) return;
    call.failed = true;
    const { span, spanName } = call;
    try {
      if (span.isRecording()) {
        this.metrics.counters.errors.add(1, { operation: spanName, error_type: errorTypeName(error) });
      }
    } catch {
      // metrics must never break the call
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
    recordException(span, error);
    this.endOnce(call);
  }

  // -------------------------------------------------------------------------
  // Result recording
  // -------------------------------------------------------------------------

  /** Latency, response attributes, content events, tokens, cost and finish reason for a finished call. */
  protected recordResultMetrics(span: Span, spanName: string, result: unknown, startTime: number, params: Params): void {
    const config = this.config;
    const profileFull = config?.metricsProfile === 'full';
    const recordTokenHistograms = profileFull || Boolean(config?.recordTokenHistograms);
    const recordGranular = profileFull || Boolean(config?.recordGranularCostMetrics);
    const recordFinish = profileFull || Boolean(config?.recordFinishMetrics);
    const metrics = this.metrics;

    try {
      metrics.histograms.latency.record(now() - startTime, { operation: spanName });
    } catch (error) {
      logger.warn(`Failed to record latency for span '${spanName}': ${String(error)}`);
    }

    try {
      // A llama.cpp server reports how long prefill and decode took; that is the engine's own measurement.
      const timings = typeof result === 'object' && result !== null ? (result as { timings?: unknown }).timings : undefined;
      if (timings !== undefined) for (const [key, value] of Object.entries(llamacppLatencyAttributes(timings))) span.setAttribute(key, value);
    } catch (error) {
      logger.debug(`Could not read engine timings for span '${spanName}': ${String(error)}`);
    }

    if (activeEvaluation()) {
      try {
        const response = this.responseTextForEvaluation(result);
        if (response !== undefined) rememberTexts(span, { response });
      } catch (error) {
        logger.debug(`Could not read the response for evaluation: ${String(error)}`);
      }
    }

    try {
      let responseAttributes = this.extractResponseAttributes?.(result);
      if (responseAttributes && config && !config.enableContentCapture) responseAttributes = withoutContent(responseAttributes);
      if (responseAttributes) {
        for (const [key, value] of Object.entries(this.withProviderAliases(responseAttributes))) {
          if (value === undefined || value === null) continue;
          if (isPrimitive(value) || Array.isArray(value)) span.setAttribute(key, value as AttributeValue);
          else span.setAttribute(key, pyStr(value));
        }
      }
    } catch (error) {
      logger.warn(`Failed to extract response attributes for span '${spanName}': ${String(error)}`);
    }

    try {
      if (config?.enableContentCapture) {
        this.addContentEvents?.(span, result, params);
        // Every provider the same: prompt and completion, where the instrumentor wrote none.
        if (!/embed/.test(String(spanAttributes(span)[ATTR.GEN_AI_OPERATION_NAME] ?? ''))) {
          ensureContent(span, params, this.completionTextForContent(result), (text) => this.capText(text));
        }
        const written = spanAttributes(span);
        if (written[ATTR.GEN_AI_REQUEST_TYPE] === 'embedding' && !written[ATTR.EMBEDDING_TEXT]) {
          this.addGenericEmbeddingContent(span, result, params);
        }
      }
    } catch (error) {
      logger.warn(`Failed to add content events for span '${spanName}': ${String(error)}`);
    }

    try {
      let usage = this.extractUsage(result);
      let estimated = false;
      if (!usage) {
        const estimate = this.estimateUsage(result, params);
        if (estimate) {
          usage = estimate;
          estimated = true;
        }
      }
      if (usage && typeof usage === 'object' && this.mayRecordUsage(span)) {
        if (estimated) span.setAttribute(ATTR.GEN_AI_USAGE_TOKEN_COUNT_ESTIMATED, true);
        this.recordUsage(span, spanName, usage, { recordTokenHistograms, recordGranular, deprecation: true });
        this.markUsageRecorded(span);
      }
    } catch (error) {
      logger.warn(`Failed to extract or record usage metrics for span '${spanName}': ${String(error)}`);
    }

    try {
      const finishReason = this.extractFinishReason?.(result);
      if (finishReason) {
        // The conventions define an array; the singular is this library's older
        // spelling and follows the dup policy. An array an instrumentor already
        // extracted is kept.
        if (!(SC.GEN_AI_RESPONSE_FINISH_REASONS in spanAttributes(span))) {
          span.setAttribute(SC.GEN_AI_RESPONSE_FINISH_REASONS, [String(finishReason)]);
        }
        if (this.emitSuperseded) span.setAttribute(SC.GEN_AI_RESPONSE_FINISH_REASON, finishReason);

        if (recordFinish) {
          const model = String(spanAttributes(span)[ATTR.GEN_AI_REQUEST_MODEL] ?? 'unknown');
          metrics.counters.requestFinish.add(1, { finish_reason: finishReason, model });
          if (['stop', 'length', 'end_turn', 'max_tokens'].includes(finishReason)) {
            metrics.counters.requestSuccess.add(1, { model });
          } else if (['error', 'content_filter', 'timeout', 'rate_limit'].includes(finishReason)) {
            metrics.counters.requestFailure.add(1, { finish_reason: finishReason, model });
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to extract or record finish reason for span '${spanName}': ${String(error)}`);
    }
  }

  /** Token attributes and counters for one usage dict; optionally the cost. */
  private recordTokens(
    span: Span,
    spanName: string,
    usage: UsageDict,
    model: string,
    recordTokenHistograms: boolean,
  ): void {
    const metrics = this.metrics;
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? 0;

    this.setTokenUsageAttributes(span, promptTokens, completionTokens);

    if (isPositive(promptTokens)) {
      metrics.counters.tokens.add(promptTokens, { token_type: 'prompt', operation: spanName });
      if (recordTokenHistograms) metrics.histograms.promptTokens.record(Math.trunc(promptTokens), { model, operation: spanName });
    }
    if (isPositive(completionTokens)) {
      metrics.counters.tokens.add(completionTokens, { token_type: 'completion', operation: spanName });
      if (recordTokenHistograms) {
        metrics.histograms.completionTokens.record(Math.trunc(completionTokens), { model, operation: spanName });
      }
    }
    if (isPositive(totalTokens)) {
      span.setAttribute(ATTR.GEN_AI_USAGE_TOTAL_TOKENS, Math.trunc(totalTokens));
      // To the enclosing agent invocation's budget, if there is one.
      recordInference(Math.trunc(totalTokens));
    }
  }

  /** Cost attributes and counters. Costs of zero are not written; a missing price is counted. */
  private recordCost(
    span: Span,
    spanName: string,
    usage: UsageDict,
    model: string,
    options: { recordGranular: boolean; deprecation: boolean },
  ): void {
    if (!this.config?.enableCostTracking) return;
    try {
      const metrics = this.metrics;
      // 'chat' unless the instrumentor set a request type; specific
      // instrumentors provide the actual call type.
      const callType = String(spanAttributes(span)[ATTR.GEN_AI_REQUEST_TYPE] ?? 'chat');

      if (callType === 'chat') {
        const costs = this.costCalculator.calculateGranularCost(model, usage, callType);
        if (costs !== null && costs.total > 0) {
          metrics.counters.cost.add(costs.total, { model });
          span.setAttribute(ATTR.GEN_AI_USAGE_COST_TOTAL, costs.total);
        }
        // Say where the price came from: without this an absent cost cannot be
        // told from a genuinely free call.
        const source = this.costCalculator.pricingSource(model, callType);
        span.setAttribute(ATTR.GEN_AI_USAGE_COST_PRICING_SOURCE, source);
        if (costs === null) recordPricingMissing(model, callType);

        if (options.deprecation) {
          // Models the provider has announced the end of bill normally right up
          // until withdrawal; nothing else in the telemetry distinguishes them.
          const deprecation = this.costCalculator.deprecation(model, callType);
          if (deprecation) {
            span.setAttribute(ATTR.GEN_AI_REQUEST_MODEL_DEPRECATED, true);
            span.setAttribute(ATTR.GEN_AI_REQUEST_MODEL_DEPRECATION_NOTE, deprecation);
          }
        }

        if (costs !== null) {
          // Span attributes always (audit); the per-breakdown counters are opt-in.
          const parts = [
            [costs.prompt, ATTR.GEN_AI_USAGE_COST_PROMPT, metrics.counters.costPrompt],
            [costs.completion, ATTR.GEN_AI_USAGE_COST_COMPLETION, metrics.counters.costCompletion],
            [costs.reasoning, ATTR.GEN_AI_USAGE_COST_REASONING, metrics.counters.costReasoning],
            [costs.cache_read, ATTR.GEN_AI_USAGE_COST_CACHE_READ, metrics.counters.costCacheRead],
            [costs.cache_write, ATTR.GEN_AI_USAGE_COST_CACHE_WRITE, metrics.counters.costCacheWrite],
          ] as const;
          for (const [value, attribute, counter] of parts) {
            if (value > 0) {
              if (options.recordGranular) counter.add(value, { model });
              span.setAttribute(attribute, value);
            }
          }
        }
      } else {
        // Non-chat requests (image, audio, embedding, ...): the total only.
        const cost = this.costCalculator.calculateCost(model, usage, callType);
        if (cost !== null && cost > 0) {
          metrics.counters.cost.add(cost, { model });
          span.setAttribute(ATTR.GEN_AI_USAGE_COST_TOTAL, cost);
        }
        if (cost === null) recordPricingMissing(model, callType);
      }
    } catch (error) {
      // A pricing entry in a shape the calculator cannot use (13 shipped entries
      // are), or usage it cannot do arithmetic on. Either way no cost was
      // recorded for this call, and that is counted.
      logger.warn(`Failed to calculate cost for span '${spanName}': ${String(error)}`);
      recordPricingMissing(model, String(spanAttributes(span)[ATTR.GEN_AI_REQUEST_TYPE] ?? 'chat'));
    }
  }

  private recordUsage(
    span: Span,
    spanName: string,
    usage: UsageDict,
    options: { recordTokenHistograms: boolean; recordGranular: boolean; deprecation: boolean },
  ): void {
    const model = String(spanAttributes(span)[ATTR.GEN_AI_REQUEST_MODEL] ?? 'unknown');
    this.recordTokens(span, spanName, usage, model, options.recordTokenHistograms);

    // Detailed breakdowns, when the provider supplies them.
    const cacheRead = usage.cache_read_input_tokens;
    if (isPositive(cacheRead)) span.setAttribute(SC.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, Math.trunc(cacheRead));
    const cacheCreation = usage.cache_creation_input_tokens;
    if (isPositive(cacheCreation)) {
      // `cache_write` is the current spelling; `cache_creation` the superseded one.
      span.setAttribute(SC.GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS, Math.trunc(cacheCreation));
      if (this.emitSuperseded) span.setAttribute(SC.GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, Math.trunc(cacheCreation));
    }
    const details = usage.completion_tokens_details;
    if (typeof details === 'object' && details !== null) {
      const reasoning = (details as Record<string, unknown>).reasoning_tokens;
      if (isPositive(reasoning)) span.setAttribute(SC.GEN_AI_USAGE_REASONING_TOKENS, Math.trunc(reasoning));
    }
    this.setModalityTokenAttributes(span, usage);

    this.recordCost(span, spanName, usage, model, options);
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Arrange for a streamed result to be measured. Returns true when the stream
   * wrapper took ownership of the span; the caller must then NOT end it.
   *
   * The stream object the SDK returned is observed in place and handed back
   * unchanged, so `controller`, `tee()` and the rest keep working.
   */
  private installStreamMeasurement(call: Call, result: unknown): boolean {
    if (!isAsyncIterable(result)) return false;
    const timing = new StreamTiming(call.startTime);
    if (this.config?.enableContentCapture) timing.text = new StreamText(this.config.contentMaxLength);
    const stream = result as unknown as Record<PropertyKey, unknown>;
    // The measuring iterator holds the stream object - deliberately. While a
    // reader holds the iterator the stream must stay alive, or the finalizer
    // registered below would end the span in the middle of the read. Once the
    // reader lets go of the iterator, both become garbage together. (The
    // finalizer itself is created elsewhere and reaches neither.)
    const isAborted = (): boolean => {
      const controller = stream.controller as { signal?: { aborted?: boolean } } | undefined;
      return controller?.signal?.aborted === true;
    };

    const measure = (iterator: AsyncIterator<unknown>): AsyncIterableIterator<unknown> => {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const instrumentor = this;
      const measured: AsyncIterableIterator<unknown> = {
        async next(...args: [] | [unknown]): Promise<IteratorResult<unknown>> {
          let step: IteratorResult<unknown>;
          try {
            // In the call's context: a framework's generator body makes its model calls
            // here, and they belong under the framework's span.
            step = await (call.context ? context.with(call.context, () => iterator.next(...args)) : iterator.next(...args));
          } catch (error) {
            instrumentor.finishStream(call, timing, { kind: 'error', error });
            throw error;
          }
          if (step.done) {
            // The SDKs end a stream silently when its request was aborted.
            instrumentor.finishStream(call, timing, isAborted() ? { kind: 'cancelled' } : { kind: 'completed' });
          } else {
            instrumentor.observeStreamChunk(call, timing, step.value);
          }
          return step;
        },
        async return(value?: unknown): Promise<IteratorResult<unknown>> {
          // The consumer stopped reading (`break`, an exception in its loop).
          try {
            return (await iterator.return?.(value)) ?? { done: true, value };
          } finally {
            instrumentor.finishStream(call, timing, { kind: 'cancelled' });
          }
        },
        async throw(error?: unknown): Promise<IteratorResult<unknown>> {
          try {
            if (iterator.throw) return await iterator.throw(error);
            throw error;
          } finally {
            instrumentor.finishStream(call, timing, { kind: 'error', error });
          }
        },
        [Symbol.asyncIterator]() {
          return measured;
        },
      };
      return measured;
    };

    if (typeof stream.next === 'function') {
      // The stream is itself the iterator (an async generator, a reader-backed
      // stream): its consumers may call `next()` directly, so the methods are
      // replaced on the object, not only what `[Symbol.asyncIterator]()` returns.
      const inner: AsyncIterator<unknown> = {
        next: (stream.next as AsyncIterator<unknown>['next']).bind(stream),
        return: typeof stream.return === 'function' ? (stream.return as NonNullable<AsyncIterator<unknown>['return']>).bind(stream) : undefined,
        throw: typeof stream.throw === 'function' ? (stream.throw as NonNullable<AsyncIterator<unknown>['throw']>).bind(stream) : undefined,
      };
      const measured = measure(inner);
      for (const method of ['next', 'return', 'throw'] as const) {
        if (method !== 'next' && typeof stream[method] !== 'function') continue;
        Object.defineProperty(stream, method, { configurable: true, writable: true, value: measured[method] });
      }
    } else if (typeof stream.iterator === 'function') {
      // The SDK stream classes keep their iterator factory in this field, and
      // both `[Symbol.asyncIterator]()` and `tee()` go through it.
      const original = stream.iterator as () => AsyncIterator<unknown>;
      stream.iterator = function (this: unknown): AsyncIterator<unknown> {
        return measure(original.call(this));
      };
    } else {
      const original = stream[Symbol.asyncIterator] as () => AsyncIterator<unknown>;
      Object.defineProperty(stream, Symbol.asyncIterator, {
        configurable: true,
        writable: true,
        value(this: unknown): AsyncIterator<unknown> {
          return measure(original.call(this));
        },
      });
    }

    // A stream that is never iterated would otherwise leave its span open.
    abandoned.register(stream, this.cancelWhenAbandoned(call, timing));
    return true;
  }

  /**
   * The finalizer for a stream nobody iterated. Created in a scope of its own
   * so that it can reach nothing but the call record: a finalizer that can
   * reach its target keeps the target alive, and then never runs.
   */
  private cancelWhenAbandoned(call: Call, timing: StreamTiming): () => void {
    return () => this.finishStream(call, timing, { kind: 'cancelled' });
  }

  /** First-token and inter-token latency for one streamed chunk. */
  protected observeStreamChunk(call: Call | StreamCall, timing: StreamTiming, chunk: unknown): void {
    try {
      const current = now();
      timing.chunkCount += 1;
      if (timing.ttft === null) {
        timing.ttft = current - timing.startTime;
        this.recordTimeToFirstToken(call.span, call.spanName, timing.ttft, call.model);
      } else {
        this.metrics.histograms.tbt.record(current - timing.lastChunkTime, { model: call.model, operation: call.spanName });
      }
      timing.lastChunkTime = current;
      timing.lastChunk = chunk;
      // With content capture on, the completion is assembled as it streams; off, nothing is kept.
      if (timing.text) timing.text.add(this.streamChunkTextForContent(chunk));
    } catch (error) {
      logger.debug(`Failed to observe a streamed chunk: ${String(error)}`);
    }
    // A missing token count is a reporting gap; a raised exception is an outage.
    try {
      this.accumulateStreamUsage(timing, chunk);
    } catch (error) {
      logger.debug(`Failed to accumulate streamed usage: ${String(error)}`);
    }
  }

  /** A measured TTFT under both attribute spellings and both histograms. */
  protected recordTimeToFirstToken(span: Span, spanName: string, ttft: number, model: string): void {
    span.setAttribute(SC.GEN_AI_SERVER_TIME_TO_FIRST_TOKEN, ttft);
    span.setAttribute(SC.GEN_AI_SERVER_TTFT, ttft);
    const attributes = { model, operation: spanName };
    this.metrics.histograms.ttft.record(ttft, attributes);
    this.metrics.histograms.timeToFirstToken.record(ttft, attributes);
  }

  /**
   * TPOT, or the reason it could not be measured. It needs a measured TTFT and
   * a real output-token count; without usage nothing is emitted, because a
   * zero is indistinguishable from an instant response once averaged.
   */
  protected recordTimePerOutputToken(
    span: Span,
    spanName: string,
    ttft: number | null,
    duration: number,
    outputTokens: unknown,
    model: string,
  ): void {
    if (ttft === null) return;
    if (!isPositive(outputTokens)) {
      span.setAttribute(SC.GEN_AI_STREAMING_TPOT_UNAVAILABLE_REASON, 'output_token_count_unavailable');
      return;
    }
    // The first token is excluded: its cost is already reported as TTFT.
    const tpot = Math.max(duration - ttft, 0.0) / Math.max(Math.trunc(outputTokens) - 1, 1);
    span.setAttribute(SC.GEN_AI_SERVER_TIME_PER_OUTPUT_TOKEN, tpot);
    this.metrics.histograms.timePerOutputToken.record(tpot, { model, operation: spanName });
  }

  /**
   * Close the span of a stream, once: completed, cancelled by its consumer, or
   * failed part-way.
   */
  protected finishStream(call: Call | StreamCall, timing: StreamTiming, outcome: StreamOutcome): void {
    if (call.done) return;
    call.done = true;
    const { span, spanName, model } = call;
    try {
      const duration = now() - timing.startTime;
      const metrics = this.metrics;
      const completed = outcome.kind === 'completed';

      if (outcome.kind !== 'error') metrics.histograms.latency.record(duration, { operation: spanName });
      span.setAttribute(ATTR.GEN_AI_STREAMING_TOKEN_COUNT, timing.chunkCount);

      // Most providers repeat the full usage on the final chunk. One that
      // splits it across events accumulated it, and what it assembled wins.
      let outputTokens: unknown;
      try {
        let usage = timing.usage;
        if (usage === null && timing.lastChunk !== undefined) usage = this.extractUsage(timing.lastChunk);
        if (usage && typeof usage === 'object' && this.mayRecordUsage(span)) {
          this.markUsageRecorded(span);
          outputTokens = usage.completion_tokens ?? 0;
          // The streaming path records the token histograms unconditionally.
          this.recordTokens(span, spanName, usage, model, true);
          // A cost is recorded for a completed stream only: tokens seen before a
          // cancellation or a failure are facts, a cost computed from them is not.
          if (completed) this.recordCost(span, spanName, usage, model, { recordGranular: true, deprecation: false });
        } else {
          logger.debug('No usage information found in streaming response');
        }
      } catch (error) {
        logger.warn(`Failed to extract usage from streaming response: ${String(error)}`);
      }

      if (completed) {
        if ('params' in call) this.startMedia(span, call.params);
        this.recordTimePerOutputToken(span, spanName, timing.ttft, duration, outputTokens, model);
        // Content capture on: the assembled completion, as a buffered call carries it.
        if (timing.text && 'params' in call && !/embed/.test(String(spanAttributes(span)[ATTR.GEN_AI_OPERATION_NAME] ?? ''))) {
          try {
            ensureContent(span, call.params, timing.text.value, (text) => this.capText(text));
          } catch (error) {
            logger.debug(`Failed to add streamed content for span '${spanName}': ${String(error)}`);
          }
        }
        span.setStatus({ code: SpanStatusCode.OK });
      } else if (outcome.kind === 'cancelled') {
        metrics.counters.errors.add(1, { operation: spanName, error_type: STREAM_CANCELLED });
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'stream cancelled before completion' });
      } else {
        metrics.counters.errors.add(1, { operation: spanName, error_type: errorTypeName(outcome.error) });
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(outcome.error) });
        recordException(span, outcome.error);
        logger.warn(`Error in streaming wrapper: ${errorMessage(outcome.error)}`);
      }
    } catch (error) {
      logger.warn(`Failed to finalize stream for span '${spanName}': ${String(error)}`);
    } finally {
      this.finishAgentBudget(call);
      this.requestFinished(call as { counted?: boolean });
      this.releaseHolders(call as { span: Span; holdersHeld?: boolean });
      this.endSpan(span, outcome.kind === 'completed' && (call as { evaluated?: boolean }).evaluated === true);
    }
  }

  // -------------------------------------------------------------------------
  // Embedding content
  // -------------------------------------------------------------------------

  /** Bounded embedding text for providers without their own content hook. */
  private addGenericEmbeddingContent(span: Span, result: unknown, params: Params): void {
    let value: unknown = params.input ?? params.texts ?? params.text ?? params.prompt;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      value = nested.text || nested.texts || nested.prompt;
    }
    if (Array.isArray(value)) value = value.length > 0 ? value[0] : '';
    if (typeof value !== 'string') return;
    const model = String(spanAttributes(span)[ATTR.GEN_AI_REQUEST_MODEL] ?? 'unknown');
    let vector: unknown;
    const record = result as { data?: { embedding?: unknown }[]; embedding?: unknown } | null;
    if (record && Array.isArray(record.data) && record.data.length > 0) vector = record.data[0]?.embedding;
    if (vector === undefined || vector === null) vector = record?.embedding;
    this.addEmbeddingAttributes(span, model, value, Array.isArray(vector) ? (vector as number[]) : undefined);
  }

  /** `embedding.model_name`, the embedded text (500 characters), and the vector only when asked. */
  protected addEmbeddingAttributes(span: Span, model: string, inputText: string, vector?: number[]): void {
    span.setAttribute(ATTR.EMBEDDING_MODEL_NAME, model);
    span.setAttribute(ATTR.EMBEDDING_TEXT, pyTruncate(inputText, 500));
    if (vector && vector.length > 0 && this.config?.captureEmbeddingVectors) {
      span.setAttribute(ATTR.EMBEDDING_VECTOR, pyJsonDumps(vector));
      span.setAttribute(ATTR.EMBEDDING_VECTOR_DIMENSION, vector.length);
    }
  }

  /** Start a span whose lifetime a helper owns (a stream manager, for example). */
  protected startStreamCall(spanName: string, attributes: Attributes, model: string): StreamCall {
    return { span: this.tracer.startSpan(spanName, { attributes }), spanName, model, done: false };
  }
}

/** The part of a call a stream finalizer needs. */
export interface StreamCall {
  span: Span;
  spanName: string;
  model: string;
  done: boolean;
}
