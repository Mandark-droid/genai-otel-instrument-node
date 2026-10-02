# Parity matrix

What this SDK does, against the Python reference `genai_otel_instrument` **v1.30.0**.
Every instrumentor id the reference accepts in `GENAI_ENABLED_INSTRUMENTORS` has a row.

Status values: **shipped** (tests, an example, a changelog line), **planned** with the
phase, or **not applicable** with the reason. Nothing is marked shipped that is not.

Last updated: phase 1 (foundation). Phases are those of the implementation plan:
2 providers, 3 frameworks and MCP / datastores, 4 GPU / energy / CO2, server metrics,
evaluation, media.

## Foundation

| Area | Status | Notes |
|---|---|---|
| Configuration from environment | shipped | Every variable, default and raw-value case in `contract/config.json` |
| Resource attributes and identity | shipped | Same attribute set as the reference; identity differs by design (`telemetry.sdk.language=nodejs`, `telemetry.distro.name=genai-otel-instrument-node`) |
| Cost calculator | shipped | All 2,545 vectors in `contract/cost_vectors.json`, bit for bit |
| Cost enrichment of spans from other instrumentation | shipped | One span processor (`onEnding`); the reference needs a processor plus an exporter wrapper |
| Semantic-convention names, `OTEL_SEMCONV_STABILITY_OPT_IN` | shipped | Generated from the contract; all 13 opt-in cases |
| GenAI client metrics (20 instruments) and histogram views | shipped | Name, unit, kind, description, scope and bucket boundaries from `contract/metrics.json` |
| OTLP export: http/protobuf, gRPC, console | shipped | gRPC selected by `OTEL_EXPORTER_OTLP_PROTOCOL` or port 4317; not exercised against a gRPC collector yet |
| Zero-code entry point | shipped | `node --require .../register` (CommonJS), `node --import .../register` (ES modules) |
| Sampling, W3C trace-context propagation, flush on exit / SIGTERM | shipped | |
| Session / user id extractors | shipped | Programmatic only, as in the reference |
| Agent budget accounting (`gen_ai.agent.token_budget*`) | planned, phase 3 | Arrives with the agent frameworks |
| Server concurrency gauge (`GENAI_ENABLE_CONCURRENCY_METRICS`) | planned, phase 4 | |
| GPU, energy, CO2 metrics | planned, phase 4 | |
| Evaluation (PII, toxicity, bias, prompt injection, restricted topics, hallucination) and pre-call blocking | planned, phase 4 | |
| Multimodal content capture and offload | planned, phase 4 | |
| Anonymous usage reporting (`TRACEVERDE_TELEMETRY`) | not applicable | This SDK makes no call home |

## Providers

| Reference id | Node library | Status |
|---|---|---|
| `openai` | `openai` | **shipped** - Chat Completions (buffered, streamed, tool calls), Embeddings, Responses API |
| `anthropic` | `@anthropic-ai/sdk` | **shipped** - `messages.create` (buffered, streamed), `messages.stream()` |
| `azure.ai.openai` | `openai` (`AzureOpenAI`) | planned, phase 2. `AzureOpenAI` calls are already traced by the `openai` instrumentor, as `gen_ai.system = openai`; the dedicated span name and provider value are not ported yet |
| `azure.ai.inference` | `@azure-rest/ai-inference` | planned, phase 2 |
| `google.generativeai` | `@google/genai` | planned, phase 2 |
| `vertexai` | `@google/genai` (Vertex mode) / `@google-cloud/vertexai` | planned, phase 2 |
| `boto3` | `@aws-sdk/client-bedrock-runtime` | planned, phase 2 |
| `bedrock_agents` | `@aws-sdk/client-bedrock-agent-runtime` | planned, phase 2 |
| `cohere` | `cohere-ai` | planned, phase 2 |
| `mistralai` | `@mistralai/mistralai` | planned, phase 2 |
| `groq` | `groq-sdk` | planned, phase 2 |
| `together` | `together-ai` | planned, phase 2 |
| `ollama` | `ollama` | planned, phase 2 |
| `replicate` | `replicate` | planned, phase 2 |
| `elevenlabs` | `@elevenlabs/elevenlabs-js` | planned, phase 2 |
| `sarvamai` | `sarvamai` | planned, phase 2 - library to be confirmed |
| `openrouter` | `openai` with a base URL | planned, phase 2. The base-URL claim mechanism it needs is shipped |
| `cometapi` | `openai` / `@anthropic-ai/sdk` with a base URL | planned, phase 2 |
| `anyscale`, `sambanova`, `hyperbolic`, `vllm`, `llamacpp` (server) | `openai` with a base URL | Calls are traced today by the `openai` instrumentor with the endpoint in `server.address`; the provider-specific span names and server-metrics pollers are planned, phase 2 / 4 |
| `transformers` | `@huggingface/inference`, `@huggingface/transformers` | planned, phase 2 |
| `litellm_latency`, `litellm` | - | not applicable: LiteLLM is a Python library. A LiteLLM *gateway* is reached through the `openai` client and is traced by the `openai` instrumentor |
| `llamacpp` (in-process), `vllm` (in-process) | - | not applicable: Python in-process bindings |
| `sentence_transformers` | - | not applicable: Python-only library |
| `liquid_audio` | - | not applicable: Python-only library |

## Frameworks

| Reference id | Node library | Status |
|---|---|---|
| `langchain` | `langchain` / `@langchain/core` | planned, phase 3 |
| `langgraph` | `@langchain/langgraph` | planned, phase 3 |
| `llama_index` | `llamaindex` | planned, phase 3 |
| `openai_agents`, `agents` | `@openai/agents` | planned, phase 3 |
| `google_adk` | `@google/adk` | planned, phase 3 - library to be confirmed |
| `mcp_client`, `mcp` | `@modelcontextprotocol/sdk` | planned, phase 3 |
| `autogen`, `autogen_agentchat` | - | not applicable: no maintained JavaScript port of AutoGen |
| `crewai` | - | not applicable: Python-only |
| `dspy` | - | not applicable: Python-only |
| `haystack` | - | not applicable: Python-only |
| `instructor` | `@instructor-ai/instructor` | planned, phase 3 - maintenance status to be confirmed |
| `guardrails` | - | not applicable: Python-only |
| `pydantic_ai` | - | not applicable: Python-only |
| `smolagents` | - | not applicable: Python-only |
| `strands` | `@strands-agents/sdk` | planned, phase 3 - library to be confirmed |
| `typesafe` | - | to be confirmed in phase 2: no JavaScript client known |
| - | Vercel AI SDK (`ai`), Mastra | planned, phase 3 (Node-only additions named in the design) |

A name from the reference list that is not shipped here is skipped at start-up. When it
was requested explicitly (`GENAI_ENABLED_INSTRUMENTORS` or the `enabledInstrumentors`
option) a warning says so; with the default list it is logged at debug level.

## Deliberate differences from the reference

These are choices, each with a reason. Everything else is meant to be identical.

| Behaviour | Reference | This SDK | Why |
|---|---|---|---|
| Cost of a model with no price | `calculate_cost()` returns `0.0`; the span gets no cost attribute and `pricing_source = unpriced` | `calculateCost()` returns `null`; same span attributes; **plus** the counter `gen_ai.usage.cost.pricing_missing` | A zero that means "not measured" must not be summed as "free". The span is the same; the counter makes the gap visible |
| A stream the consumer stops reading (`break`, abort) | Span closed with status OK and whatever was measured | Span closed with status **ERROR** (`stream cancelled before completion`), the tokens seen, **no cost**; `gen_ai.client.errors{error_type=StreamCancelled}` | Review focus 2 of the implementation plan. A partial cost is not a measurement |
| A stream that fails part-way | Span ERROR; tokens seen are dropped | Span ERROR; tokens seen are kept; no cost | Same |
| A result nobody consumes (stream never iterated, promise never awaited) | Span is never ended | Span ended when the object is garbage collected | No leaked open spans |
| `host.id`, `process.owner` on the resource | Not emitted | Not emitted (the Node detectors would add them; they are removed) | Same attribute set; no machine identifier or OS user name leaves the host |
| `null` / `undefined` request parameters | `None` is written as the string `"None"` | The attribute is left out | An explicit `undefined` is routine in JavaScript and would put `"undefined"` on every span |
| Instrumentation scope / tracer name | `genai_otel.instrumentors.base` | the same | A backend keys on it |
| `OTEL_METRICS_EXEMPLAR_FILTER` defaulted to `always_off` | yes | not needed: the JS SDK records no exemplars | |

## Reference behaviours ported as they are

Found while reading the reference at v1.30.0. Each looks unintended; each was ported as
it behaves, not as it reads, so that the two SDKs report the same thing. They are listed
here so that a fix upstream is a deliberate, synchronised change (bump the pinned tag,
regenerate the contract, adjust the port).

| # | Behaviour | Where |
|---|---|---|
| 1 | **`GENAI_CUSTOM_PRICING_JSON` is ignored by the OpenAI and Anthropic instrumentors** (and by 39 of the 42 reference instrumentor modules): their `instrument()` assigns `self.config` and never calls `_setup_config()`, so they keep the default-priced calculator. A custom-priced model is reported `unpriced`. Verified by running the reference | `instrumentors/openai_instrumentor.py:80`, `anthropic_instrumentor.py:244`, `base.py:563` |
| 2 | **Anthropic spans have no `gen_ai.operation.name`**, no response id / model, no finish reason and no tool-call attributes. A backend that selects single model calls by `gen_ai.operation.name` does not see them | `anthropic_instrumentor.py:395` |
| 3 | `anthropic.messages.stream` is not counted in `gen_ai.requests`, and gets no `server.address` or request-parameter attributes; `anthropic.messages.create` gets all of them | `anthropic_instrumentor.py:353` |
| 4 | A list-valued request attribute is written as the Python `str()` of the list: `gen_ai.request.encoding_formats = "['float']"` (a string), not an array | `base.py:813-816`; confirmed by `contract/semconv.json` `span_emission` |
| 5 | Spans are created with the default kind (INTERNAL), not CLIENT. (The reference's separate `AsyncOpenAI` wrapper does use CLIENT - see 8) | `base.py:840` |
| 6 | The streaming path records the token histograms and the granular cost counters unconditionally; the buffered path only under `GENAI_METRICS_PROFILE=full`. A streamed span also gets no response id / model, finish reason, cache / reasoning token attributes or deprecation flag | `base.py:2413-2580` vs `1376-1740` |
| 7 | Only chat spans get `gen_ai.usage.cost.pricing_source`; an embedding, image or audio span whose model has no price is indistinguishable from a free one on the span. Separately, `pricing_source()` uses the call type as a pricing-table section name, so for `embedding` and `image` it consults the **chat** table | `base.py:1592-1679`, `cost_calculator.py:330` |
| 8 | The reference's `AsyncOpenAI` path is a second, divergent wrapper: span kind CLIENT, an extra `gen_ai.latency` attribute, no `gen_ai.provider.name`, no `server.*` or request-parameter attributes, no request or error counters - and it **puts the prompt and the response text on the span even when content capture is off** (verified by running the reference with `enable_content_capture=False`). This SDK follows the common wrapper (`create_span_wrapper`) for every call and does not reproduce that path; in particular it never captures content with capture off | `openai_instrumentor.py:213-297` |
| 9 | 13 pricing-table entries cannot be priced: 9 embedding models whose price is an object rather than a number, 4 image models whose quality value is a number rather than an object. The calculator raises `TypeError`; the instrumentor logs it and records no cost | `contract/cost_vectors.json`, the vectors with `error` |
| 10 | A usage detail that is present but null (`completion_tokens_details.reasoning_tokens: null`) makes the cost calculation raise; the span then has tokens and no cost | `cost_calculator.py:495`, `openai_instrumentor.py:565` |
| 11 | `OTEL_EXPORTER_OTLP_TIMEOUT` is read as seconds; the OpenTelemetry specification defines milliseconds | `config.py:141` |
| 12 | Floating-point seconds are recorded into `gen_ai.server.time_to_first_token` and `gen_ai.server.time_per_output_token` histograms that keep the SDK default bucket boundaries (0, 5, 10, ... 10000), so almost every value lands in the first bucket. `gen_ai.server.ttft` / `.tbt` have proper boundaries | `auto_instrument.py:263`, `contract/metrics.json` |
| 13 | Cost enrichment of spans from other instrumentation always uses the default-priced calculator, never custom pricing | `auto_instrument.py:381` |
| 14 | Under a hardened profile, an explicit `enable_content_capture=False` passed in code is overridden to true unless one of the two environment variables is also set | `config.py:534` |
