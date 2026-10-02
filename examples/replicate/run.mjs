// @ts-check
/**
 * Replicate through the `replicate` package: one `run()`. Span: replicate.run.
 * Replicate bills by hardware time, so the span carries no tokens and no cost.
 *
 *   npm run build
 *   REPLICATE_API_TOKEN=r8_... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/replicate/run.mjs
 */
import Replicate from 'replicate';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from '@traceverse/genai-otel-instrument';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-replicate' });
await instrumentorsReady();

const client = new Replicate({ baseUrl: process.env.EXAMPLE_BASE_URL, useFileOutput: false });
const output = await client.run(
  /** @type {`${string}/${string}`} */ (process.env.EXAMPLE_CHAT_MODEL ?? 'meta/meta-llama-3-8b-instruct'),
  { input: { prompt: 'What is the capital of France?' } },
);
console.log('output:', Array.isArray(output) ? output.join('') : output);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
