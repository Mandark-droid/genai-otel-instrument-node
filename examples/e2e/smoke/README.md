# End-to-end smoke

One chat call through an OpenAI-compatible endpoint, traced by this SDK, exported over
OTLP. It is the phase 1 check that the platform ingests what this SDK emits before any
more instrumentors are built on the same wire format.

## Status

| | |
|---|---|
| Run against a local mock model server and a local OTLP receiver | **Yes** - `tests/e2e/smoke.test.ts` runs this very script as a child process against the built package and asserts on the OTLP bytes the receiver got |
| Run against an OTLP backend (an OpenAI-compatible gateway and a collector) | **Not yet.** Nothing here has been verified against a live backend yet. |

## Run it

```bash
npm ci && npm run build

E2E_LLM_MODEL=<a model the endpoint serves> \
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector-host>:4318 \
node examples/e2e/smoke/smoke.mjs
```

| Variable | Required | Meaning |
|---|---|---|
| `E2E_LLM_MODEL` | yes | Model name to request |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes | Collector endpoint. Port 4318 is OTLP/HTTP, 4317 is gRPC |
| `E2E_LLM_BASE_URL` | no | OpenAI-compatible base URL, including `/v1`. Defaults to a local Ollama, `http://localhost:11434/v1` |
| `E2E_LLM_API_KEY` | no | Sent as the bearer token. Ollama needs none; a placeholder is sent |
| `OTEL_SERVICE_NAME` | no | Defaults to `genai-sdk-e2e-node` |
| `E2E_PROMPT` | no | The user message |

It prints one JSON document - the SDK's own measurement of the call - and exits `0` (call
made, telemetry accepted), `1` (the call failed) or `2` (call made, telemetry not
accepted).

## What to check on the platform afterwards

The JSON gives the `trace_id`, the token counts and `sdk_cost_usd`. On the platform, for
`service.name = genai-sdk-e2e-node`:

1. The span `openai.chat.completion` is in the span store, with
   `telemetry.sdk.language = nodejs` and `telemetry.distro.name = genai-otel-instrument-node`
   on the process / resource.
2. The typed token fields exist after `genai-ingest-pipeline`, with the same counts.
3. The backend shows one session for the trace.
4. The platform's cost equals `sdk_cost_usd`. If `sdk_cost_usd` is `null` the model has no
   price in the shipped table; the span then has no cost attribute and
   `gen_ai.usage.cost.pricing_source = unpriced`, and the platform must show the cost as
   unknown, not as 0.
5. The service is visible in the UI.

Save the JSON and the platform evidence under `docs/e2e/<date>/smoke/`. A stage that could
not be exercised is recorded as not exercised, with the reason.
