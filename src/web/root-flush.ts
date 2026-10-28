/**
 * Sends a trace as soon as its root span ends. In a browser tab or a React Native app the batch
 * timer stops when the page or app goes to the background, so spans that ended there (a tool that
 * opened another app, a run that finished while the user switched away) waited until it came back.
 * Registered after the batch processor, so the span is already queued when the flush starts.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export class RootSpanFlushProcessor implements SpanProcessor {
  private pending = false;

  constructor(private readonly flush: () => Promise<void>) {}

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    const parent = span.parentSpanContext;
    if ((parent && !parent.isRemote) || this.pending) return;
    this.pending = true;
    // After the current call stack, so spans ending together go out in one request.
    void Promise.resolve()
      .then(() => this.flush())
      .catch(() => undefined)
      .finally(() => {
        this.pending = false;
      });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
