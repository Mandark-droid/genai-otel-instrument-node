# Full end-to-end run

Every kind of telemetry this SDK produces for a model application, in **one session and
one trace**: chat, streaming, tool calls, embeddings, a framework (LangGraph), a datastore
or tool call, and one prompt for each evaluation detector.

The datastore step is, by default, an HTTP call to the model server's own API (`GET
/api/tags` on Ollama), traced by the fetch instrumentor: no datastore server was running
on the machine this was written on, and the run must not depend on one. With a Qdrant
reachable, `E2E_DATASTORE=qdrant` uses the Qdrant instrumentor instead.

## Status

| | |
|---|---|
| Against mocks | **Yes, here and in CI.** `tests/e2e/full.test.ts` runs this script as a child process against the built package, a mock model server, a mock Qdrant and a local OTLP receiver, and asserts on the OTLP bytes: one session, one trace, the spans of every step, each detector's attributes, the metrics |
| Against a real model | **Yes, on the development machine**: a local Ollama with `qwen3.5:4b` and `embeddinggemma:300m`. Every model step ran, the tool was called, and the five rule-based detectors fired. There was **no collector** in those runs: nothing was exported. No Qdrant either: the Qdrant variant is tested against a mock only |
| Against an OTLP backend | **No.** That is the lead's run. Nothing here has been verified on the platform |

## Run it

```bash
npm ci && npm run build
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector-host>:4318 node examples/e2e/full/full.mjs > full.json
```

| Variable | Default | |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **required** | Port 4318 is OTLP/HTTP, 4317 is gRPC |
| `OTEL_SERVICE_NAME` | `genai-sdk-e2e-node` | |
| `E2E_LLM_BASE_URL` | `http://localhost:11434/v1` | Any OpenAI-compatible endpoint, including `/v1` |
| `E2E_LLM_MODEL` | `qwen3.5:4b` | Chat, streaming, tools, the framework and the detector prompts |
| `E2E_EMBEDDING_MODEL` | `embeddinggemma:300m` | |
| `E2E_LLM_API_KEY` | a placeholder | Ollama needs none |
| `E2E_MAX_TOKENS` | `1024` | Per call. Generous on purpose: a reasoning model spends tokens thinking first, and with a small limit its answer comes back empty |
| `E2E_SESSION_ID` | `genai-sdk-e2e-node-<12 random hex characters>` | Printed on stderr as `session.id: ...` and in the JSON as `session_id` |
| `E2E_DATASTORE` | `http` | `http`: GET `/api/tags` on the model server, traced by the fetch instrumentor (switched on by the script); `qdrant`: the Qdrant instrumentor; `none`: skipped |
| `E2E_QDRANT_URL` | `http://localhost:6333` | With `E2E_DATASTORE=qdrant`. The collection `E2E_QDRANT_COLLECTION` (default `genai-sdk-e2e-node`) is created if missing and one point is upserted |

The five rule-based detectors are switched on by the script (`GENAI_ENABLE_*`), none of
them blocking. Two thresholds are lowered so that one match trips the detector:
`GENAI_RESTRICTED_TOPICS_THRESHOLD=0.5` (environment default 0.7) and
`GENAI_HALLUCINATION_THRESHOLD=0.4` (default 0.6). Set either variable yourself to
override. Content capture is left off: the prompts are evaluated and not recorded.

With the defaults the run takes a minute or two on a local `qwen3.5:4b` and uses a few
thousand output tokens, most of them reasoning.

## Steps

| Step | Spans it produces | Notes |
|---|---|---|
| `chat` | `openai.chat.completion` | |
| `streaming` | `openai.chat.completion` | usage from the final chunk (`stream_options.include_usage`) |
| `tool_calls` | two `openai.chat.completion` | the model asks for `get_weather`; a canned result is returned; the model answers. A model that answers without calling the tool makes this step `not_exercised` |
| `embeddings` | `openai.embeddings` | |
| `framework_langgraph` | `langgraph.graph.invoke` over two `openai.chat.completion` | the graph span carries the calls and tokens the run consumed |
| `datastore` | `api.call.get.<host>` (default), or `qdrant.query_points` | HTTP: the model server's `/api/tags`. Qdrant: searches with the vector from the embeddings step; Qdrant unreachable: `not_exercised`, with the reason |
| `detector_pii` | `openai.chat.completion` | an email address and a card number in the prompt |
| `detector_prompt_injection` | `openai.chat.completion` | "Ignore all previous instructions ..." |
| `detector_bias` | `openai.chat.completion` | |
| `detector_restricted_topics` | `openai.chat.completion` | a legal-advice question |
| `detector_hallucination` | `openai.chat.completion` | reads the **response**: the model is asked to repeat a sentence with two specific claims and no citation. Whether it fires depends on the model doing so |
| `detector_toxicity` | none | always `not_exercised`: toxicity has no rules, and this script configures no scorer. Nothing about toxicity is written, on purpose |

Every step runs inside its own `e2e.step.<name>` span under the root span `e2e.full`. A
step that throws is recorded as `failed` and the run continues.

## Output

stdout is one JSON document:

```json
{
  "service_name": "genai-sdk-e2e-node",
  "session_id": "genai-sdk-e2e-node-3f9c1a7be204",
  "trace_id": "…32 hex…",
  "steps": [
    { "name": "chat", "status": "ok", "detail": { "answer": "pong", "model_calls": 1, "input_tokens": 17, "output_tokens": 108, "evaluation": { "…": "…" } } },
    { "name": "datastore_qdrant", "status": "not_exercised", "reason": "E2E_DATASTORE=none" }
  ],
  "totals": { "model_calls": 12, "input_tokens": 915, "output_tokens": 5956, "cost_usd": 0.0038 },
  "telemetry_flushed": true
}
```

`detail.evaluation` holds the `evaluation.*` attributes the SDK wrote on the model-call
spans of that step. `totals.cost_usd` is `null` when the model has no price in the shipped
table: the spans then carry no cost attribute, and the platform must show the cost as
unknown, not as 0.

Exit status: `0` no step failed and the telemetry was accepted; `1` a step failed; `2` the
telemetry was not accepted by the collector; `64` the collector endpoint was not given.

## What to check on the platform afterwards

For `service.name = genai-sdk-e2e-node` and the printed `session_id`:

1. **Ingested.** Every span of the trace is in the span store: the root, twelve
   step spans, the model calls, the graph, the datastore call. `telemetry.sdk.language = nodejs`.
2. **Sessions.** One session with the printed id, holding all of them.
3. **Tokens and cost.** The typed token fields equal `totals.input_tokens` /
   `totals.output_tokens`; the cost equals `totals.cost_usd`, or is shown as unknown when
   that is `null`.
4. **Evaluated.** The `evaluation.*` attributes of each detector step, as in
   `detail.evaluation`; no `evaluation.toxicity.*` attribute anywhere.
5. **Metrics.** `gen_ai.requests`, `gen_ai.client.token.usage`,
   `genai.evaluation.*.detections`, `mcp.requests`; GPU metrics only if the host running
   this script has an NVIDIA GPU, otherwise recorded as not exercised.

Save the JSON and the platform evidence under `docs/e2e/<date>/full/`. A stage that could
not be exercised is recorded as not exercised, with the reason.
