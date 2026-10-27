// @ts-check
/**
 * Anthropic: a buffered message, a raw event stream, and the `messages.stream()`
 * helper - each becomes one span with tokens and cost.
 *
 *   npm run build
 *   ANTHROPIC_API_KEY=sk-ant-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   node examples/anthropic/messages.mjs
 */
import Anthropic from '@anthropic-ai/sdk';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from 'genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-anthropic' });
await instrumentorsReady();

const client = new Anthropic();
const model = process.env.EXAMPLE_MODEL ?? 'claude-sonnet-4-5';

// 1. Buffered, with a tool. Span: anthropic.messages.create.
const message = await client.messages.create({
  model,
  max_tokens: 256,
  messages: [{ role: 'user', content: 'What is the weather in Mumbai?' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Current weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
});
console.log('stop reason:', message.stop_reason, '| output tokens:', message.usage.output_tokens);

// 2. Raw event stream. Usage arrives in pieces - input tokens on message_start,
//    cumulative output tokens on each message_delta - and is folded together.
const events = await client.messages.create({
  model,
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Count from one to five.' }],
  stream: true,
});
for await (const event of events) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') process.stdout.write(event.delta.text);
}
process.stdout.write('\n');

// 3. The streaming helper. Span: anthropic.messages.stream, measured whether the
//    caller iterates the stream or only asks for the final message.
const final = await client.messages
  .stream({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Name one prime number.' }] })
  .finalMessage();
console.log('final:', final.content[0]?.type === 'text' ? final.content[0].text : final.content[0]?.type);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
