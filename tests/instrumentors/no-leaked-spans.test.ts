/**
 * A span must end even when the caller never consumes what the SDK returned:
 * a stream that is never iterated, a promise that is never awaited. Those are
 * closed when the object is garbage collected, so these tests force a
 * collection (vitest runs the workers with --expose-gc).
 */
import { SpanStatusCode } from '@opentelemetry/api';
import OpenAI from 'openai';
import { loadConfig, type OTelConfig } from '../../src/config';
import { BaseInstrumentor, type UsageDict } from '../../src/instrumentors/base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STREAM_CANCELLED } from '../../src/instrumentors/base';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const collect = (globalThis as { gc?: () => void }).gc;

async function untilCollected(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    collect?.();
    await new Promise((done) => setTimeout(done, 25));
    if (check()) return true;
  }
  return check();
}

/** A minimal instrumentor, to drive the span wrapper with a stream this test controls. */
class PlainInstrumentor extends BaseInstrumentor {
  instrument(config: OTelConfig): void {
    this.setupConfig(config);
    this.instrumented = true;
  }
  uninstrument(): void {
    this.instrumented = false;
  }
  protected override extractUsage(): UsageDict | null {
    return null;
  }
  wrap<F extends (...args: never[]) => unknown>(name: string, original: F): F {
    return this.createSpanWrapper(name)(original);
  }
}

describe.skipIf(!collect)('spans of results nobody consumed', () => {
  let llm: MockLlm;
  let harness: Harness;
  let client: OpenAI;

  beforeAll(async () => {
    llm = await startMockLlm();
  });
  afterAll(async () => {
    await llm.close();
  });
  beforeEach(async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'] });
    client = new OpenAI({ apiKey: 'sk-test', baseURL: `${llm.url}/v1`, maxRetries: 0 });
  });
  afterEach(async () => {
    try {
      expect(harness.openSpans()).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it('a stream that is never iterated', async () => {
    llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
    // The stream is created and dropped inside this function, so nothing holds it afterwards.
    await (async () => {
      const stream = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(typeof stream.controller.abort).toBe('function');
    })();
    expect(harness.openSpans()).toEqual(['openai.chat.completion']);

    expect(await untilCollected(() => harness.spans().length === 1)).toBe(true);
    const span = harness.span('openai.chat.completion');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('stream cancelled before completion');
    expect(span.attributes['gen_ai.streaming.token_count']).toBe(0);
    expect('gen_ai.server.ttft' in span.attributes).toBe(false);
    expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes.error_type).toBe(STREAM_CANCELLED);
  });

  it('a promise collected while its stream is still being read does not end the span early', async () => {
    llm.reply({ fixture: 'openai/chat.completion.stream.sse', eventDelayMs: 20 });
    // The promise is a temporary: once awaited, only the stream is still referenced.
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    // Give the collector every chance to finalize the promise before and during the read.
    for (let i = 0; i < 5; i += 1) {
      collect?.();
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(harness.spans()).toHaveLength(0);
    let chunks = 0;
    for await (const _chunk of stream) {
      chunks += 1;
      collect?.();
      await new Promise((done) => setTimeout(done, 1));
    }
    expect(chunks).toBe(6);
    const span = harness.span('openai.chat.completion');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(22);
    expect(span.attributes['gen_ai.streaming.token_count']).toBe(6);
    expect(span.attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });

  it('a stream whose only remaining reference is its iterator is not cancelled under the reader', async () => {
    llm.reply({ fixture: 'openai/chat.completion.stream.sse', eventDelayMs: 20 });
    // Neither the promise nor the stream object is referenced after this line.
    const iterator = (
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      })
    )[Symbol.asyncIterator]();

    let chunks = 0;
    for (;;) {
      for (let i = 0; i < 3; i += 1) {
        collect?.();
        await new Promise((done) => setTimeout(done, 2));
      }
      const step = await iterator.next();
      if (step.done) break;
      chunks += 1;
    }
    expect(chunks).toBe(6);
    const span = harness.span('openai.chat.completion');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.streaming.token_count']).toBe(6);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(22);
  });

  it('a stream object that nothing but the instrumentation could keep alive is not cancelled under its reader', async () => {
    // An iterable whose iterator does not refer back to it: once the reader holds
    // only the iterator, the stream object itself is garbage - unless the measuring
    // iterator keeps it, which it must, or the finalizer would end the span mid-read.
    function makeStream(): AsyncIterable<number> {
      async function* events(): AsyncGenerator<number> {
        for (let i = 0; i < 5; i += 1) {
          await new Promise((done) => setTimeout(done, 15));
          yield i;
        }
      }
      const iterator = events();
      return { [Symbol.asyncIterator]: () => iterator };
    }
    const instrumentor = new PlainInstrumentor();
    instrumentor.instrument(loadConfig({}, {}));
    const wrapped = instrumentor.wrap('test.stream.gc', async (_params: { stream: boolean }) => makeStream());
    const iterator = (await wrapped({ stream: true }))[Symbol.asyncIterator]();

    let seen = 0;
    for (;;) {
      for (let i = 0; i < 3; i += 1) {
        collect?.();
        await new Promise((done) => setTimeout(done, 2));
      }
      const step = await iterator.next();
      if (step.done) break;
      seen += 1;
    }
    expect(seen).toBe(5);
    const span = harness.span('test.stream.gc');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.streaming.token_count']).toBe(5);
  });

  it('a promise that is never awaited', async () => {
    llm.reply({ fixture: 'openai/chat.completion.json' });
    (() => {
      void client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    })();
    expect(harness.openSpans()).toEqual(['openai.chat.completion']);

    expect(await untilCollected(() => harness.spans().length === 1)).toBe(true);
    const span = harness.span('openai.chat.completion');
    // The request completed; its body was never read, so there is no usage to report.
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect('gen_ai.usage.total_tokens' in span.attributes).toBe(false);
    expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
  });

  it('a promise awaited only after the response had long arrived is still measured in full', async () => {
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const pending = client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise((done) => setTimeout(done, 150));
    expect(harness.spans()).toHaveLength(0);
    const completion = await pending;
    expect(completion.id).toBe('chatcmpl-fixture-0001');
    const span = harness.span('openai.chat.completion');
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(28);
    expect(span.attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });
});

it('the garbage collector is exposed to the test workers, so the tests above actually run', () => {
  expect(typeof collect).toBe('function');
});
