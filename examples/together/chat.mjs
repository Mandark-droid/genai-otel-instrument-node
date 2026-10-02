// @ts-check
/**
 * Together AI through `together-ai`: a chat call and an embeddings call.
 * Spans: together.chat.completion, together.embeddings.
 *
 *   npm run build
 *   TOGETHER_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/together/chat.mjs
 */
import Together from 'together-ai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from '@traceverse/genai-otel-instrument';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-together' });
await instrumentorsReady();

const client = new Together({ baseURL: process.env.EXAMPLE_BASE_URL });

const completion = await client.chat.completions.create({
  model: process.env.EXAMPLE_CHAT_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
console.log('answer:', completion.choices[0]?.message?.content, '| tokens:', completion.usage?.total_tokens);

const embeddings = await client.embeddings.create({
  model: process.env.EXAMPLE_EMBEDDING_MODEL ?? 'BAAI/bge-base-en-v1.5',
  input: ['alpha', 'beta'],
});
console.log('vectors:', embeddings.data.length);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
