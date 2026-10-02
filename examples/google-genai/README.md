# Google Gemini example

`chat.mjs`: A buffered call, a streamed call and an embeddings call through `@google/genai`.

Spans: `google.genai.models.generate_content` (twice), `google.genai.models.embeddings`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
GEMINI_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/google-genai/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.

With automatic function calling, each round trip to the model is one span. Vertex AI through this client (`vertexai: true`) is traced the same way; the older `@google-cloud/vertexai` client is traced as `vertexai.generate_content`.
