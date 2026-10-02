// @ts-check
/**
 * The Vercel AI SDK. Its functions cannot be patched; it emits OpenTelemetry
 * spans itself once an `@ai-sdk/otel` integration is given to a call. This
 * library then prices the model-call span, fills in the provider, puts the
 * span in the session, and removes the prompt and the response the SDK
 * records - unless content capture is on.
 *
 *   npm run build
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/vercel-ai-sdk/generate.mjs
 *
 * The model is any OpenAI-compatible endpoint; the default is a local Ollama.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenTelemetry } from '@ai-sdk/otel';
import { generateText } from 'ai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument, withSession } from '@traceverse/genai-otel-instrument';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-vercel-ai-sdk' });
await instrumentorsReady();

const provider = createOpenAICompatible({
  name: process.env.EXAMPLE_PROVIDER_NAME ?? 'ollama',
  apiKey: process.env.EXAMPLE_API_KEY ?? 'not-needed-for-a-local-model',
  baseURL: process.env.EXAMPLE_BASE_URL ?? 'http://localhost:11434/v1',
});

const sessionId = process.env.EXAMPLE_SESSION_ID ?? `ai-sdk-${Date.now()}`;
const result = await withSession(sessionId, () =>
  generateText({
    model: provider(process.env.EXAMPLE_CHAT_MODEL ?? 'qwen3.5:4b'),
    prompt: 'What is the capital of France?',
    telemetry: { integrations: [new OpenTelemetry()] },
  }),
);
console.log('answer:', result.text, '| tokens:', result.usage.totalTokens);
console.log('session.id:', sessionId);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
