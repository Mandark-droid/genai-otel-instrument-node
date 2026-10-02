# OpenAI example

`chat.mjs`: a buffered chat call with a tool, a streamed chat call and an embeddings call
through the official `openai` package, each traced as one span with token counts and
cost.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/examples.test.ts` runs `examples/openai/chat.mjs` as a child process against the built package and a mock provider, and checks the three spans it exports |
| Run against the live OpenAI API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
OPENAI_API_KEY=sk-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/openai/chat.mjs
```

Against an OpenAI-compatible endpoint instead:

```bash
OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=none \
EXAMPLE_CHAT_MODEL=<model the endpoint serves> EXAMPLE_EMBEDDING_MODEL=<embedding model> \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/openai/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console.

## What you should see

Three spans - `openai.chat.completion` twice and `openai.embeddings` - carrying
`gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`,
`gen_ai.usage.cost.total`, `server.address`, and on the streamed call
`gen_ai.server.time_to_first_token`. A model with no entry in the pricing table has no
cost attribute and `gen_ai.usage.cost.pricing_source = unpriced`.
