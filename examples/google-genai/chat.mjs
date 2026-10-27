// @ts-check
/**
 * Google Gemini through `@google/genai`: a buffered call, a streamed call and
 * an embeddings call. Spans: google.genai.models.generate_content (twice),
 * google.genai.models.embeddings.
 *
 *   npm run build
 *   GEMINI_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/google-genai/chat.mjs
 */
import { GoogleGenAI } from '@google/genai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-google-genai' });
await instrumentorsReady();

const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: process.env.EXAMPLE_BASE_URL ? { baseUrl: process.env.EXAMPLE_BASE_URL } : undefined,
});
const model = process.env.EXAMPLE_CHAT_MODEL ?? 'gemini-2.5-flash';

const response = await client.models.generateContent({ model, contents: 'What is the capital of France?' });
console.log('answer:', response.text, '| tokens:', response.usageMetadata?.totalTokenCount);

const stream = await client.models.generateContentStream({ model, contents: 'Count from one to five.' });
for await (const chunk of stream) process.stdout.write(chunk.text ?? '');
process.stdout.write('\n');

const embeddings = await client.models.embedContent({
  model: process.env.EXAMPLE_EMBEDDING_MODEL ?? 'gemini-embedding-001',
  contents: ['alpha', 'beta'],
});
console.log('vectors:', embeddings.embeddings?.length);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
