// @ts-check
/**
 * Groq through `groq-sdk`: a buffered and a streamed chat call. Span: groq.chat.completions.
 *
 *   npm run build
 *   GROQ_API_KEY=gsk_... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/groq/chat.mjs
 */
import Groq from 'groq-sdk';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from '@traceverse/genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-groq' });
await instrumentorsReady();

const client = new Groq({ baseURL: process.env.EXAMPLE_BASE_URL });
const model = process.env.EXAMPLE_CHAT_MODEL ?? 'llama-3.1-8b-instant';

const completion = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
console.log('answer:', completion.choices[0]?.message.content, '| tokens:', completion.usage?.total_tokens);

const stream = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Count from one to five.' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
process.stdout.write('\n');

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
