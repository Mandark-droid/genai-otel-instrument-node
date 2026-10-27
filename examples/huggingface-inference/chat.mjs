// @ts-check
/**
 * HuggingFace Inference through `@huggingface/inference`. This client cannot be
 * patched from outside, so the application wraps the client it creates:
 * `traceHuggingFaceClient(new InferenceClient(token))`.
 * Span: huggingface.inference.chat_completion.
 *
 *   npm run build
 *   HF_TOKEN=hf_... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/huggingface-inference/chat.mjs
 */
import { InferenceClient } from '@huggingface/inference';
import { flushTelemetry, instrument, traceHuggingFaceClient, uninstrument } from '@traceverse/genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-huggingface-inference' });

const endpointUrl = process.env.EXAMPLE_BASE_URL;
const client = traceHuggingFaceClient(new InferenceClient(process.env.HF_TOKEN, endpointUrl ? { endpointUrl } : {}));

const response = await client.chatCompletion({
  model: process.env.EXAMPLE_CHAT_MODEL ?? 'meta-llama/Llama-3.1-8B-Instruct',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  max_tokens: 64,
});
console.log('answer:', response.choices[0]?.message.content, '| tokens:', response.usage?.total_tokens);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
