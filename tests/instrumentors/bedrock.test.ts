/**
 * AWS Bedrock (`@aws-sdk/client-bedrock-runtime`): the real client, static
 * placeholder credentials, pointed at the mock provider.
 */
import { crc32 } from 'node:zlib';
import {
  BedrockRuntime,
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  ConverseCommand,
  ConverseStreamCommand,
  CountTokensCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { SpanStatusCode } from '@opentelemetry/api';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const calculator = getDefaultCostCalculator();
const CLAUDE = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
const NOVA = 'amazon.nova-lite-v1:0';
const TITAN_EMBED = 'amazon.titan-embed-text-v2:0';
const MESSAGES = [{ role: 'user' as const, content: [{ text: 'What is the capital of France?' }] }];

/** One AWS event-stream frame: prelude, headers, payload, CRCs. */
function frame(eventType: string, payload: unknown): Buffer {
  const header = (name: string, value: string): Buffer => {
    const nameBytes = Buffer.from(name);
    const valueBytes = Buffer.from(value);
    const out = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    out.writeUInt8(nameBytes.length, 0);
    nameBytes.copy(out, 1);
    out.writeUInt8(7, 1 + nameBytes.length); // string
    out.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
    valueBytes.copy(out, 4 + nameBytes.length);
    return out;
  };
  const headers = Buffer.concat([
    header(':event-type', eventType),
    header(':content-type', 'application/json'),
    header(':message-type', 'event'),
  ]);
  const body = Buffer.from(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude), 0);
  const withoutCrc = Buffer.concat([prelude, preludeCrc, headers, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(withoutCrc), 0);
  return Buffer.concat([withoutCrc, messageCrc]);
}
const EVENT_STREAM = { 'content-type': 'application/vnd.amazon.eventstream' };
const chunk = (payload: unknown): Buffer => frame('chunk', { bytes: Buffer.from(JSON.stringify(payload)).toString('base64') });

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
  }
});

const config = (): BedrockRuntimeClientConfig => ({
  // The mock speaks HTTP/1.1; the client defaults to HTTP/2 for this service.
  requestHandler: new NodeHttpHandler(),
  region: 'us-east-1',
  endpoint: llm.url,
  credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret-not-a-real-key' },
  maxAttempts: 1,
});
const client = (): BedrockRuntimeClient => new BedrockRuntimeClient(config());

describe('Bedrock instrumentor', () => {
  it('Converse: request config, usage, stop reason, response text, tool calls, cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'], enableContentCapture: true });
    llm.reply({
      json: {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Checking the weather.' }, { toolUse: { toolUseId: 'tool-1', name: 'get_weather', input: { city: 'Paris' } } }],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
        metrics: { latencyMs: 412 },
      },
    });
    const output = await client().send(
      new ConverseCommand({
        modelId: CLAUDE,
        messages: MESSAGES,
        system: [{ text: 'You are terse.' }],
        inferenceConfig: { maxTokens: 64, temperature: 0.2, topP: 0.9, stopSequences: ['END'] },
        toolConfig: { tools: [{ toolSpec: { name: 'get_weather', inputSchema: { json: { type: 'object' } } } }] },
      }),
    );
    expect(output.stopReason).toBe('tool_use');
    const span = harness.span('aws.bedrock.converse');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'aws_bedrock',
      'gen_ai.provider.name': 'aws_bedrock',
      'gen_ai.request.model': CLAUDE,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.message_count': 1,
      'gen_ai.request.instructions': 'You are terse.',
      'gen_ai.request.max_tokens': 64,
      'gen_ai.request.temperature': 0.2,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.usage.input_tokens': 21,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.total_tokens': 30,
      'gen_ai.usage.cost.total': calculator.calculateCost(CLAUDE, { prompt_tokens: 21, completion_tokens: 9 }, 'chat'),
      'gen_ai.response': 'Checking the weather.',
      'gen_ai.response.finish_reasons': ['tool_use'],
      'llm.output_messages.0.message.tool_calls.0.tool_call.id': 'tool-1',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'get_weather',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments': '{"city": "Paris"}',
    });
    expect(String(span.attributes['llm.tools'])).toContain('get_weather');
  });

  it('the aggregated client (`bedrock.converse()`) is traced through the same path', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({ json: { output: { message: { role: 'assistant', content: [{ text: 'Paris.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
    await new BedrockRuntime(config()).converse({ modelId: NOVA, messages: MESSAGES });
    expect(harness.span('aws.bedrock.converse').attributes['gen_ai.usage.total_tokens']).toBe(12);
  });

  it('ConverseStream: the span stays open until the stream ends; usage from the metadata event', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({
      headers: EVENT_STREAM,
      raw: Buffer.concat([
        frame('messageStart', { role: 'assistant' }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Paris' } }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: '.' } }),
        frame('messageStop', { stopReason: 'end_turn' }),
        frame('metadata', { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 300 } }),
      ]),
    });
    const output = await client().send(new ConverseStreamCommand({ modelId: NOVA, messages: MESSAGES }));
    expect(harness.spans()).toEqual([]);
    let text = '';
    for await (const event of output.stream ?? []) text += event.contentBlockDelta?.delta?.text ?? '';
    expect(text).toBe('Paris.');
    const span = harness.span('aws.bedrock.converse_stream');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'aws_bedrock',
      'gen_ai.request.model': NOVA,
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.cost.total': calculator.calculateCost(NOVA, { prompt_tokens: 10, completion_tokens: 2 }, 'chat'),
    });
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
  });

  it('InvokeModel: the body is read without disturbing it; an Anthropic body carries usage and text', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'], enableContentCapture: true });
    llm.reply({
      json: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Paris.' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } },
    });
    const output = await client().send(
      new InvokeModelCommand({
        modelId: CLAUDE,
        contentType: 'application/json',
        body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: [{ role: 'user', content: 'Capital of France?' }] }),
      }),
    );
    // The caller still gets the bytes.
    expect(JSON.parse(new TextDecoder().decode(output.body)).content[0].text).toBe('Paris.');
    expect(harness.span('aws.bedrock.invoke_model').attributes).toMatchObject({
      'gen_ai.system': 'aws_bedrock',
      'gen_ai.request.model': CLAUDE,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.type': 'chat',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.response': 'Paris.',
      'gen_ai.usage.cost.total': calculator.calculateCost(CLAUDE, { prompt_tokens: 12, completion_tokens: 3 }, 'chat'),
    });
  });

  it('InvokeModel with an embedding model: operation, input count, vector size, tokens', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({ json: { embedding: [0.1, 0.2, 0.3, 0.4], inputTextTokenCount: 5 } });
    await client().send(new InvokeModelCommand({ modelId: TITAN_EMBED, contentType: 'application/json', body: JSON.stringify({ inputText: 'alpha' }) }));
    expect(harness.span('aws.bedrock.invoke_model').attributes).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 1,
      'gen_ai.response.embedding_count': 1,
      'gen_ai.response.vector_size': 4,
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.cost.total': calculator.calculateCost(TITAN_EMBED, { prompt_tokens: 5 }, 'embedding'),
    });
  });

  it('InvokeModelWithResponseStream: closed when the stream ends; usage from the invocation metrics', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({
      headers: EVENT_STREAM,
      raw: Buffer.concat([
        chunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Paris.' } }),
        chunk({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 12, outputTokenCount: 3, invocationLatency: 400, firstByteLatency: 120 } }),
      ]),
    });
    const output = await client().send(
      new InvokeModelWithResponseStreamCommand({ modelId: CLAUDE, contentType: 'application/json', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }),
    );
    let events = 0;
    for await (const _event of output.body ?? []) events += 1;
    expect(events).toBe(2);
    expect(harness.span('aws.bedrock.invoke_model_with_response_stream').attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 3,
    });
  });

  it('a provider error ends the span with ERROR status and no usage', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({ status: 400, headers: { 'x-amzn-errortype': 'ValidationException' }, json: { message: 'The provided model identifier is invalid.' } });
    await expect(client().send(new ConverseCommand({ modelId: 'no-such-model', messages: MESSAGES }))).rejects.toThrow();
    const span = harness.span('aws.bedrock.converse');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });

  it('other commands are not traced', async () => {
    harness = await startHarness({ enabledInstrumentors: ['boto3'] });
    llm.reply({ json: { inputTokens: 7 } });
    await client().send(new CountTokensCommand({ modelId: CLAUDE, input: { converse: { messages: MESSAGES } } }));
    expect(harness.spans()).toEqual([]);
  });
});
