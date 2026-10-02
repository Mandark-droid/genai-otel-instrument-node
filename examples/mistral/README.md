# Mistral example

`chat.mjs`: A buffered chat call, a streamed chat call and an embeddings call through `@mistralai/mistralai`.

Spans: `mistralai.chat.complete <model>`, `mistralai.chat.stream <model>`, `mistralai.embeddings.create <model>` (the span name carries the model, as in the Python library).

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
MISTRAL_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/mistral/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.

`@mistralai/mistralai` is an ES-module package and is patched asynchronously: `await instrumentorsReady()` before the first call.
