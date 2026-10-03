/**
 * The whole path, with nothing stood in: GENAI_TOXICITY_ONNX_MODEL set, the
 * core SDK instrumenting a real OpenAI client against the mock provider, the
 * core loading this add-on, and the toy model run by the real ONNX Runtime.
 * The add-on is loaded from source here (it is not installed in the core's
 * node_modules); setOnnxAddonLoader is the only seam.
 */
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setOnnxAddonLoader } from '../../src/evaluation/onnx-addon';
import { eventually, startHarness, type Harness } from '../../tests/helpers/harness';
import { startMockLlm, type MockLlm } from '../../tests/helpers/mock-llm';

let llm: MockLlm;
let harness: Harness | undefined;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await harness?.stop();
  setOnnxAddonLoader(undefined);
  delete process.env.GENAI_TOXICITY_ONNX_MODEL;
  await llm.close();
});

describe('GENAI_TOXICITY_ONNX_MODEL through the core SDK', () => {
  it('a toxic prompt is detected by the model; a polite answer is not', async () => {
    setOnnxAddonLoader(() => import('../src'));
    process.env.GENAI_TOXICITY_ONNX_MODEL = resolve(__dirname, 'fixtures/toy-model');
    harness = await startHarness({ enabledInstrumentors: ['openai'], enableToxicityDetection: true, airGapped: true });
    llm.reply({
      json: {
        id: 'c1',
        object: 'chat.completion',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Thank you for the lovely afternoon.' } }],
        usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
      },
    });
    const client = new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'You are a worthless idiot.' }] });
    await eventually(() => expect(harness?.spans()).toHaveLength(1), 20000);
    const attributes = harness.span('openai.chat.completion').attributes;
    expect(attributes['evaluation.toxicity.prompt.detected']).toBe(true);
    expect(attributes['evaluation.toxicity.prompt.max_score']).toBeCloseTo(1 / (1 + Math.exp(-4)), 5);
    expect(attributes['evaluation.toxicity.response.detected']).toBe(false);
  });
});
