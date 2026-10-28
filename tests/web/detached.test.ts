/** detached(): background calls stay out of a workflow running at the same time, and vice versa. */
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detached, traceWorkflow } from '../../src/app-spans';
import { PromiseScopeContextManager } from '../../src/web/promise-context';

const exporter = new InMemorySpanExporter();
const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer('t');
const manager = new PromiseScopeContextManager();

/** A model call: its span starts when it is called and ends when it settles. */
function call(name: string, ms: number): Promise<void> {
  const span = tracer.startSpan(name);
  return new Promise<void>((resolve) => setTimeout(resolve, ms)).then(() => span.end());
}
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  manager.enable();
  context.setGlobalContextManager(manager);
});
afterAll(() => {
  context.disable();
  trace.disable();
});

describe('detached', () => {
  it('a background call made while a workflow runs is its own trace; the workflow keeps its spans', async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const background = (async () => {
      await tick(2);
      await detached(() => call('background.embed', 20)); // open across the workflow's next call
    })();
    await traceWorkflow('workflow', {}, async () => {
      await tick(5);
      await call('workflow.step', 5);
    });
    await background;
    const spans = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s]));
    const root = spans['workflow']!;
    expect(spans['background.embed']!.parentSpanContext).toBeUndefined();
    expect(spans['workflow.step']!.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it('returns what fn returns and can name a parent', async () => {
    const parent = tracer.startSpan('parent');
    const value = detached(() => {
      tracer.startSpan('child').end();
      return 42;
    }, trace.setSpan(context.active(), parent));
    parent.end();
    expect(value).toBe(42);
    const child = exporter.getFinishedSpans().find((s) => s.name === 'child')!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});
