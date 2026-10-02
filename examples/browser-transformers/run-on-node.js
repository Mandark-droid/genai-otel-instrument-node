/**
 * The same instrumentation on Node: a small model on the CPU through
 * transformers.js. Nothing is handed over here - on Node the library is found
 * by name, under the instrumentor name `transformers`.
 *
 *   npm install            (in this directory)
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node run-on-node.js
 *
 * The first run downloads the model from the Hugging Face hub.
 */
import { pipeline } from '@huggingface/transformers';
import { flushTelemetry, instrument, instrumentorsReady, setSession, uninstrument } from '../../dist/index.mjs';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-transformers-node' });
await instrumentorsReady();
setSession(process.env.EXAMPLE_SESSION_ID ?? 'transformers-node-' + Date.now());

const model = process.env.EXAMPLE_CHAT_MODEL ?? 'Xenova/distilgpt2';
const generator = await pipeline('text-generation', model, { dtype: 'q8' });
const output = await generator('The capital of France is', { max_new_tokens: 8, do_sample: false });
console.log(output[0].generated_text);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
