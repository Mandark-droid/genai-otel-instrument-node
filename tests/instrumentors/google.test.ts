/**
 * Google GenAI (`@google/genai`) against the mock provider, and Vertex AI
 * (`@google-cloud/vertexai`), whose client cannot be pointed at a mock without
 * Google credentials and is therefore driven through its patched method.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { GoogleGenAI } from '@google/genai';
import { GenerativeModel } from '@google-cloud/vertexai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const calculator = getDefaultCostCalculator();

let llm: MockLlm;
let harness: Harness;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
    llm.requests.length = 0;
    vi.restoreAllMocks();
  }
});

describe('Google GenAI instrumentor', () => {
  const client = (): GoogleGenAI => new GoogleGenAI({ apiKey: 'google-test-not-a-real-key', httpOptions: { baseUrl: llm.url } });

  it('generateContent: request config, usage metadata, finish reason, safety ratings, cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['google.generativeai'] });
    llm.reply({ fixture: 'google/generate-content.json' });
    const response = await client().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'What is the capital of France?',
      config: { temperature: 0.1, topP: 0.9, maxOutputTokens: 64 },
    });
    expect(response.text).toBe('The capital of France is Paris.');
    const span = harness.span('google.genai.models.generate_content');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'google',
      'gen_ai.provider.name': 'google',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gemini-2.5-flash',
      'gen_ai.request.temperature': 0.1,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.request.max_tokens': 64,
      'gen_ai.usage.input_tokens': 8,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.total_tokens': 15,
      'gen_ai.usage.cost.total': calculator.calculateCost('gemini-2.5-flash', { prompt_tokens: 8, completion_tokens: 7 }, 'chat'),
      'gen_ai.response.finish_reasons': ['STOP'],
      'gen_ai.response.model': 'gemini-2.5-flash',
      'gen_ai.safety.HARM_CATEGORY_HARASSMENT': 'NEGLIGIBLE',
      'gen_ai.safety.HARM_CATEGORY_DANGEROUS_CONTENT': 'LOW',
    });
  });

  it('generateContentStream: time to first token; usage from the last chunk', async () => {
    harness = await startHarness({ enabledInstrumentors: ['google.generativeai'] });
    llm.reply({ fixture: 'google/generate-content.stream.sse' });
    const stream = await client().models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'Capital of France?' });
    let text = '';
    for await (const chunk of stream) text += chunk.text ?? '';
    expect(text).toBe('Paris.');
    const span = harness.span('google.genai.models.generate_content');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(8);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(2);
    expect(span.attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });

  it('embedContent: input count, vector count and size; no usage is reported, so no tokens and no cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['google.generativeai'] });
    llm.reply({ fixture: 'google/embed-content.json' });
    await client().models.embedContent({ model: 'gemini-embedding-001', contents: ['alpha', 'beta'] });
    const attributes = harness.span('google.genai.models.embeddings').attributes;
    expect(attributes).toMatchObject({
      'gen_ai.system': 'google',
      'gen_ai.request.model': 'gemini-embedding-001',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 2,
      'gen_ai.response.embedding_count': 2,
      'gen_ai.response.vector_size': 3,
    });
    expect(Object.keys(attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['google.generativeai'] });
    llm.reply({ fixture: 'google/error.400.json', status: 400 });
    await expect(client().models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi' })).rejects.toThrow();
    const span = harness.span('google.genai.models.generate_content');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });
});

describe('Vertex AI instrumentor', () => {
  const model = (): GenerativeModel =>
    new GenerativeModel({
      model: 'gemini-2.5-flash',
      project: 'test-project',
      location: 'us-central1',
      // Never used: fetchToken is stubbed below. No Google credential is read.
      googleAuth: {} as never,
    });

  it('generateContent on the real class is traced: model from the instance, usage from the response', async () => {
    harness = await startHarness({ enabledInstrumentors: ['vertexai'] });
    const instance = model();
    vi.spyOn(instance as unknown as { fetchToken: () => Promise<string> }, 'fetchToken').mockResolvedValue('test-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Paris.' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await instance.generateContent('Capital of France?');
    expect(result.response.candidates?.[0]?.content.parts[0]?.text).toBe('Paris.');
    expect(harness.span('vertexai.generate_content').attributes).toMatchObject({
      'gen_ai.system': 'vertexai',
      'gen_ai.request.model': 'gemini-2.5-flash',
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.usage.input_tokens': 8,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.total_tokens': 10,
      'gen_ai.usage.cost.total': calculator.calculateCost('gemini-2.5-flash', { prompt_tokens: 8, completion_tokens: 2 }, 'chat'),
    });
  });

  it('a failed call ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['vertexai'] });
    const instance = model();
    vi.spyOn(instance as unknown as { fetchToken: () => Promise<string> }, 'fetchToken').mockRejectedValue(new Error('no credentials'));
    await expect(instance.generateContent('hi')).rejects.toThrow('no credentials');
    expect(harness.span('vertexai.generate_content').status.code).toBe(SpanStatusCode.ERROR);
  });
});
