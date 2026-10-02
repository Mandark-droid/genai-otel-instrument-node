# Vercel AI SDK example

`generate.mjs`: `generateText` from `ai` (version 7), through `@ai-sdk/openai-compatible`,
with the SDK's own OpenTelemetry integration (`@ai-sdk/otel`) given to the call.

The AI SDK's functions cannot be patched, so this library does not create these spans:
the SDK does. What this library adds to them:

- `gen_ai.system` / `gen_ai.provider.name` and `gen_ai.usage.total_tokens`;
- cost on the model-call span (`chat <model>`), and not on the `invoke_agent <model>`
  span that repeats its tokens;
- `session.id`, from `withSession`;
- removal of the prompt and the response, which the SDK records unless told not to.
  Set `GENAI_ENABLE_CONTENT_CAPTURE=true` to keep them.

Telemetry has to be switched on per call (`telemetry: { integrations: [new OpenTelemetry()] }`)
or once with `registerTelemetry(new OpenTelemetry())`; without it the SDK emits nothing
and there is nothing to see.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock | **Yes, here and in CI**: `tests/e2e/framework-examples.test.ts` runs it as a child process against the built package, a mock OpenAI-compatible server and a local OTLP receiver |
| Run against a real model | **No.** Not run against Ollama or any provider from this repository |
| Streaming (`streamText`), tools, `embed` | `embed` is covered by a unit test with the SDK's mock model; `streamText` and tool calls were not exercised |
| Browser / React Native | **No.** The processor is installed by the Node entry only |

## Run it

```bash
npm ci && npm run build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/vercel-ai-sdk/generate.mjs
```

| Variable | Default |
|---|---|
| `EXAMPLE_BASE_URL` | `http://localhost:11434/v1` (a local Ollama) |
| `EXAMPLE_CHAT_MODEL` | `qwen3.5:4b` |
| `EXAMPLE_PROVIDER_NAME` | `ollama` |
| `EXAMPLE_SESSION_ID` | generated; printed as `session.id` |
