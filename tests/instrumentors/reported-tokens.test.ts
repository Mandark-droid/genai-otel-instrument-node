/**
 * Tokens the provider reports are read and priced, also where the reference
 * reads none (contract/SDK_ADDITIONS.md section 6): Gemini thinking and cached
 * tokens, Bedrock Converse cache tokens, Bedrock's token-count response
 * headers, the streamed Responses API's final event.
 */
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const calculator = getDefaultCostCalculator();
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
    clearBaseUrlClaims();
  }
});

const bedrock = (): BedrockRuntimeClient =>
  new BedrockRuntimeClient({
    region: 'us-east-1',
    endpoint: llm.url,
    requestHandler: new NodeHttpHandler(),
    credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret-not-a-real-key' },
    maxAttempts: 1,
  });

describe('Gemini', () => {
  it('thinking tokens are output tokens and reasoning tokens; cached tokens are cache reads; all priced', async () => {
    harness = await startHarness({ enabledInstrumentors: ['google.generativeai'] });
    llm.reply({
      json: {
        candidates: [{ content: { parts: [{ text: 'Paris.' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 7, thoughtsTokenCount: 12, cachedContentTokenCount: 8, totalTokenCount: 39 },
        modelVersion: 'gemini-2.5-flash',
      },
    });
    await new GoogleGenAI({ apiKey: 'google-test-not-a-real-key', httpOptions: { baseUrl: llm.url } }).models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Capital of France?',
    });
    const usage = { prompt_tokens: 20, completion_tokens: 19, total_tokens: 39, cache_read_input_tokens: 8, completion_tokens_details: { reasoning_tokens: 12 } };
    expect(harness.span('google.genai.models.generate_content').attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 19,
      'gen_ai.usage.total_tokens': 39,
      'gen_ai.usage.reasoning.output_tokens': 12,
      'gen_ai.usage.cache_read.input_tokens': 8,
      'gen_ai.usage.cost.total': calculator.calculateCost('gemini-2.5-flash', usage, 'chat'),
    });
  });
});

describe('Bedrock', () => {
  it('Converse: cache read and cache write tokens', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({
      json: {
        output: { message: { role: 'assistant', content: [{ text: 'Paris.' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 32, cacheReadInputTokens: 15, cacheWriteInputTokens: 5 },
      },
    });
    await bedrock().send(new ConverseCommand({ modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0', messages: [{ role: 'user', content: [{ text: 'Capital?' }] }] }));
    expect(harness.span('aws.bedrock.converse').attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.cache_read.input_tokens': 15,
      'gen_ai.usage.cache_write.input_tokens': 5,
    });
  });

  it('InvokeModel: a body with no counts is priced from the token-count response headers', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({
      json: { generation: 'Paris.', stop_reason: 'stop' },
      headers: { 'x-amzn-bedrock-input-token-count': '11', 'x-amzn-bedrock-output-token-count': '3', 'x-amzn-bedrock-invocation-latency': '120' },
    });
    const model = 'meta.llama3-8b-instruct-v1:0';
    const output = await bedrock().send(new InvokeModelCommand({ modelId: model, contentType: 'application/json', body: JSON.stringify({ prompt: 'Capital of France?' }) }));
    // What the caller gets is untouched.
    expect(JSON.parse(new TextDecoder().decode(output.body)).generation).toBe('Paris.');
    expect(harness.span('aws.bedrock.invoke_model').attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.cost.total': calculator.calculateCost(model, { prompt_tokens: 11, completion_tokens: 3 }, 'chat'),
    });
  });
});

describe('OpenAI Responses, streamed', () => {
  it('usage from the final response.completed event, and the cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'] });
    const events = [
      { type: 'response.created', sequence_number: 0, response: { id: 'resp_s1', object: 'response', status: 'in_progress', model: 'gpt-4o-mini', output: [] } },
      { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Par' },
      { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'is.' },
      {
        type: 'response.completed',
        sequence_number: 3,
        response: {
          id: 'resp_s1',
          object: 'response',
          status: 'completed',
          model: 'gpt-4o-mini',
          output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Paris.', annotations: [] }] }],
          usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        },
      },
    ];
    llm.reply({ raw: Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')), headers: { 'content-type': 'text/event-stream' } });
    const client = new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
    const stream = await client.responses.create({ model: 'gpt-4o-mini', input: 'Capital of France?', stream: true });
    let text = '';
    for await (const event of stream) if (event.type === 'response.output_text.delta') text += event.delta;
    expect(text).toBe('Paris.');
    expect(harness.span('openai.responses').attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 14,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.total_tokens': 17,
      'gen_ai.usage.cost.total': calculator.calculateCost('gpt-4o-mini', { prompt_tokens: 14, completion_tokens: 3 }, 'chat'),
    });
  });
});
