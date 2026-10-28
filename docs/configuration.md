# Configuration

Configuration is read from the environment, with the **same variables, defaults and
parsing as the Python library** `genai_otel_instrument` v1.46.0. The authoritative list,
with the value produced for every raw input, is `contract/config.json`; the contract test
checks this SDK against all of it.

Options passed to `instrument({...})` override the environment. Option names are the
camelCase form of the Python `OTelConfig` field (`service_name` -> `serviceName`).

## Parsing rules worth knowing

They are the Python library's, kept on purpose so one configuration behaves the same in
both languages:

- **Booleans** are true only for `true` in any letter case. `1`, `yes`, `on` are false,
  and a leading or trailing space makes the value false. Two variables strip whitespace
  first: `GENAI_ENABLE_CONTENT_CAPTURE` and `GENAI_CAPTURE_EMBEDDING_VECTORS`.
- **Numbers** that do not parse are an error, not a silent default. With
  `GENAI_SAMPLING_RATE=abc`, `instrument()` logs the reason and leaves the application
  uninstrumented; with `GENAI_FAIL_ON_ERROR=true` it throws. The one exception is
  `OTEL_EXPORTER_OTLP_TIMEOUT`, which falls back to 60 with a warning.
- **`OTEL_EXPORTER_OTLP_TIMEOUT` is in seconds**, as in the Python library, although the
  OpenTelemetry specification defines it in milliseconds. This SDK passes it to the
  exporters explicitly so they do not read it as milliseconds.
- A variable that is **set but empty** stays empty; it does not fall back to the default.
  `OTEL_EXPORTER_OTLP_ENDPOINT=` therefore selects the console exporters.
- `GENAI_ENABLED_INSTRUMENTORS` is split on commas and each name trimmed. Empty means the
  default list. A name this SDK has not ported is reported in the log.

## Start-up cost

On Node 20 and later, `instrument()` loads no CommonJS client library in order to patch it:
a library is patched when the application loads it (`require`, or an `import` of a
CommonJS package), or at once if it already has. An application does not pay for
libraries it has installed and does not use.

ES-module builds cannot be watched that way. In an **ES-module application** the
ES-module build of every installed client library is imported; the ones the application
already imports cost nothing more, the others are loaded. In a **CommonJS application**
the ES-module builds are not touched: a library reached only through a dynamic `import()`
is not traced there.

Measured on the development machine with all 38 client libraries of this repository
installed (none used), Node 24: CommonJS application, `instrument()` 40 ms; ES-module
application, 2.3 s in `instrument()` and 1.1 s more until `instrumentorsReady()`. An
application with a handful of libraries installed pays a small fraction of that. To pay
nothing for libraries that are installed but unused, name the ones in use
(`GENAI_ENABLED_INSTRUMENTORS=openai,anthropic`) and switch datastore instrumentation off
if it is not wanted (`GENAI_ENABLE_MCP_INSTRUMENTATION=false`).

On **Node 18** every installed library is loaded at `instrument()`, both builds, as
before: an ES-module import of a library that cannot run on Node 18 (anything on `undici`
7) ends the process there unless its CommonJS load is tried first.

## Variables in effect in this version

| Variable | Default | Notes |
|---|---|---|
| `OTEL_SERVICE_NAME` | `genai-app` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Empty: console exporters |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | by port | `grpc`, otherwise http/protobuf. Unset: port 4317 means gRPC |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `60` | Seconds |
| `OTEL_EXPORTER_OTLP_HEADERS` | | Read by the exporters themselves |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Milliseconds |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | `gen_ai/dup` | `gen_ai` emits current attribute names only |
| `OTEL_ENVIRONMENT` | | Sets `deployment.environment.name` (and legacy `environment`) |
| `OTEL_SERVICE_INSTANCE_ID` | | Wins over the generated instance id |
| `OTEL_RESOURCE_ATTRIBUTES` | | Standard; an explicit `service.instance.id` here is respected |
| `OTEL_EXPERIMENTAL_RESOURCE_DETECTORS` | `host,os` | Add `process` for the process attributes (opt-in since the reference's v1.46.0). `host.id` is included |
| `GENAI_OTEL_RESOURCE_HOST_IP` | off | `1`, `true`, `yes` or `on` adds `host.ip` |
| `GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES` | `true` | `graph.node.*` and `agent.name` on agent spans and LangGraph node spans; only `true` (any case) turns it on |
| `GENAI_ENABLE_SESSION_PROPAGATION` | `true` | A span without a session takes its parent span's `session.id` / `user.id` (and an OpenInference `setSession()` / `setUser()`); `false` keeps only explicit sessions |
| `GENAI_SESSION_BAGGAGE_KEYS` / `GENAI_SESSION_BAGGAGE_ACCEPT` | empty | Comma lists of `session.id`, `user.id`: which ids a service sends to, and accepts from, other services as W3C baggage. Off by default: an id crosses a service boundary only when both sides opt in. Node only |
| `GENAI_EVALUATION_CACHE_SIZE` | `256` | Results each detector keeps for repeated text (keyed by a digest, never the text); `0` turns caching off |
| `GENAI_TOXICITY_QUANTIZE`, `GENAI_TOXICITY_TORCH_THREADS` | `false`, unset | Passed to the toxicity detector's model settings |
| `GENAI_SERVICE_INSTANCE_ID_MODE` | `random` | `derived`: a v5 UUID stable across restarts |
| `GENAI_ENABLED_INSTRUMENTORS` | reference list | See `docs/parity-matrix.md` |
| `GENAI_ENABLE_COST_TRACKING` | `true` | |
| `GENAI_MCP_HASH_SALT` | | Salt for hashed user identifiers on MCP spans. Unset: a random per-process salt, with a warning; hashes then do not match across processes |
| `GENAI_ENABLE_HTTP_INSTRUMENTATION` | `false` | A span per outbound `fetch` call (`api.call.<method>.<host>`). Off by default: every provider client already has a span, and its requests go through `fetch` too |
| `GENAI_ENABLE_MCP_INSTRUMENTATION` | `true` | Datastore and tool instrumentation: one client span and the `mcp.*` metrics per operation. `db.statement` only with content capture on |
| `GENAI_CUSTOM_PRICING_JSON` | | Same shape as the pricing table; merged over it. Applied by every instrumentor and by the cost-enrichment processor (the Python library v1.30.0 ignores it in most instrumentors) |
| `GENAI_ENABLE_CONTENT_CAPTURE` | `false` | |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | | `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, `SPAN_AND_EVENT`; wins over the line above |
| `GENAI_CONTENT_MAX_LENGTH` | `200` | `0`: no limit |
| `GENAI_CAPTURE_EMBEDDING_VECTORS` | `false` | |
| `GENAI_SAMPLING_RATE` | `1.0` | Below 1.0: sampling by trace-id ratio |
| `GENAI_METRICS_PROFILE` | `standard` | `full` also records token histograms, granular cost and finish counters |
| `GENAI_RECORD_TOKEN_HISTOGRAMS`, `GENAI_RECORD_GRANULAR_COST_METRICS`, `GENAI_RECORD_FINISH_METRICS` | off | Individual switches for the above |
| `GENAI_PROFILE` | | `strict`, `bfsi`, `bank`: no external egress, air-gapped, audit content capture on |
| `GENAI_FAIL_ON_ERROR` | `false` | |
| `GENAI_FLUSH_ON_SIGTERM` | `false` | With `GENAI_SIGTERM_FLUSH_TIMEOUT` (default `5.0` seconds) |
| `GENAI_SKIP_COLLECTOR_CHECK` | `false` | Silences the "no collector on the default endpoint" warning |
| `GENAI_OTEL_LOG_LEVEL` | | `DEBUG`, `INFO`, `WARNING`, `ERROR`. Unset: warnings and errors. `OTEL_LOG_LEVEL` is the fallback |
| `GENAI_ENABLE_PII_DETECTION` | `false` | With `GENAI_PII_MODE` (`detect`, `redact`, `block`), `GENAI_PII_THRESHOLD` (not used by the pattern detector), `GENAI_PII_GDPR_MODE`, `GENAI_PII_HIPAA_MODE`, `GENAI_PII_PCI_DSS_MODE`. See [evaluation.md](evaluation.md) |
| `GENAI_ENABLE_PROMPT_INJECTION_DETECTION` | `false` | `GENAI_PROMPT_INJECTION_THRESHOLD` `0.5`, `GENAI_PROMPT_INJECTION_BLOCK_ON_DETECTION` |
| `GENAI_ENABLE_BIAS_DETECTION` | `false` | `GENAI_BIAS_THRESHOLD` `0.4`, `GENAI_BIAS_BLOCK_ON_DETECTION` |
| `GENAI_ENABLE_RESTRICTED_TOPICS` | `false` | `GENAI_RESTRICTED_TOPICS_THRESHOLD` `0.7`, `GENAI_RESTRICTED_TOPICS_BLOCK_ON_DETECTION` |
| `GENAI_ENABLE_HALLUCINATION_DETECTION` | `false` | `GENAI_HALLUCINATION_THRESHOLD` `0.6` |
| `GENAI_ENABLE_TOXICITY_DETECTION` | `false` | `GENAI_TOXICITY_THRESHOLD` `0.7`, `GENAI_TOXICITY_BLOCK_ON_DETECTION`. In effect once something measures it: a scorer given in code (`setToxicityScorer`), else the on-prem judge at `GENAI_TOXICITY_JUDGE_URL`, else a local ONNX model at `GENAI_TOXICITY_ONNX_MODEL` through the optional add-on `genai-otel-instrument-node-onnx` (see [evaluation.md](evaluation.md)); until then nothing about toxicity is written. `GENAI_TOXICITY_USE_PERSPECTIVE_API` is read and has no effect: no Perspective client ships |
| `GENAI_OTEL_MEDIA_CAPTURE_MODE` and the other `GENAI_OTEL_MEDIA_*` | `off` | Multimodal capture; see [media.md](media.md) |
| `GENAI_ENABLE_GPU_METRICS` | `true` | NVIDIA, through `nvidia-smi`, every `GENAI_GPU_COLLECTION_INTERVAL` seconds (default `5`). No `nvidia-smi` or no device: nothing is created, one log line. See [gpu-energy.md](gpu-energy.md) |
| `GENAI_POWER_COST_PER_KWH` | `0.12` | USD; `gen_ai.power.cost` is measured GPU energy times this |
| `GENAI_ENABLE_CO2_TRACKING` | `false` | `gen_ai.co2.emissions` is measured GPU energy times `GENAI_CARBON_INTENSITY` (default `475.0` gCO2e/kWh, a world average - set the grid's own figure). Needs GPU metrics |
| `GENAI_ENABLE_OLLAMA_SERVER_METRICS` | `true` | With the Ollama instrumentor active: polls `OLLAMA_BASE_URL` (default `http://localhost:11434`) `/api/ps` every `GENAI_OLLAMA_METRICS_INTERVAL` seconds (default `5.0`) for the loaded models. `GENAI_OLLAMA_MAX_VRAM_GB`: the GPU's VRAM, needed for the per-model share; detected with `nvidia-smi` when unset, and not reported when neither is available. These four are read from the environment only, as in the Python library. Every poll replaces what Ollama reported: a model that unloads is no longer reported |
| `GENAI_SERVER_METRICS_ENDPOINTS` | unset | Comma-separated vLLM / llama.cpp base URLs (http or https). Each `/metrics` is polled every 5 s: KV-cache usage per model, waiting requests, and from vLLM the prefix-cache counters (`gen_ai.server.prefix_cache.queries` / `.hits`, cumulative, in tokens). Not in the Python library (SDK_ADDITIONS.md sections 12, 13); read from the environment only |
| `GENAI_ENABLE_CONCURRENCY_METRICS` | `true` | Count this SDK's own model calls in flight as `gen_ai.server.requests.running{server_metrics_source="client"}`. The Python library parses it and never reads it |

## Read and parsed, not in effect yet

These are parsed exactly as the Python library parses them, so a shared configuration
loads cleanly, but the feature behind them arrives in a later phase. Enabling one is
reported in the log at start-up; it is never silently ignored.

| Variables | Feature | Phase |
|---|---|---|
| `GENAI_CO2_COUNTRY_ISO_CODE`, `GENAI_CO2_REGION`, `GENAI_CO2_CLOUD_PROVIDER`, `GENAI_CO2_CLOUD_REGION`, `GENAI_CO2_OFFLINE_MODE`, `GENAI_CO2_TRACKING_MODE`, `GENAI_CO2_USE_MANUAL`, `GENAI_CODECARBON_LOG_LEVEL` | codecarbon's location and mode settings. There is no codecarbon here: CO2 is energy times `GENAI_CARBON_INTENSITY` | - |
| `GENAI_ENABLE_CONCURRENCY_METRICS` | Read by the Python library's configuration and used by nothing there either | - |
| `GENAI_EVALUATION_MODE`, `GENAI_EVALUATION_QUEUE_SIZE`, `GENAI_EVALUATION_MAX_CHARS`, `GENAI_TOXICITY_MAX_CHARS`, `GENAI_EVALUATION_SHUTDOWN_TIMEOUT` | Background evaluation (Python 1.36.0): detectors run off the request path from a bounded queue. Here they still run inline | later |
| `GENAI_DECISION_HTTP_MATCHER`, `GENAI_DECISION_LEGACY_LLM_KIND`, `GENAI_DECISION_PROVIDER` | Decision spans from HTTP decision services (Python 1.38.0). Decision *pricing* is in effect: a span with `gen_ai.request.type = decision` is priced | later |

Variables the Python library reads that this SDK does not, and why, are listed in
`tests/contract/config.contract.test.ts` (`NOT_READ`). The test fails if a future
contract adds a variable that is in neither list.
