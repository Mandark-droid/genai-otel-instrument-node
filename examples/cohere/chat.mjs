// @ts-check
/**
 * Cohere through `cohere-ai`: a chat call on the v2 client and an embeddings
 * call. Spans: cohere.chat, cohere.embeddings.
 *
 *   npm run build
 *   CO_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/cohere/chat.mjs
 */
import { CohereClient, CohereClientV2 } from 'cohere-ai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

// Before the clients are created: the v2 client binds its methods when it is constructed.
instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-cohere' });
await instrumentorsReady();

const options = { token: process.env.CO_API_KEY, environment: process.env.EXAMPLE_BASE_URL };

const chat = await new CohereClientV2(options).chat({
  model: process.env.EXAMPLE_CHAT_MODEL ?? 'command-r',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
console.log('finish reason:', chat.finishReason, '| output tokens:', chat.usage?.tokens?.outputTokens);

const embeddings = await new CohereClient(options).embed({
  model: process.env.EXAMPLE_EMBEDDING_MODEL ?? 'embed-english-v3.0',
  texts: ['alpha', 'beta'],
  inputType: 'search_document',
});
console.log('vectors:', Array.isArray(embeddings.embeddings) ? embeddings.embeddings.length : 0);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
