// @ts-check
/**
 * Ollama through the `ollama` package: a buffered chat call, a streamed one and
 * an embeddings call, against a local Ollama. Spans: ollama.chat (twice),
 * ollama.embeddings.
 *
 *   npm run build
 *   ollama pull qwen3.5:4b && ollama pull embeddinggemma:300m
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/ollama/chat.mjs
 */
import { Ollama } from 'ollama';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-ollama' });
await instrumentorsReady();

const client = new Ollama({ host: process.env.OLLAMA_HOST ?? 'http://localhost:11434' });
const model = process.env.EXAMPLE_CHAT_MODEL ?? 'qwen3.5:4b';
const messages = [{ role: 'user', content: 'What is the capital of France?' }];

const response = await client.chat({ model, messages });
console.log('answer:', response.message.content, '| output tokens:', response.eval_count);

const stream = await client.chat({ model, messages, stream: true });
for await (const part of stream) process.stdout.write(part.message.content);
process.stdout.write('\n');

const embeddings = await client.embed({ model: process.env.EXAMPLE_EMBEDDING_MODEL ?? 'embeddinggemma:300m', input: ['alpha', 'beta'] });
console.log('vectors:', embeddings.embeddings.length);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
