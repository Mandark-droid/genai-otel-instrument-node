// @ts-check
/**
 * Mistral through `@mistralai/mistralai`: a buffered chat call, a streamed one,
 * and an embeddings call. Span names carry the model, e.g.
 * `mistralai.chat.complete mistral-small-latest`.
 *
 *   npm run build
 *   MISTRAL_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/mistral/chat.mjs
 */
import { Mistral } from '@mistralai/mistralai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from '@traceverse/genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-mistral' });
// @mistralai/mistralai is an ES-module package: it is patched asynchronously.
await instrumentorsReady();

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY ?? '', serverURL: process.env.EXAMPLE_BASE_URL });
const model = process.env.EXAMPLE_CHAT_MODEL ?? 'mistral-small-latest';
const messages = [{ role: /** @type {const} */ ('user'), content: 'What is the capital of France?' }];

const response = await client.chat.complete({ model, messages });
console.log('answer:', response.choices[0]?.message?.content, '| tokens:', response.usage?.totalTokens);

const stream = await client.chat.stream({ model, messages });
for await (const event of stream) process.stdout.write(String(event.data.choices[0]?.delta.content ?? ''));
process.stdout.write('\n');

const embeddings = await client.embeddings.create({
  model: process.env.EXAMPLE_EMBEDDING_MODEL ?? 'mistral-embed',
  inputs: ['alpha', 'beta'],
});
console.log('vectors:', embeddings.data.length);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
