// @ts-check
/**
 * ElevenLabs through `@elevenlabs/elevenlabs-js`: one text-to-speech call.
 * Span: elevenlabs.text_to_speech.convert, priced by the character.
 *
 *   npm run build
 *   ELEVENLABS_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/elevenlabs/speech.mjs
 */
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-elevenlabs' });
await instrumentorsReady();

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY, baseUrl: process.env.EXAMPLE_BASE_URL });
const audio = await client.textToSpeech.convert(process.env.EXAMPLE_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb', {
  text: 'The capital of France is Paris.',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'mp3_44100_128',
});
let bytes = 0;
for await (const chunk of audio) bytes += chunk.length;
console.log('audio bytes:', bytes);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
