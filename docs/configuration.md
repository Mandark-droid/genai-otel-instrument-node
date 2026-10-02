# Configuration

Configuration is read from the environment, with the **same variables, defaults and
parsing as the Python library** `genai_otel_instrument` v1.30.0. The authoritative list,
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
| `OTEL_EXPERIMENTAL_RESOURCE_DETECTORS` | `host,os,process` | `host,os` under a hardened profile |
| `GENAI_SERVICE_INSTANCE_ID_MODE` | `random` | `derived`: a v5 UUID stable across restarts |
| `GENAI_ENABLED_INSTRUMENTORS` | reference list | See `docs/parity-matrix.md` |
| `GENAI_ENABLE_COST_TRACKING` | `true` | |
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

## Read and parsed, not in effect yet

These are parsed exactly as the Python library parses them, so a shared configuration
loads cleanly, but the feature behind them arrives in a later phase. Enabling one is
reported in the log at start-up; it is never silently ignored.

| Variables | Feature | Phase |
|---|---|---|
| `GENAI_ENABLE_GPU_METRICS`, `GENAI_GPU_COLLECTION_INTERVAL`, `GENAI_POWER_COST_PER_KWH` | GPU metrics | 4 |
| `GENAI_ENABLE_CO2_TRACKING`, `GENAI_CARBON_INTENSITY`, `GENAI_CO2_*`, `GENAI_CODECARBON_LOG_LEVEL` | Energy and CO2 | 4 |
| `GENAI_ENABLE_PII_DETECTION`, `GENAI_PII_*`, `GENAI_ENABLE_TOXICITY_DETECTION`, `GENAI_TOXICITY_*`, `GENAI_ENABLE_BIAS_DETECTION`, `GENAI_BIAS_*`, `GENAI_ENABLE_PROMPT_INJECTION_DETECTION`, `GENAI_PROMPT_INJECTION_*`, `GENAI_ENABLE_RESTRICTED_TOPICS`, `GENAI_RESTRICTED_TOPICS_*`, `GENAI_ENABLE_HALLUCINATION_DETECTION`, `GENAI_HALLUCINATION_THRESHOLD` | Evaluation | 4 |
| `GENAI_OTEL_MEDIA_*` | Multimodal capture | 4 |
| `GENAI_ENABLE_HTTP_INSTRUMENTATION` | HTTP instrumentor | 3 |
| `GENAI_ENABLE_CONCURRENCY_METRICS` | Server concurrency gauge | 4 |

Variables the Python library reads that this SDK does not, and why, are listed in
`tests/contract/config.contract.test.ts` (`NOT_READ`). The test fails if a future
contract adds a variable that is in neither list.
