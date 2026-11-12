/**
 * Instrumentation for the A2UI agent SDK for TypeScript, `@a2ui/agent` 0.1.0 (decision A2UI-D11). A
 * port of the `a2ui-agent-sdk` half of `genai_otel/a2ui_semconv/instrumentor.py`.
 *
 * It works whatever carries the UI: A2A, an HTTP stream, AG-UI, MCP or something of the
 * application's own.
 *
 * What it records
 * ---------------
 * - `A2uiRequestProcessor.parseResponse` opens an INTERNAL span `a2ui.parse_response`. When parsing or
 *   validation throws, the span is ERROR with `error.type` set to the error's class and
 *   `a2ui.validation.outcome=invalid`: the model wrote UI the agent SDK rejected, and the user sees
 *   nothing. Under an LLM span it is that span's child.
 * - `A2uiRequestProcessor.openStream` opens `a2ui.parse_stream`. It ends when the stream does
 *   (`close()` returns, or `feed` / `close` throws) and carries the totals. A stream opened with
 *   `afterRejectedBlock: 'continue'` reads past a rejected block; the span is ERROR then too, because
 *   a block failed validation.
 *
 * `@a2ui/agent` 0.1.0 has no renderer-to-agent message processor, so there is no `a2ui.process` span
 * (Python's `RendererToAgentMessageProcessor.process_message`) until the TypeScript SDK adds one.
 * The package is ES-module only; it is patched through the class prototype, so a processor built
 * before `instrument()` is traced too.
 */
import { context, trace, type Span, type Tracer } from '@opentelemetry/api';
import { PatchingInstrumentor, type PatchTarget } from '../instrumentors/patching';
import { exportedClass } from '../instrumentors/wrap';
import type { UsageDict } from '../instrumentors/base';
import { activatesCallSpans } from '../call-scope';
import { logger } from '../logger';
import { stateSlot } from '../state';
import { VERSION } from '../version';
import { SIDE_AGENT, SPAN_PARSE_RESPONSE, SPAN_PARSE_STREAM, VALIDATION_INVALID, VALIDATION_VALID } from './attributes';
import type { A2uiObservation } from './extract';
import { A2uiScope, abandonedScopes } from './scope';
import { settingsOf, type A2uiSettings } from './settings';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export const A2UI_AGENT_PACKAGE = '@a2ui/agent';
const INSTRUMENTATION_SCOPE = 'genai_otel.a2ui';
const STREAM_MARKER = Symbol.for('traceverse.genai-otel-instrument.a2ui-stream');

/** Feed the A2UI messages of parsed response parts to `obs` as the agent's. */
function addParts(obs: A2uiObservation, parts: unknown): void {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (isMapping(part) && Array.isArray(part.a2ui)) obs.addPayload(part.a2ui, SIDE_AGENT);
  }
}

/** The parts an A2UI error carries: what was read and applied before it failed. */
function partialResults(error: unknown): unknown {
  return isMapping(error) ? error.partialResults : undefined;
}

export class A2uiAgentInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'A2UI';
  protected readonly packages = [A2UI_AGENT_PACKAGE];
  protected override get owner(): string {
    return 'a2ui.agent';
  }

  protected override get tracer(): Tracer {
    return trace.getTracer(INSTRUMENTATION_SCOPE, VERSION);
  }

  protected extractUsage(): UsageDict | null {
    return null;
  }

  private settings(): A2uiSettings {
    return settingsOf(this.config);
  }

  /** `GENAI_A2UI_ENABLED=false` turns the agent wrappers into pass-throughs. */
  private active(): boolean {
    return this.instrumented && this.settings().a2uiEnabled;
  }

  protected targets(module: unknown): PatchTarget[] {
    const processor: unknown = exportedClass(module, 'A2uiRequestProcessor');
    if (typeof processor !== 'function') return [];
    const holder = (processor as { prototype: object }).prototype;
    return [
      { holder, method: 'parseResponse', wrap: (original) => this.parseResponseWrapper(original) },
      { holder, method: 'openStream', wrap: (original) => this.openStreamWrapper(original) },
    ];
  }

  private parseResponseWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return function (this: unknown, ...args: unknown[]): unknown {
      const call = (): unknown => (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      if (!instrumentor.active()) return call();
      let span: Span;
      try {
        span = instrumentor.tracer.startSpan(SPAN_PARSE_RESPONSE);
      } catch (error) {
        logger.debug(`a2ui.parse_response span not started: ${String(error)}`);
        return call();
      }
      const scope = new A2uiScope(span, () => instrumentor.settings());
      let result: unknown;
      try {
        result = activatesCallSpans() ? context.with(trace.setSpan(context.active(), span), call) : call();
      } catch (error) {
        scope.obs.setOutcome(VALIDATION_INVALID);
        addParts(scope.obs, partialResults(error));
        scope.fail(error);
        scope.finish();
        throw error;
      }
      scope.obs.sidesSeen.add(SIDE_AGENT);
      addParts(scope.obs, result);
      scope.obs.setOutcome(VALIDATION_VALID);
      scope.finish();
      return result;
    } as unknown as AnyFunction;
  }

  private openStreamWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return function (this: unknown, ...args: unknown[]): unknown {
      const call = (): unknown => (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      if (!instrumentor.active()) return call();
      // Not made current: the stream outlives this call, and the caller's code between chunks must
      // not run with our span as its parent.
      let span: Span;
      try {
        span = instrumentor.tracer.startSpan(SPAN_PARSE_STREAM);
      } catch (error) {
        logger.debug(`a2ui.parse_stream span not started: ${String(error)}`);
        return call();
      }
      const scope = new A2uiScope(span, () => instrumentor.settings());
      scope.obs.sidesSeen.add(SIDE_AGENT);
      let stream: unknown;
      try {
        stream = call();
      } catch (error) {
        scope.obs.setOutcome(VALIDATION_INVALID);
        scope.fail(error);
        scope.finish();
        throw error;
      }
      if (!instrumentor.wrapStream(stream, scope)) scope.finish();
      return stream;
    } as unknown as AnyFunction;
  }

  /** Make `feed` and `close` of one stream feed `scope`. False when they cannot. */
  private wrapStream(stream: unknown, scope: A2uiScope): boolean {
    if (!isMapping(stream) || (stream as Record<symbol, unknown>)[STREAM_MARKER]) return false;
    const feed = stream.feed;
    const close = stream.close;
    if (typeof feed !== 'function' || typeof close !== 'function') return false;

    const read = (parts: unknown): void => {
      addParts(scope.obs, parts);
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (isMapping(part) && part.type === 'error') {
          scope.obs.setOutcome(VALIDATION_INVALID);
          scope.fail(part.error ?? new Error('rejected block'));
        }
      }
    };
    const failed = (error: unknown): never => {
      scope.obs.setOutcome(VALIDATION_INVALID);
      addParts(scope.obs, partialResults(error));
      scope.fail(error);
      scope.finish();
      throw error;
    };
    try {
      Object.defineProperty(stream, 'feed', {
        configurable: true,
        writable: true,
        value: function (...args: unknown[]): unknown {
          let parts: unknown;
          try {
            parts = (feed as (...a: unknown[]) => unknown).apply(stream, args);
          } catch (error) {
            return failed(error);
          }
          read(parts);
          return parts;
        },
      });
      Object.defineProperty(stream, 'close', {
        configurable: true,
        writable: true,
        value: function (...args: unknown[]): unknown {
          let parts: unknown;
          try {
            parts = (close as (...a: unknown[]) => unknown).apply(stream, args);
          } catch (error) {
            return failed(error);
          }
          read(parts);
          if (scope.obs.outcome === undefined) scope.obs.setOutcome(VALIDATION_VALID);
          scope.finish();
          return parts;
        },
      });
      Object.defineProperty(stream, STREAM_MARKER, { value: true });
    } catch {
      return false; // a frozen stream cannot be patched
    }
    // A stream that is never closed still ends its span, when it is collected. The scope reaches
    // neither the stream nor the processor.
    abandonedScopes?.register(stream, scope);
    return true;
  }
}

/** The `@a2ui/agent` instrumentor `instrument()` starts, and the one `instrumentA2uiAgent()` patches a handed-over module with. */
export function a2uiAgentInstrumentor(): A2uiAgentInstrumentor {
  return stateSlot('a2ui.agent.instrumentor', () => new A2uiAgentInstrumentor());
}
