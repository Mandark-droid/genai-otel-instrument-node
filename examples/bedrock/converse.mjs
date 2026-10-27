// @ts-check
/**
 * AWS Bedrock through `@aws-sdk/client-bedrock-runtime`: a Converse call and an
 * InvokeModel call. Spans: aws.bedrock.converse, aws.bedrock.invoke_model.
 * Credentials and region come from the usual AWS environment.
 *
 *   npm run build
 *   AWS_REGION=us-east-1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/bedrock/converse.mjs
 */
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-bedrock' });
await instrumentorsReady();

// EXAMPLE_BASE_URL points the client at a local stand-in, which speaks HTTP/1.1.
const local = process.env.EXAMPLE_BASE_URL;
const client = new BedrockRuntimeClient(local ? { endpoint: local, requestHandler: new NodeHttpHandler() } : {});
const modelId = process.env.EXAMPLE_CHAT_MODEL ?? 'amazon.nova-lite-v1:0';

const converse = await client.send(
  new ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ text: 'What is the capital of France?' }] }],
    inferenceConfig: { maxTokens: 64 },
  }),
);
console.log('stop reason:', converse.stopReason, '| tokens:', converse.usage?.totalTokens);

const invoke = await client.send(
  new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'Say hello.' }] }] }),
  }),
);
console.log('invoke bytes:', invoke.body.length);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
