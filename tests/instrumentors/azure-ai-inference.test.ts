/**
 * Azure AI Inference (`@azure-rest/ai-inference`), against the mock provider.
 *
 * The JavaScript client is a REST client with no classes to patch: every
 * request goes through an Azure pipeline (`@azure/core-rest-pipeline`), and
 * that is where it is observed. Other Azure SDK traffic on the same pipeline
 * class is left alone.
 */
import ModelClient from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';
import { createDefaultHttpClient, createEmptyPipeline, createPipelineRequest } from '@azure/core-rest-pipeline';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let llm: MockLlm;
let harness: Harness | undefined;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  try {
    expect(harness?.openSpans()).toEqual([]);
  } finally {
    await harness?.stop();
    harness = undefined;
  }
});

const client = (): ReturnType<typeof ModelClient> => ModelClient(llm.url, new AzureKeyCredential('azure-test-not-a-real-key'), { retryOptions: { maxRetries: 0 }, allowInsecureConnection: true });

describe('Azure AI Inference', () => {
  it('chat: `azure.ai.inference.chat` under its own system, with tokens and cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['azure.ai.inference'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const response = await client()
      .path('/chat/completions')
      .post({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What is the capital of France?' }], max_tokens: 32 } });
    expect(response.status).toBe('200');
    // What the application reads is untouched.
    expect((response.body as { choices: { message: { content: string } }[] }).choices[0]?.message.content).toBe('The capital of France is Paris.');

    const span = harness.span('azure.ai.inference.chat');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'azure_ai_inference',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.request.max_tokens': 32,
      'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat'),
      'server.address': '127.0.0.1',
    });
    expect(JSON.stringify(span.attributes)).not.toContain('capital of France');
  });

  it('with content capture on, the prompt and the completion', async () => {
    harness = await startHarness({ enabledInstrumentors: ['azure.ai.inference'], enableContentCapture: true });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await client().path('/chat/completions').post({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What is the capital of France?' }] } });
    const span = harness.span('azure.ai.inference.chat');
    expect(span.attributes['gen_ai.response']).toBe('The capital of France is Paris.');
    expect(span.events.map((event) => event.name)).toContain('gen_ai.prompt.0');
  });

  it('embeddings: `azure.ai.inference.embeddings`, as in the reference', async () => {
    harness = await startHarness({ enabledInstrumentors: ['azure.ai.inference'] });
    llm.reply({ fixture: 'openai/embeddings.float.json' });
    await client().path('/embeddings').post({ body: { model: 'text-embedding-3-small', input: ['a', 'b'] } });
    expect(harness.span('azure.ai.inference.embeddings').attributes).toMatchObject({
      'gen_ai.system': 'azure_ai_inference',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 2,
      'gen_ai.response.embedding_count': 2,
      'gen_ai.usage.input_tokens': 8,
    });
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['azure.ai.inference'] });
    llm.reply({ status: 400, json: { error: { code: 'bad_request', message: 'no' } } });
    const response = await client().path('/chat/completions').post({ body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] } });
    expect(response.status).toBe('400');
    expect(harness.span('azure.ai.inference.chat').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('other Azure traffic on the same pipeline class gets no span', async () => {
    harness = await startHarness({ enabledInstrumentors: ['azure.ai.inference'] });
    llm.reply({ json: { ok: true } });
    const pipeline = createEmptyPipeline();
    await pipeline.sendRequest(createDefaultHttpClient(), createPipelineRequest({ url: `${llm.url}/some/blob`, method: 'GET', allowInsecureConnection: true }));
    expect(harness.spans()).toEqual([]);
  });
});
