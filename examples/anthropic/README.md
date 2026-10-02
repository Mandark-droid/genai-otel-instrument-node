# Anthropic example

`messages.mjs`: a buffered message with a tool, a raw event stream and the
`messages.stream()` helper through the official `@anthropic-ai/sdk` package, each traced
as one span with token counts and cost.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/examples.test.ts` runs `examples/anthropic/messages.mjs` as a child process against the built package and a mock provider, and checks the three spans it exports |
| Run against the live Anthropic API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
ANTHROPIC_API_KEY=sk-ant-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/anthropic/messages.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console.

## What you should see

Three spans - `anthropic.messages.create` twice and `anthropic.messages.stream` - carrying
`gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`,
`gen_ai.usage.cost.total` and, when the prompt cache is used,
`gen_ai.usage.cache_read.input_tokens` / `cache_write.input_tokens` with their costs.

As in the Python library, Anthropic spans carry no finish reason, response id or
tool-call attributes; see `docs/parity-matrix.md`.
