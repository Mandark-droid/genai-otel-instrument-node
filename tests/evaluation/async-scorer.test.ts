/**
 * A toxicity scorer that answers asynchronously - a local model, or an
 * on-prem endpoint. On an instrumented call the span is held open until the
 * scorer answers (bounded), and ends with the time the call really ended.
 */
import { SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flushTelemetry } from '../../src/auto-instrument';
import { setToxicityScorer } from '../../src/evaluation';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let harness: Harness | undefined;
let llm: MockLlm;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  setToxicityScorer(undefined);
  await harness?.stop();
  harness = undefined;
  clearBaseUrlClaims();
});

const reply = {
  id: 'c1',
  object: 'chat.completion',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Please be polite.' } }],
  usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
};
const client = (): OpenAI => new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const durationMs = (span: { duration: [number, number] }): number => span.duration[0] * 1000 + span.duration[1] / 1e6;

describe('asynchronous toxicity scorer', () => {
  it('an instrumented call: the scores are on the span, and the span ends when the call did, not when the scorer answered', async () => {
    const seen: string[] = [];
    setToxicityScorer(async (text) => {
      seen.push(text);
      await sleep(400);
      return { toxicity: text.includes('idiot') ? 0.91 : 0.03 };
    });
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await client().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'You are an idiot.' }] });

    // The call has returned; the span is waiting for the scorer.
    expect(harness.spans()).toEqual([]);
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    const span = harness.span('openai.chat.completion');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'evaluation.toxicity.prompt.detected': true,
      'evaluation.toxicity.prompt.max_score': 0.91,
      'evaluation.toxicity.response.detected': false,
    });
    // Prompt and response were each scored once.
    expect(seen).toEqual(['You are an idiot.', 'Please be polite.']);
    expect(durationMs(span)).toBeLessThan(350);
  });

  it('flushTelemetry waits for spans still being scored', async () => {
    setToxicityScorer(async () => {
      await sleep(300);
      return { toxicity: 0.5 };
    });
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await client().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] });
    expect(harness.spans()).toEqual([]);
    await flushTelemetry(5);
    expect(harness.spans()).toHaveLength(1);
  });

  it('a scorer that rejects, or never answers, does not hold the span: no toxicity attribute', async () => {
    let calls = 0;
    setToxicityScorer(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('endpoint down')) : new Promise(() => {});
      },
      { timeoutSeconds: 0.3 },
    );
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await client().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] });
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    const span = harness.span('openai.chat.completion');
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('evaluation.toxicity'))).toEqual([]);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('a span of other instrumentation cannot wait: with an asynchronous scorer nothing is written for it', async () => {
    setToxicityScorer(async () => ({ toxicity: 0.99 }));
    harness = await startHarness({ enabledInstrumentors: [], enableToxicityDetection: true });
    const span = trace.getTracer('other').startSpan('llm.call', { attributes: { 'gen_ai.prompt': 'You are an idiot.' } });
    span.end();
    expect(Object.keys(harness.span('llm.call').attributes).filter((key) => key.startsWith('evaluation.toxicity'))).toEqual([]);
  });

  it('a failed call is not held open for scoring', async () => {
    setToxicityScorer(async () => {
      await sleep(2000);
      return { toxicity: 0.5 };
    });
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ status: 500, json: { error: { message: 'boom' } } });
    await expect(client().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow();
    expect(harness.span('openai.chat.completion').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('evaluation without exporting content (SDK_ADDITIONS.md section 12)', () => {
  it('content capture off: a streamed answer is assembled in-process for the detectors, and never written to the span', async () => {
    const seen: string[] = [];
    setToxicityScorer((text) => {
      seen.push(text);
      return { toxicity: 0.01 };
    });
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true, enableContentCapture: false });
    llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
    const stream = await client().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Capital of France?' }], stream: true });
    for await (const chunk of stream) void chunk;
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(seen).toEqual(['Capital of France?', 'Paris.']);
    const span = harness.span('openai.chat.completion');
    expect(span.attributes['evaluation.toxicity.response.detected']).toBe(false);
    expect(JSON.stringify([span.attributes, span.events])).not.toContain('Paris');
  });
});
