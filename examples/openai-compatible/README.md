# OpenAI-compatible providers (OpenRouter, CometAPI, Hyperbolic, SambaNova) example

`chat.mjs`: One chat call through the `openai` client pointed at the provider chosen by `EXAMPLE_PROVIDER`. The base URL identifies the provider; the call is traced once, under the provider's own span name and `gen_ai.system`.

Spans: `openrouter.chat.completion`, `cometapi.chat.completion`, `hyperbolic.chat.completion` or `sambanova.chat.completion`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
EXAMPLE_PROVIDER=openrouter EXAMPLE_API_KEY=sk-or-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/openai-compatible/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.
