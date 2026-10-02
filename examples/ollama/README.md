# Ollama example

`chat.mjs`: A buffered chat call, a streamed chat call and an embeddings call through the `ollama` package, against a local Ollama.

Spans: `ollama.chat` (twice), `ollama.embeddings`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No Ollama server was started where this was written; it needs no key, only `ollama serve` and the two models |

## Run it

```bash
npm ci && npm run build
ollama pull qwen3.5:4b && ollama pull embeddinggemma:300m
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/ollama/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.
