// @ts-check
/**
 * A LangGraph graph whose nodes call a model through the `openai` client.
 * One span for the graph run, and beneath it one span per model call; the
 * graph's thread id is the session of all of them, and the graph span says how
 * many model calls and tokens the run consumed against its recursion limit.
 *
 *   npm run build
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/langgraph/agent.mjs
 *
 * The model is any OpenAI-compatible endpoint; the default is a local Ollama.
 */
import { randomBytes } from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import OpenAI from 'openai';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument } from '@traceverse/genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-langgraph' });
await instrumentorsReady();

const client = new OpenAI({
  apiKey: process.env.EXAMPLE_API_KEY ?? 'not-needed-for-a-local-model',
  baseURL: process.env.EXAMPLE_BASE_URL ?? 'http://localhost:11434/v1',
});
const model = process.env.EXAMPLE_CHAT_MODEL ?? 'qwen3.5:4b';

/** @param {string} prompt */
async function ask(prompt) {
  const completion = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }] });
  return completion.choices[0]?.message.content ?? '';
}

const State = Annotation.Root({
  question: Annotation(),
  draft: Annotation(),
  answer: Annotation(),
});

const graph = new StateGraph(State)
  .addNode('draft_answer', async (state) => ({ draft: await ask(String(state.question)) }))
  .addNode('shorten', async (state) => ({ answer: await ask(`Shorten to one sentence: ${String(state.draft)}`) }))
  .addEdge(START, 'draft_answer')
  .addEdge('draft_answer', 'shorten')
  .addEdge('shorten', END)
  .compile();

const threadId = process.env.EXAMPLE_SESSION_ID ?? `langgraph-${randomBytes(6).toString('hex')}`;
const result = await graph.invoke({ question: 'What is the capital of France?' }, { configurable: { thread_id: threadId }, recursionLimit: 10 });
console.log('answer:', result.answer);
console.log('session.id:', threadId);

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
