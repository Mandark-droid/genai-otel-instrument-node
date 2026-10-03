/**
 * Instrumentor for the official `@anthropic-ai/sdk` package: `messages.create`
 * (buffered and streamed) and the `messages.stream()` helper.
 *
 * A port of `genai_otel/instrumentors/anthropic_instrumentor.py`: same span
 * names (`anthropic.messages.create`, `anthropic.messages.stream`), same
 * attributes, same usage handling - including the two things that are easy to
 * get wrong:
 *
 * - Anthropic spreads usage over a stream: `message_start` carries the input
 *   tokens, `message_delta` the output tokens, `message_stop` none at all.
 * - The `message_delta` counts are CUMULATIVE. They are merged with `max`, never
 *   summed; a tool-use stream sends several and a sum would bill several times
 *   the tokens used.
 *
 * Like the reference, this records no response id, finish reason or tool-call
 * attributes for Anthropic, and no `gen_ai.operation.name`.
 */
import { context, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { pyStr, pyTruncate } from '../pycompat';
import { ATTR } from '../semconv';
import {
  BaseInstrumentor,
  clientBaseUrl,
  epochSeconds,
  findBaseUrlClaim,
  StreamTiming,
  type Params,
  type StreamCall,
  type UsageDict,
} from './base';
import { StreamText } from './content';
import { exportedClass, loadModuleCopies, unwrapMethod, wrapMethod } from './patch';

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/** The SDK marks the request its `stream()` helper makes with this header. */
const HELPER_METHOD_HEADER = 'x-stainless-helper-method';

function capContent(config: OTelConfig | undefined, text: unknown): string | undefined {
  if (text === null || text === undefined) return undefined;
  const value = pyStr(text);
  const maxLength = config?.contentMaxLength ?? 0;
  return maxLength > 0 ? pyTruncate(value, maxLength) : value;
}

function defined(attributes: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = value;
  return out;
}

export class AnthropicInstrumentor extends BaseInstrumentor {
  private patched: [object, string][] = [];
  private stopListening: (() => void) | undefined;
  /** Above zero while the `stream()` helper is making its own `create()` call. */
  private insideStreamHelper = 0;

  /**
   * Patch every copy of `@anthropic-ai/sdk` that can be loaded. The CommonJS
   * build is patched before this returns; the returned promise settles once the
   * ES-module build is patched as well.
   *
   * The methods live on the shared `Messages` resource class, so every client
   * built on it is covered, the Bedrock and Vertex clients included.
   */
  instrument(config: OTelConfig): Promise<void> {
    // Unlike the reference instrumentor (v1.30.0), which never sets its
    // configuration up and so ignores custom pricing.
    this.setupConfig(config);
    const copies = loadModuleCopies('@anthropic-ai/sdk');
    for (const module of copies.commonjs) this.patchModule(module);
    this.stopListening?.();
    this.stopListening = copies.whenLoaded((module) => this.patchModule(module));
    return copies.esm.then((modules) => {
      for (const module of modules) this.patchModule(module);
    });
  }

  /** Instrument a given `@anthropic-ai/sdk` module (or anything exposing the `Anthropic` class). */
  instrumentModule(module: unknown, config: OTelConfig): void {
    this.setupConfig(config);
    this.patchModule(module);
  }

  uninstrument(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    for (const [target, name] of this.patched) unwrapMethod(target, name);
    this.patched = [];
    this.instrumented = false;
  }

  private patchModule(module: unknown): void {
    try {
      const client = exportedClass(module, 'Anthropic') as { Messages?: { prototype?: object } } | undefined;
      const prototype = client?.Messages?.prototype;
      if (!prototype) return;

      const create = this.createSpanWrapper('anthropic.messages.create', (_instance, _args, params) =>
        this.anthropicAttributes(params),
      );
      if (wrapMethod(prototype, 'create', create)) this.patched.push([prototype, 'create']);
      if (wrapMethod(prototype, 'stream', (original) => this.wrapStream(original as (...args: unknown[]) => unknown))) {
        this.patched.push([prototype, 'stream']);
      }
      this.instrumented = true;
      logger.info('Anthropic instrumentation enabled');
    } catch (error) {
      logger.error(`Failed to instrument Anthropic: ${String(error)}`);
      if (this.config?.failOnError) throw error;
    }
  }

  protected override shouldBypass(instance: unknown, args: unknown[]): boolean {
    // The stream() helper issues its request through create(); that call is
    // already covered by the helper's own span.
    if (this.insideStreamHelper > 0) return true;
    const options = args[1];
    if (isObject(options) && isObject(options.headers)) {
      for (const [name, value] of Object.entries(options.headers)) {
        if (name.toLowerCase() === HELPER_METHOD_HEADER && value === 'stream') return true;
      }
    }
    return this.claimed(instance);
  }

  /** A client pointed at an aggregator is traced by its dedicated instrumentor. */
  private claimed(instance: unknown): boolean {
    const claimed = findBaseUrlClaim(clientBaseUrl(instance));
    if (claimed) logger.debug(`Skipping generic Anthropic instrumentation for client handled by the '${claimed}' instrumentor`);
    return claimed !== undefined;
  }

  private anthropicAttributes(params: Params): Obj {
    const attributes: Obj = {};
    const messages = Array.isArray(params.messages) ? params.messages : [];
    attributes[ATTR.GEN_AI_SYSTEM] = 'anthropic';
    attributes[ATTR.GEN_AI_REQUEST_MODEL] = params.model ?? 'unknown';
    // Not in the reference's Anthropic spans; every model call carries it here (SDK_ADDITIONS.md section 6).
    attributes[ATTR.GEN_AI_OPERATION_NAME] = 'chat';
    attributes[ATTR.GEN_AI_REQUEST_MESSAGE_COUNT] = messages.length;
    const firstMessage = this.buildFirstMessage(messages);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  // -------------------------------------------------------------------------
  // messages.stream()
  // -------------------------------------------------------------------------

  /**
   * `stream()` returns a `MessageStream` at once and the generation happens
   * afterwards, so its span has to outlive the call. The stream object is
   * handed back untouched apart from one thing: its internal event dispatch is
   * observed. No listener is registered, because the SDK decides whether an
   * unhandled stream error becomes an unhandled rejection by whether the caller
   * has listeners, and instrumentation must not look like a caller.
   */
  private wrapStream(original: (...args: unknown[]) => unknown): (...args: never[]) => unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return function (this: unknown, ...args: unknown[]): unknown {
      if (!instrumentor.instrumented || instrumentor.claimed(this)) return original.apply(this, args);

      let call: StreamCall;
      try {
        const first = args[0];
        const params: Params = isObject(first) ? first : {};
        const extracted = instrumentor.withProviderAliases(instrumentor.anthropicAttributes(params));
        const attributes: Attributes = {};
        for (const [key, value] of Object.entries(extracted)) {
          if (value === undefined || value === null) continue;
          attributes[key] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : pyStr(value);
        }
        call = instrumentor.startStreamCall('anthropic.messages.stream', attributes, String(params.model ?? 'unknown'));
      } catch (error) {
        // Never break the caller's call.
        logger.debug(`Could not start span for anthropic.messages.stream: ${String(error)}`);
        return original.apply(this, args);
      }

      const timing = new StreamTiming(epochSeconds());
      if (instrumentor.config?.enableContentCapture) timing.text = new StreamText(instrumentor.config.contentMaxLength);
      // The request, for the content assembled from the stream.
      Object.assign(call, { params: isObject(args[0]) ? args[0] : {} });
      let stream: unknown;
      instrumentor.insideStreamHelper += 1;
      try {
        stream = context.with(trace.setSpan(context.active(), call.span), () => original.apply(this, args));
      } catch (error) {
        instrumentor.finishStream(call, timing, { kind: 'error', error });
        throw error;
      } finally {
        instrumentor.insideStreamHelper -= 1;
      }

      try {
        instrumentor.observeMessageStream(stream, call, timing);
      } catch (error) {
        logger.debug(`Could not observe anthropic.messages.stream: ${String(error)}`);
        instrumentor.finishStream(call, timing, { kind: 'completed' });
      }
      return stream;
    } as (...args: never[]) => unknown;
  }

  private observeMessageStream(stream: unknown, call: StreamCall, timing: StreamTiming): void {
    if (!isObject(stream) || typeof stream._emit !== 'function') {
      // Not the shape this SDK version is known to have; nothing can be measured.
      this.finishStream(call, timing, { kind: 'completed' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    const emit = stream._emit as (this: unknown, event: string, ...args: unknown[]) => unknown;
    let failure: { error: unknown } | undefined;
    let aborted = false;

    stream._emit = function (this: unknown, event: string, ...args: unknown[]): unknown {
      try {
        if (event === 'streamEvent') instrumentor.observeStreamChunk(call, timing, args[0]);
        else if (event === 'error') failure = { error: args[0] };
        else if (event === 'abort') aborted = true;
        else if (event === 'end') {
          // The SDK emits `end` after `error` and after `abort` as well.
          if (aborted) instrumentor.finishStream(call, timing, { kind: 'cancelled' });
          else if (failure) instrumentor.finishStream(call, timing, { kind: 'error', error: failure.error });
          else {
            if (timing.usage === null) instrumentor.adoptFinalUsage(timing, this);
            instrumentor.finishStream(call, timing, { kind: 'completed' });
          }
        }
      } catch (error) {
        logger.debug(`Failed to observe an anthropic.messages.stream event: ${String(error)}`);
      }
      return emit.apply(this, [event, ...args]);
    };
  }

  /** Take usage off the accumulated message when no event carried any. */
  private adoptFinalUsage(timing: StreamTiming, stream: unknown): void {
    try {
      const snapshot = isObject(stream) ? stream.currentMessage : undefined;
      const usage = snapshot !== undefined && snapshot !== null ? this.extractUsage(snapshot) : null;
      if (usage) timing.usage = usage;
    } catch (error) {
      // A missing count is not an outage.
      logger.debug(`Could not read the final Anthropic message snapshot: ${String(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * The usage payload of a response or stream event, or null/undefined.
   *
   * A buffered `Message` and a `message_delta` event carry `usage` directly;
   * `message_start` carries it one level down, on the partial `message`. A
   * `usage` that exists but is null means "none reported for this event" - an
   * answer, not an invitation to look on `message`.
   */
  private static usageObject(result: unknown): unknown {
    if (!isObject(result)) return undefined;
    if ('usage' in result) return result.usage;
    const message = result.message;
    return isObject(message) ? message.usage : undefined;
  }

  /** One token count, treating anything non-numeric as absent. */
  private static tokenCount(usage: Obj, name: string): number {
    const value = usage[name];
    return typeof value === 'number' ? Math.trunc(value) : 0;
  }

  /** Response identity: not on the reference's Anthropic spans (SDK_ADDITIONS.md section 6). */
  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    if (typeof result.id === 'string') attributes[ATTR.GEN_AI_RESPONSE_ID] = result.id;
    if (typeof result.model === 'string') attributes[ATTR.GEN_AI_RESPONSE_MODEL] = result.model;
    return attributes;
  }

  protected override extractFinishReason(result: unknown): string | null {
    return isObject(result) && typeof result.stop_reason === 'string' && result.stop_reason ? result.stop_reason : null;
  }

  protected override extractUsage(result: unknown): UsageDict | null {
    const usage = AnthropicInstrumentor.usageObject(result);
    if (!isObject(usage)) return null;

    const inputTokens = AnthropicInstrumentor.tokenCount(usage, 'input_tokens');
    const outputTokens = AnthropicInstrumentor.tokenCount(usage, 'output_tokens');
    const mapped: UsageDict = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    };
    // Prompt-cache tokens: read from cache, and written to cache.
    if ('cache_read_input_tokens' in usage) {
      mapped.cache_read_input_tokens = AnthropicInstrumentor.tokenCount(usage, 'cache_read_input_tokens');
    }
    if ('cache_creation_input_tokens' in usage) {
      mapped.cache_creation_input_tokens = AnthropicInstrumentor.tokenCount(usage, 'cache_creation_input_tokens');
    }
    return mapped;
  }

  /**
   * Fold usage across a streamed message, with `max`, not a sum: the provider
   * documents the `message_delta` counts as cumulative. Deltas of 5 then 9 are
   * 9 output tokens, not 14.
   */
  protected override accumulateStreamUsage(timing: StreamTiming, chunk: unknown): void {
    const usage = this.extractUsage(chunk);
    if (!usage) return;

    const merged: UsageDict = timing.usage ? { ...timing.usage } : {};
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value !== 'number' || value <= 0) continue;
      const previous = typeof merged[key] === 'number' ? (merged[key] as number) : 0;
      merged[key] = Math.max(previous, value);
    }
    if ('prompt_tokens' in merged || 'completion_tokens' in merged) {
      merged.total_tokens = ((merged.prompt_tokens as number | undefined) ?? 0) + ((merged.completion_tokens as number | undefined) ?? 0);
    }
    if (Object.keys(merged).length > 0) timing.usage = merged;
  }

  // -------------------------------------------------------------------------
  // Content capture (only called when content capture is on)
  // -------------------------------------------------------------------------

  protected override addContentEvents(span: Span, result: unknown, params: Params): void {
    const config = this.config;
    const messages = Array.isArray(params.messages) ? params.messages : [];
    messages.forEach((message: unknown, index) => {
      if (!isObject(message)) return;
      span.addEvent(
        `gen_ai.prompt.${index}`,
        defined({
          [ATTR.GEN_AI_PROMPT_ROLE]: String(message.role ?? 'unknown'),
          [ATTR.GEN_AI_PROMPT_CONTENT]: capContent(config, 'content' in message ? message.content : ''),
        }),
      );
    });

    if (isObject(result) && Array.isArray(result.content) && result.content.length > 0) {
      let responseText: string | undefined;
      (result.content as unknown[]).forEach((block, index) => {
        if (!isObject(block) || !('text' in block)) return;
        const content = capContent(config, block.text);
        span.addEvent(
          `gen_ai.completion.${index}`,
          defined({ [ATTR.GEN_AI_COMPLETION_ROLE]: 'assistant', [ATTR.GEN_AI_COMPLETION_CONTENT]: content }),
        );
        // The first block, when it is text, is the response the evaluation reads.
        if (index === 0) responseText = content;
      });
      if (responseText) span.setAttribute(ATTR.GEN_AI_RESPONSE, responseText);
    }
  }
}
