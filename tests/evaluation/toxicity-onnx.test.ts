/**
 * GENAI_TOXICITY_ONNX_MODEL (contract/SDK_ADDITIONS.md section 12): toxicity
 * scored in-process by the optional add-on @traceverse/genai-otel-instrument-onnx.
 * The core never depends on ONNX Runtime: the add-on is imported only when the
 * variable is set. Here the add-on is a stand-in; onnx/tests run the real one
 * through this same path.
 */
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setToxicityScorer } from '../../src/evaluation';
import { setOnnxAddonLoader } from '../../src/evaluation/onnx-addon';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { setLogger } from '../../src/logger';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let harness: Harness | undefined;
let llm: MockLlm;
const saved = { onnx: process.env.GENAI_TOXICITY_ONNX_MODEL, url: process.env.GENAI_TOXICITY_JUDGE_URL };

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  setToxicityScorer(undefined);
  setOnnxAddonLoader(undefined);
  setLogger(undefined);
  await harness?.stop();
  harness = undefined;
  clearBaseUrlClaims();
  for (const [key, name] of [
    ['onnx', 'GENAI_TOXICITY_ONNX_MODEL'],
    ['url', 'GENAI_TOXICITY_JUDGE_URL'],
  ] as const) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
});

const reply = {
  id: 'c1',
  object: 'chat.completion',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Please be polite.' } }],
  usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
};
const ask = (content: string): Promise<unknown> =>
  new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 }).chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content }] });
const toxicityKeys = (attributes: Record<string, unknown>): string[] => Object.keys(attributes).filter((key) => key.startsWith('evaluation.toxicity'));

function quietLogger(): { warn: ReturnType<typeof vi.fn> } {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  setLogger(log);
  return log;
}

describe('GENAI_TOXICITY_ONNX_MODEL', () => {
  it('loads the add-on once, with the model directory, and scores through it', async () => {
    const directories: string[] = [];
    const loader = vi.fn(async () => ({
      createOnnxToxicityJudge: async (directory: string) => {
        directories.push(directory);
        return async (text: string) => ({ toxicity: text.includes('idiot') ? 0.92 : 0.01 });
      },
    }));
    setOnnxAddonLoader(loader);
    process.env.GENAI_TOXICITY_ONNX_MODEL = '/models/detoxify-original-onnx';
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true, airGapped: true });
    llm.reply({ json: reply });
    await ask('You are an idiot.');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(harness.span('openai.chat.completion').attributes).toMatchObject({ 'evaluation.toxicity.prompt.detected': true, 'evaluation.toxicity.prompt.max_score': 0.92 });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(2), 5000);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(directories).toEqual(['/models/detoxify-original-onnx']);
  });

  it('the add-on not installed: one warning naming it, and toxicity is not measured', async () => {
    setOnnxAddonLoader(async () => {
      throw Object.assign(new Error("Cannot find package '@traceverse/genai-otel-instrument-onnx'"), { code: 'ERR_MODULE_NOT_FOUND' });
    });
    process.env.GENAI_TOXICITY_ONNX_MODEL = '/models/detoxify-original-onnx';
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    const log = quietLogger();
    for (let i = 0; i < 2; i += 1) {
      llm.reply({ json: reply });
      await ask('You are an idiot.');
    }
    await eventually(() => expect(harness?.spans()).toHaveLength(2), 5000);
    for (const span of harness.spans()) expect(toxicityKeys(span.attributes)).toEqual([]);
    const warnings = log.warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('@traceverse/genai-otel-instrument-onnx'));
    expect(warnings).toHaveLength(1);
  });

  it('a scorer given in code wins over the model', async () => {
    const loader = vi.fn(async () => ({ createOnnxToxicityJudge: async () => async () => ({ toxicity: 0.99 }) }));
    setOnnxAddonLoader(loader);
    process.env.GENAI_TOXICITY_ONNX_MODEL = '/models/detoxify-original-onnx';
    setToxicityScorer(() => ({ toxicity: 0.8 }));
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true });
    llm.reply({ json: reply });
    await ask('hello');
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 5000);
    expect(harness.span('openai.chat.completion').attributes['evaluation.toxicity.prompt.max_score']).toBe(0.8);
    expect(loader).not.toHaveBeenCalled();
  });
});
