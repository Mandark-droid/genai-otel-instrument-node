# Groq example

`chat.mjs`: A buffered and a streamed chat call through `groq-sdk`.

Spans: `groq.chat.completions` (twice).

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
GROQ_API_KEY=gsk_... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/groq/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.
