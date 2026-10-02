// @ts-check
/**
 * End-to-end smoke: one chat call through an OpenAI-compatible endpoint, traced
 * by this SDK and exported over OTLP.
 *
 *   npm run build
 *   E2E_LLM_MODEL=<model> \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318 \
 *   node examples/e2e/smoke/smoke.mjs
 *
 * The model endpoint defaults to a local Ollama (http://localhost:11434/v1, no
 * API key). Point it elsewhere with E2E_LLM_BASE_URL and, if the endpoint wants
 * one, E2E_LLM_API_KEY.
 *
 * `OTEL_SERVICE_NAME` defaults to `genai-sdk-e2e-node`, so the data is separable
 * on the platform from everything else and from the other SDKs.
 *
 * Prints one JSON document to stdout: what THIS SDK measured for the call
 * (trace id, model, tokens, cost, pricing source). That is the figure to compare
 * against what the platform stored. Exit status: 0 the call was made and the
 * telemetry was accepted by the collector; 1 the call itself failed; 2 the call
 * succeeded but the telemetry could not be flushed.
 */
import { trace } from '@opentelemetry/api';
import OpenAI from 'openai';
import {
  CostEnrichmentSpanProcessor,
  flushTelemetry,
  getDefaultCostCalculator,
  instrument,
  instrumentorsReady,
  uninstrument,
  VERSION,
} from '@traceverse/genai-otel-instrument';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See the header of ${import.meta.url} for the variables this needs.`);
    process.exit(64);
  }
  return value;
}

const baseURL = process.env.E2E_LLM_BASE_URL || 'http://localhost:11434/v1';
const model = required('E2E_LLM_MODEL');
const apiKey = process.env.E2E_LLM_API_KEY ?? 'not-needed';
required('OTEL_EXPORTER_OTLP_ENDPOINT');
process.env.OTEL_SERVICE_NAME ??= 'genai-sdk-e2e-node';

/** @typedef {import('@opentelemetry/sdk-trace-base').SpanProcessor} SpanProcessor */
/** @typedef {import('@opentelemetry/sdk-trace-base').ReadableSpan} ReadableSpan */

/**
 * Remembers the chat span this process ended, so its trace id can be printed
 * next to the model's answer.
 * @implements {SpanProcessor}
 */
class LastSpan {
  /** @type {ReadableSpan | undefined} */
  span = undefined;
  onStart() {}
  /** @param {ReadableSpan} span */
  onEnd(span) {
    if (span.name === 'openai.chat.completion') this.span = span;
  }
  async forceFlush() {}
  async shutdown() {}
}

const last = new LastSpan();
const handle = instrument({ enabledInstrumentors: ['openai'], spanProcessors: [last] });
if (!handle) {
  console.error('instrument() did not set up telemetry; see the log lines above.');
  process.exit(2);
}
await instrumentorsReady();
// Not used directly; referenced so a build that lost the export fails here, not on the platform.
void CostEnrichmentSpanProcessor;

const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
const prompt = process.env.E2E_PROMPT ?? 'Reply with the single word: pong';

/** @type {import('openai').OpenAI.Chat.Completions.ChatCompletion} */
let completion;
try {
  completion = await trace.getTracer('genai-sdk-e2e').startActiveSpan('e2e.smoke', async (root) => {
    try {
      return await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 32,
        temperature: 0,
      });
    } finally {
      root.end();
    }
  });
} catch (error) {
  console.error(`The chat call failed: ${error instanceof Error ? error.message : String(error)}`);
  await flushTelemetry(10);
  await uninstrument();
  process.exit(1);
}

const flushed = await flushTelemetry(15);
await uninstrument();

const usage = {
  prompt_tokens: completion.usage?.prompt_tokens ?? 0,
  completion_tokens: completion.usage?.completion_tokens ?? 0,
  total_tokens: completion.usage?.total_tokens ?? 0,
};
const calculator = getDefaultCostCalculator();
const summary = {
  sdk: { language: 'nodejs', distro: 'genai-otel-instrument-node', version: VERSION },
  service_name: handle.config.serviceName,
  otlp_endpoint: handle.config.endpoint,
  exporter: handle.exporter,
  llm_base_url: baseURL,
  request_model: model,
  response_model: completion.model,
  response_id: completion.id,
  answer: completion.choices[0]?.message?.content ?? null,
  usage,
  // null means "no price known for this model": the span then carries no cost attribute.
  sdk_cost_usd: calculator.calculateCost(model, usage, 'chat'),
  pricing_source: calculator.pricingSource(model, 'chat'),
  trace_id: last.span?.spanContext().traceId ?? null,
  telemetry_flushed: flushed,
};
console.log(JSON.stringify(summary, null, 2));

if (!flushed) {
  console.error(`The call succeeded but the telemetry was NOT accepted by ${handle.config.endpoint}.`);
  process.exit(2);
}
process.exit(0);
