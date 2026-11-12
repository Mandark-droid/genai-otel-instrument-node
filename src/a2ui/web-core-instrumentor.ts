/**
 * Renderer adapter for `@a2ui/web_core` 0.15 (decision A2UI-D7; opt-in). `@a2ui/react`, `@a2ui/lit`
 * and `@a2ui/angular` share its `MessageProcessor`, so one adapter covers the official web
 * renderers.
 *
 * What it records
 * ---------------
 * One `a2ui.apply` span per batch of agent messages applied (`processMessages`,
 * `processMessagesWithErrors`, `processMessagesAsync`), whose duration is the time until the batch was
 * processed. The span is ERROR when the renderer rejected the batch: the processor threw, or reported
 * errors, with `error.type` set to the class of the first error.
 *
 * Each renderer-side error is also an `a2ui.error` event with its code and surface, and is counted in
 * `a2ui.error.codes` / `a2ui.error.count`, **even when the application never sends the `error`
 * message back to the agent**: errors are read where the processor makes them
 * (`MessageProcessor.handleProcessingError`), so `reportErrorsOnly: true` and
 * `processMessagesWithErrors` are covered as well as a thrown error.
 *
 * Opt-in: name `a2ui_web_core` in `GENAI_ENABLED_INSTRUMENTORS`, or hand the module over with
 * `instrumentA2uiWebCore(module)` (browsers and React Native cannot look a package up by name).
 */
import { context, trace, type Span, type Tracer } from '@opentelemetry/api';
import { PatchingInstrumentor, type PatchTarget } from '../instrumentors/patching';
import { exportedClass } from '../instrumentors/wrap';
import type { UsageDict } from '../instrumentors/base';
import { activatesCallSpans } from '../call-scope';
import { logger } from '../logger';
import { stateSlot } from '../state';
import { VERSION } from '../version';
import { SIDE_AGENT, SIDE_RENDERER, SPAN_APPLY, VALIDATION_INVALID, VALIDATION_VALID } from './attributes';
import { unwrapMessageList } from './extract';
import { A2uiScope } from './scope';
import { settingsOf, type A2uiSettings } from './settings';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export const A2UI_WEB_CORE_PACKAGE = '@a2ui/web_core';
const INSTRUMENTATION_SCOPE = 'genai_otel.a2ui';

/** The batches in flight on each processor, innermost last. */
const inFlight = new WeakMap<object, { scope: A2uiScope; firstError: unknown }[]>();

export class A2uiWebCoreInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'A2UI web_core';
  protected readonly packages = [A2UI_WEB_CORE_PACKAGE];
  protected override get owner(): string {
    return 'a2ui.web_core';
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

  private active(): boolean {
    return this.instrumented && this.settings().a2uiEnabled;
  }

  protected targets(module: unknown): PatchTarget[] {
    const processor: unknown = exportedClass(module, 'MessageProcessor');
    if (typeof processor !== 'function') return [];
    const holder = (processor as { prototype: object }).prototype;
    return [
      { holder, method: 'handleProcessingError', wrap: (original) => this.errorWrapper(original) },
      { holder, method: 'processMessages', wrap: (original) => this.applyWrapper(original, 'sync') },
      { holder, method: 'processMessagesWithErrors', wrap: (original) => this.applyWrapper(original, 'errors') },
      { holder, method: 'processMessagesAsync', wrap: (original) => this.applyWrapper(original, 'async') },
    ];
  }

  /** `handleProcessingError(err, context)` returns the outbound error message; it is where every error is made. */
  private errorWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return function (this: unknown, ...args: unknown[]): unknown {
      const result = (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      if (!instrumentor.active() || !isMapping(this)) return result;
      try {
        const batches = inFlight.get(this);
        const entry = batches?.[batches.length - 1];
        if (entry && isMapping(result)) {
          // The mapped error message is a renderer-to-agent message: `{ version, error: { code, ... } }`.
          entry.scope.obs.addMessage(result, SIDE_RENDERER);
          entry.firstError ??= args[0] ?? new Error('rejected');
        }
      } catch (error) {
        logger.debug(`Could not record an A2UI renderer error: ${String(error)}`);
      }
      return result;
    } as unknown as AnyFunction;
  }

  private applyWrapper(original: AnyFunction, mode: 'sync' | 'errors' | 'async'): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return function (this: unknown, ...args: unknown[]): unknown {
      const call = (): unknown => (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      if (!instrumentor.active() || !isMapping(this)) return call();
      let span: Span;
      try {
        span = instrumentor.tracer.startSpan(SPAN_APPLY);
      } catch (error) {
        logger.debug(`a2ui.apply span not started: ${String(error)}`);
        return call();
      }
      const scope = new A2uiScope(span, () => instrumentor.settings());
      const entry = { scope, firstError: undefined as unknown };
      try {
        // The batch is the agent's: what the renderer was sent to apply.
        const payload = unwrapMessageList(args[0]);
        scope.obs.addPayload(payload, SIDE_AGENT);
      } catch (error) {
        logger.debug(`Could not read an A2UI batch: ${String(error)}`);
      }
      const stack = inFlight.get(this) ?? [];
      stack.push(entry);
      inFlight.set(this, stack);
      const leave = (): void => {
        const at = stack.lastIndexOf(entry);
        if (at >= 0) stack.splice(at, 1);
      };
      const rejected = (): boolean => scope.obs.errors.length > 0;
      const finishBatch = (thrown?: unknown): void => {
        leave();
        // The renderer rejected the batch when it threw or reported an error.
        if (thrown !== undefined || rejected()) {
          scope.obs.setOutcome(VALIDATION_INVALID);
          scope.fail(thrown ?? entry.firstError ?? new Error('rejected'));
        } else {
          scope.obs.setOutcome(VALIDATION_VALID);
        }
        scope.finish();
      };
      const run = (): unknown => (activatesCallSpans() ? context.with(trace.setSpan(context.active(), span), call) : call());
      let result: unknown;
      try {
        result = run();
      } catch (error) {
        finishBatch(error);
        throw error;
      }
      if (mode === 'async' && result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).then(
          (value) => {
            finishBatch();
            return value;
          },
          (error: unknown) => {
            finishBatch(error);
            throw error;
          },
        );
      }
      finishBatch();
      return result;
    } as unknown as AnyFunction;
  }
}

/** The `@a2ui/web_core` instrumentor, started by name (`a2ui_web_core`) or patched by `instrumentA2uiWebCore()`. */
export function a2uiWebCoreInstrumentor(): A2uiWebCoreInstrumentor {
  return stateSlot('a2ui.web_core.instrumentor', () => new A2uiWebCoreInstrumentor());
}

