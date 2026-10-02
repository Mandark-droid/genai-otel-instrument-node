# HuggingFace Inference example

`chat.mjs`: A chat completion through `@huggingface/inference`, on a client wrapped with `traceHuggingFaceClient()`.

Spans: `huggingface.inference.chat_completion`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
HF_TOKEN=hf_... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/huggingface-inference/chat.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.

This client cannot be patched from outside: its constructor defines each method on the instance as a non-configurable property and the module exports are read-only. Wrap the client you create; a client that is not wrapped is not traced.
