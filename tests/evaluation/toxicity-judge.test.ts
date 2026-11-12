/**
 * GENAI_TOXICITY_JUDGE_URL (contract/SDK_ADDITIONS.md section 12): an on-prem
 * HTTP toxicity judge, the same protocol in every SDK. It is posted
 * `{"text", "categories"}` and answers `{"scores": {...}}`, or the scores as a
 * flat object as a Detoxify server does (`obscene` read as `profanity`).
 *
 * The call is this SDK's own: never traced, even with the HTTP instrumentation
 * on. An operator-configured judge stays allowed when air-gapped: air-gapped
 * forbids downloading models and assets at run time, not the operator's endpoint.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setToxicityScorer } from '../../src/evaluation';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let harness: Harness | undefined;
let llm: MockLlm;
let judge: { url: string; requests: unknown[]; answer: (status: number, body: unknown) => void; close: () => Promise<void> } | undefined;
const previous = process.env.GENAI_TOXICITY_JUDGE_URL;

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
  await judge?.close();
  judge = undefined;
  clearBaseUrlClaims();
  if (previous === undefined) delete process.env.GENAI_TOXICITY_JUDGE_URL;
  else process.env.GENAI_TOXICITY_JUDGE_URL = previous;
});

async function startJudge(status: number, body: unknown): Promise<NonNullable<typeof judge>> {
  const requests: unknown[] = [];
  let answer = { status, body };
  const server: Server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString()));
    request.on('end', () => {
      requests.push({ method: request.method, contentType: request.headers['content-type'], body: JSON.parse(text || 'null') });
      const parsed = JSON.parse(text || '{}') as { text?: string };
      const reply = typeof answer.body === 'function' ? (answer.body as (t: string) => unknown)(parsed.text ?? '') : answer.body;
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`,
    requests,
    answer: (nextStatus, nextBody) => {
      answer = { status: nextStatus, body: nextBody };
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

const reply = {
  id: 'c1',
  object: 'chat.completion',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Please be polite.' } }],
  usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
};
const client = (): OpenAI => new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
const ask = (content: string): Promise<unknown> => client().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content }] });

/** A Detoxify server: a flat object, `obscene` for profanity. */
const detoxify = (text: string): Record<string, number> => ({
  toxicity: text.includes('idiot') ? 0.91 : 0.02,
  severe_toxicity: 0.01,
  obscene: text.includes('idiot') ? 0.8 : 0.01,
  threat: 0.0,
  insult: text.includes('idiot') ? 0.88 : 0.01,
  identity_attack: 0.0,
});

describe('GENAI_TOXICITY_JUDGE_URL', () => {
  it('scores prompt and response through the judge; Detoxify answers are read, obscene as profanity; the judge call is not traced', async () => {
    judge = await startJudge(200, detoxify);
    process.env.GENAI_TOXICITY_JUDGE_URL = judge.url;
    // HTTP instrumentation on: the judge's own request must still not become a span.
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableMcpInstrumentation: true, enableHttpInstrumentation: true, enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('You are an idiot.');
    await eventually(() => expect(harness?.spans().filter((span) => span.name === 'openai.chat.completion')).toHaveLength(1), 5000);
    const span = harness.span('openai.chat.completion');
    expect(span.attributes).toMatchObject({
      'evaluation.toxicity.prompt.detected': true,
      'evaluation.toxicity.prompt.max_score': 0.91,
      'evaluation.toxicity.response.detected': false,
    });
    expect(String(span.attributes['evaluation.toxicity.prompt.categories'])).toContain('profanity');
    expect(judge.requests[0]).toEqual({
      method: 'POST',
      contentType: 'application/json',
      body: { text: 'You are an idiot.', categories: ['identity_attack', 'insult', 'profanity', 'severe_toxicity', 'threat', 'toxicity'] },
    });
    // The model call's own HTTP request is traced; the judge's is not.
    expect(harness.spans().some((s) => s.name.startsWith('api.call'))).toBe(true);
    expect(harness.spans().some((s) => String(s.attributes['url.full'] ?? '').includes('/score'))).toBe(false);
  });

  it('{"scores": {...}} is read too', async () => {
    judge = await startJudge(200, { scores: { toxicity: 0.95, insult: 0.4 } });
    process.env.GENAI_TOXICITY_JUDGE_URL = judge.url;
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(harness.span('openai.chat.completion').attributes['evaluation.toxicity.prompt.max_score']).toBe(0.95);
  });

  it('a judge that fails, or answers with no score, measured nothing: no toxicity attribute, never a 0', async () => {
    judge = await startJudge(503, { error: 'busy' });
    process.env.GENAI_TOXICITY_JUDGE_URL = judge.url;
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(Object.keys(harness.span('openai.chat.completion').attributes).filter((key) => key.startsWith('evaluation.toxicity'))).toEqual([]);

    await harness.stop();
    judge.answer(200, { verdict: 'fine' });
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(Object.keys(harness.span('openai.chat.completion').attributes).filter((key) => key.startsWith('evaluation.toxicity'))).toEqual([]);
  });

  it('nothing measured nothing: no evaluation.completed either (section 12)', async () => {
    judge = await startJudge(503, { error: 'busy' });
    process.env.GENAI_TOXICITY_JUDGE_URL = judge.url;
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(Object.keys(harness.span('openai.chat.completion').attributes).filter((key) => key.startsWith('evaluation.'))).toEqual([]);
  });

  it('a scorer given in code wins over the URL', async () => {
    judge = await startJudge(200, detoxify);
    process.env.GENAI_TOXICITY_JUDGE_URL = judge.url;
    setToxicityScorer(() => ({ toxicity: 0.75 }));
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('You are an idiot.');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(harness.span('openai.chat.completion').attributes['evaluation.toxicity.prompt.max_score']).toBe(0.75);
    expect(judge.requests).toEqual([]);
  });

  it('air-gapped: the operator-configured judge stays allowed', async () => {
    judge = await startJudge(200, detoxify);
    process.env.GENAI_TOXICITY_JUDGE_URL = judge.url;
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true, airGapped: true, allowExternalEgress: false });
    llm.reply({ json: reply });
    await ask('You are an idiot.');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(harness.span('openai.chat.completion').attributes['evaluation.toxicity.prompt.detected']).toBe(true);
  });

  it('a URL that is not http(s) is refused: toxicity is not measured', async () => {
    process.env.GENAI_TOXICITY_JUDGE_URL = 'file:///etc/passwd';
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(Object.keys(harness.span('openai.chat.completion').attributes).filter((key) => key.startsWith('evaluation.toxicity'))).toEqual([]);
  });
});
