// @ts-check
/**
 * Sarvam AI through `sarvamai`: one translation. Span: sarvam.text.translate,
 * priced per thousand characters.
 *
 *   npm run build
 *   SARVAM_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/sarvam/translate.mjs
 */
import { SarvamAIClient } from 'sarvamai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-sarvam' });
await instrumentorsReady();

const client = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY ?? '', baseUrl: process.env.EXAMPLE_BASE_URL });
const result = await client.text.translate({
  input: 'Hello, how are you?',
  source_language_code: 'en-IN',
  target_language_code: 'hi-IN',
  model: 'mayura:v1',
});
console.log('translated:', result.translated_text);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
