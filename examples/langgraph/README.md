# LangGraph example: a graph run and the model calls inside it

`agent.mjs`: a two-node LangGraph graph; each node calls a model through the `openai`
client at an OpenAI-compatible endpoint.

Spans: `langgraph.graph.invoke` (the run) and, beneath it, one `openai.chat.completion`
per node. The graph's `thread_id` is the `session.id` of all three. The graph span carries
the recursion limit as `gen_ai.agent.iteration_budget` and what the run consumed:
`gen_ai.agent.iteration_budget.consumed` (model calls) and
`gen_ai.agent.token_budget.consumed` (their tokens). The question and the answers are on
no span unless content capture is on.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock | **Yes, here and in CI**: `tests/e2e/framework-examples.test.ts` runs it as a child process against the built package, a mock OpenAI-compatible server and a local OTLP receiver, and checks the three spans |
| Run against a real model | **No.** Not run against Ollama or any provider from this repository |

## Run it

```bash
npm ci && npm run build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/langgraph/agent.mjs
```

| Variable | Default |
|---|---|
| `EXAMPLE_BASE_URL` | `http://localhost:11434/v1` (a local Ollama) |
| `EXAMPLE_CHAT_MODEL` | `qwen3.5:4b` |
| `EXAMPLE_API_KEY` | none needed for a local model |
| `EXAMPLE_SESSION_ID` | generated; printed as `session.id` |
