// @ts-check
/**
 * A provider reached through the `openai` client at its own base URL:
 * OpenRouter, CometAPI, Hyperbolic or SambaNova. The call is traced once, under
 * the provider's own span name and `gen_ai.system`, not as an OpenAI call.
 *
 *   npm run build
 *   EXAMPLE_PROVIDER=openrouter EXAMPLE_API_KEY=sk-or-... \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   node examples/openai-compatible/chat.mjs
 */
import OpenAI from 'openai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

const PROVIDERS = {
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  cometapi: { baseURL: 'https://api.cometapi.com/v1', model: 'gpt-4o-mini' },
  hyperbolic: { baseURL: 'https://api.hyperbolic.xyz/v1', model: 'meta-llama/Meta-Llama-3.1-8B-Instruct' },
  sambanova: { baseURL: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.1-8B-Instruct' },
};

const name = /** @type {keyof typeof PROVIDERS} */ (process.env.EXAMPLE_PROVIDER ?? 'openrouter');
const provider = PROVIDERS[name];
if (!provider) {
  console.error(`EXAMPLE_PROVIDER must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(64);
}

instrument({
  serviceName: process.env.OTEL_SERVICE_NAME ?? `example-${name}`,
  // Hyperbolic is not in the default instrumentor list (it is not in the Python
  // library's either): ask for it, or set GENAI_ENABLED_INSTRUMENTORS.
  ...(name === 'hyperbolic' ? { enabledInstrumentors: ['openai', 'hyperbolic'] } : {}),
});
await instrumentorsReady();

// The base URL is what identifies the provider: it must contain the provider's domain.
const client = new OpenAI({
  apiKey: process.env.EXAMPLE_API_KEY ?? 'not-set',
  baseURL: process.env.EXAMPLE_BASE_URL ?? provider.baseURL,
});

const completion = await client.chat.completions.create({
  model: process.env.EXAMPLE_CHAT_MODEL ?? provider.model,
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
console.log(`${name}:`, completion.choices[0]?.message.content, '| tokens:', completion.usage?.total_tokens);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
