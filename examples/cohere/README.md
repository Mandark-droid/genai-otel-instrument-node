# Cohere example

`chat.mjs`: A chat call on the v2 client and an embeddings call through `cohere-ai`.

Spans: `cohere.chat`, `cohere.embeddings`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
CO_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/cohere/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.

Call `instrument()` before creating a `CohereClientV2`: that client binds its methods when it is constructed, so one created earlier is not traced.
