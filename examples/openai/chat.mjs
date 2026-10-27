// @ts-check
/**
 * OpenAI: a buffered chat call with a tool, a streamed chat call, and an
 * embeddings call - each becomes one span with tokens and cost.
 *
 *   npm run build
 *   OPENAI_API_KEY=sk-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   node examples/openai/chat.mjs
 *
 * Works unchanged against any OpenAI-compatible endpoint (vLLM, llama.cpp
 * server, LiteLLM, Ollama): set OPENAI_BASE_URL and a model that endpoint
 * serves in EXAMPLE_CHAT_MODEL / EXAMPLE_EMBEDDING_MODEL.
 */
import OpenAI from 'openai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from '@traceverse/genai-otel-instrument-node';

// One line. Everything else is read from the environment (OTEL_*, GENAI_*).
instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-openai' });
// Only an ES-module application needs this, and only if its very first call
// must be traced: the ESM build of the client is patched asynchronously.
await instrumentorsReady();

const client = new OpenAI();
const chatModel = process.env.EXAMPLE_CHAT_MODEL ?? 'gpt-4o-mini';
const embeddingModel = process.env.EXAMPLE_EMBEDDING_MODEL ?? 'text-embedding-3-small';

// 1. Buffered chat with a tool. Span: openai.chat.completion.
const completion = await client.chat.completions.create({
  model: chatModel,
  messages: [{ role: 'user', content: 'What is the weather in Mumbai?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ],
});
console.log('finish reason:', completion.choices[0]?.finish_reason, '| tokens:', completion.usage?.total_tokens);

// 2. Streamed chat. The span stays open until the stream ends, and records time
//    to first token. Ask for usage, or the stream carries no token counts and
//    the span can have no cost.
const stream = await client.chat.completions.create({
  model: chatModel,
  messages: [{ role: 'user', content: 'Count from one to five.' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
process.stdout.write('\n');

// 3. Embeddings. Span: openai.embeddings.
const embeddings = await client.embeddings.create({ model: embeddingModel, input: ['alpha', 'beta'] });
console.log('vectors:', embeddings.data.length, 'x', embeddings.data[0]?.embedding.length);

// A short-lived process drains what is queued before it exits.
const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
