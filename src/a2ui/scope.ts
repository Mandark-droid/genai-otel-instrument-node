/**
 * One A2UI span, what it saw, and how it ends. Shared by the `@a2ui/agent` wrappers and the
 * `@a2ui/web_core` adapter (Python's `_Scope`).
 */
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { errorTypeName } from '../instrumentors/base';
import { logger } from '../logger';
import { A2UIAttributes } from './attributes';
import { A2uiObservation, applyToSpan, type PutContent } from './extract';
import { contentWriter, type A2uiSettings } from './settings';

/** Cancelling is not a failed parse. */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export class A2uiScope {
  readonly obs: A2uiObservation;
  error: unknown;
  private finished = false;
  private readonly put: PutContent;
  private readonly capture: boolean;

  constructor(
    readonly span: Span,
    settings: () => A2uiSettings,
  ) {
    this.capture = settings().enableContentCapture;
    this.obs = new A2uiObservation(this.capture);
    this.put = contentWriter(settings);
  }

  fail(error: unknown): void {
    if (this.error === undefined && !isAbort(error)) this.error = error ?? new Error('failed');
  }

  get done(): boolean {
    return this.finished;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      applyToSpan(this.span, this.obs, this.put);
      if (this.error !== undefined) {
        const type = errorTypeName(this.error);
        this.span.setAttribute(A2UIAttributes.ERROR_TYPE, type);
        if (this.capture) {
          // A validation error can quote the model's output or user data, so the text is kept only
          // with content capture on.
          const message = this.error instanceof Error ? this.error.message : String(this.error);
          this.span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 200) });
          if (this.error instanceof Error) this.span.recordException(this.error);
        } else {
          this.span.setStatus({ code: SpanStatusCode.ERROR, message: type });
          this.span.addEvent('exception', { 'exception.type': type });
        }
      }
    } catch (error) {
      logger.debug(`Could not finish an A2UI span: ${String(error)}`);
    } finally {
      try {
        this.span.end();
      } catch {
        // never let telemetry break the call
      }
    }
  }
}

/** Ends the span of a scope nobody finished, once whatever owned it has been collected. */
export const abandonedScopes: FinalizationRegistry<A2uiScope> | undefined =
  typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<A2uiScope>((scope) => scope.finish()) : undefined;
