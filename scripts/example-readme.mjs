#!/usr/bin/env node
/**
 * Writes the README of a provider example from one line of facts, so that
 * every example says the same things in the same place: what it does, whether
 * it was run live, how to run it.
 *
 * Usage: node scripts/example-readme.mjs   (rewrites every README listed below)
 *
 * The OpenAI, Anthropic and e2e READMEs are written by hand and not touched.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{dir: string, title: string, file: string, does: string, spans: string, run: string, test?: string, live?: string, notes?: string}[]} */
export const EXAMPLES = [
  {
    dir: 'openai-compatible',
    title: 'OpenAI-compatible providers (OpenRouter, CometAPI, Hyperbolic, SambaNova)',
    file: 'chat.mjs',
    does: 'One chat call through the `openai` client pointed at the provider chosen by `EXAMPLE_PROVIDER`. The base URL identifies the provider; the call is traced once, under the provider\'s own span name and `gen_ai.system`.',
    spans: '`openrouter.chat.completion`, `cometapi.chat.completion`, `hyperbolic.chat.completion` or `sambanova.chat.completion`',
    run: 'EXAMPLE_PROVIDER=openrouter EXAMPLE_API_KEY=sk-or-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/openai-compatible/chat.mjs',
  },
  {
    dir: 'groq',
    title: 'Groq',
    file: 'chat.mjs',
    does: 'A buffered and a streamed chat call through `groq-sdk`.',
    spans: '`groq.chat.completions` (twice)',
    run: 'GROQ_API_KEY=gsk_... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/groq/chat.mjs',
  },
  {
    dir: 'together',
    title: 'Together AI',
    file: 'chat.mjs',
    does: 'A chat call and an embeddings call through `together-ai`.',
    spans: '`together.chat.completion`, `together.embeddings`',
    run: 'TOGETHER_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/together/chat.mjs',
  },
  {
    dir: 'mistral',
    title: 'Mistral',
    file: 'chat.mjs',
    does: 'A buffered chat call, a streamed chat call and an embeddings call through `@mistralai/mistralai`.',
    spans: '`mistralai.chat.complete <model>`, `mistralai.chat.stream <model>`, `mistralai.embeddings.create <model>` (the span name carries the model, as in the Python library)',
    run: 'MISTRAL_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/mistral/chat.mjs',
    notes: '`@mistralai/mistralai` is an ES-module package and is patched asynchronously: `await instrumentorsReady()` before the first call.',
  },
  {
    dir: 'cohere',
    title: 'Cohere',
    file: 'chat.mjs',
    does: 'A chat call on the v2 client and an embeddings call through `cohere-ai`.',
    spans: '`cohere.chat`, `cohere.embeddings`',
    run: 'CO_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/cohere/chat.mjs',
    notes: 'Call `instrument()` before creating a `CohereClientV2`: that client binds its methods when it is constructed, so one created earlier is not traced.',
  },
  {
    dir: 'ollama',
    title: 'Ollama',
    file: 'chat.mjs',
    does: 'A buffered chat call, a streamed chat call and an embeddings call through the `ollama` package, against a local Ollama.',
    spans: '`ollama.chat` (twice), `ollama.embeddings`',
    run: 'ollama pull qwen3.5:4b && ollama pull embeddinggemma:300m\nOTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/ollama/chat.mjs',
    live: '**No.** No Ollama server was started where this was written; it needs no key, only `ollama serve` and the two models',
  },
  {
    dir: 'google-genai',
    title: 'Google Gemini',
    file: 'chat.mjs',
    does: 'A buffered call, a streamed call and an embeddings call through `@google/genai`.',
    spans: '`google.genai.models.generate_content` (twice), `google.genai.models.embeddings`',
    run: 'GEMINI_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/google-genai/chat.mjs',
    notes: 'With automatic function calling, each round trip to the model is one span. Vertex AI through this client (`vertexai: true`) is traced the same way; the older `@google-cloud/vertexai` client is traced as `vertexai.generate_content`.',
  },
  {
    dir: 'bedrock',
    title: 'AWS Bedrock',
    file: 'converse.mjs',
    does: 'A Converse call and an InvokeModel call through `@aws-sdk/client-bedrock-runtime`.',
    spans: '`aws.bedrock.converse`, `aws.bedrock.invoke_model`',
    run: 'AWS_REGION=us-east-1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/bedrock/converse.mjs',
    live: '**No.** No AWS credentials were available where this was written',
    notes: 'The instrumentor is registered as `boto3`, the name the Python library uses for it, so one `GENAI_ENABLED_INSTRUMENTORS` value works for both.',
  },
];

function readme(example) {
  const test = example.test ?? 'tests/e2e/provider-examples.test.ts';
  return `# ${example.title} example

\`${example.file}\`: ${example.does}

Spans: ${example.spans}.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (\`npm run typecheck\`) |
| Run against a mock provider | Yes: \`${test}\` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | ${example.live ?? '**No.** No API key was available where this was written'} |

## Run it

\`\`\`bash
npm ci && npm run build
${example.run}
\`\`\`

With no collector at hand, set \`OTEL_EXPORTER_OTLP_ENDPOINT=\` (empty) to print spans and
metrics to the console instead.
${example.notes ? `\n${example.notes}\n` : ''}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const example of EXAMPLES) {
    const path = resolve(ROOT, 'examples', example.dir, 'README.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readme(example));
    console.log(`wrote examples/${example.dir}/README.md`);
  }
}
