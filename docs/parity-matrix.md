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
| `withSession()` / `setSession()` | shipped | **Not present in Python.** Puts `session.id`, `gen_ai.conversation.id` and optionally `user.id` on every span in scope; an extractor still wins |
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
| `azure.ai.openai` | `openai` (`AzureOpenAI`) | **covered by `openai`** - the `AzureOpenAI` client is traced by the OpenAI instrumentor (`gen_ai.system = openai`, endpoint in `server.address`), which is also how the reference traces `openai.AzureOpenAI`. The reference's separate instrumentor targets the legacy `azure.ai.openai` client, which has no JavaScript counterpart (`@azure/openai` 2.x is a types companion) |
| `azure.ai.inference` | `@azure-rest/ai-inference` | not ported: a REST-path client with no method per operation, and not in the Node target list |
| `google.generativeai` | `@google/genai` | **shipped** - `generateContent`, `generateContentStream`, `embedContent` (one span per request to the model). The legacy `@google/generative-ai` package is end-of-life and not instrumented |
| `vertexai` | `@google-cloud/vertexai` | **shipped** - `GenerativeModel.generateContent`, as the reference. Vertex AI through `@google/genai` (`vertexai: true`) is traced by the `google.generativeai` instrumentor, as in the reference |
| `boto3` | `@aws-sdk/client-bedrock-runtime` | **shipped** - Converse, ConverseStream, InvokeModel, InvokeModelWithResponseStream, through `client.send()` and the aggregated client |
| `bedrock_agents` | `@aws-sdk/client-bedrock-agent-runtime` | planned, phase 2 |
| `cohere` | `cohere-ai` | **shipped** - `generate`, `embed` (as the reference), plus `chat` / `chatStream` on the v1 and v2 clients (**not present in Python**, which traces only the legacy `generate`) |
| `mistralai` | `@mistralai/mistralai` | **shipped** - `chat.complete`, `chat.stream`, `embeddings.create`. Span names carry the model, as in the reference |
| `groq` | `groq-sdk` | **shipped** - chat completions (buffered, streamed) |
| `together` | `together-ai` | **shipped** - chat completions, embeddings |
| `ollama` | `ollama` | **shipped** - `chat`, `generate` (buffered, streamed), `embed`, `embeddings`; token estimate when the server reports no counts. Server-metrics poller: phase 4 |
| `replicate` | `replicate` | planned, phase 2 |
| `elevenlabs` | `@elevenlabs/elevenlabs-js` | planned, phase 2 |
| `sarvamai` | `sarvamai` | planned, phase 2 - library to be confirmed |
| `openrouter` | `openai` at `openrouter.ai` | **shipped** - chat completions (buffered, streamed, tool calls), embeddings |
| `cometapi` | `openai` / `@anthropic-ai/sdk` at `cometapi.com` | **shipped** - chat completions, embeddings, `messages.create` |
| `hyperbolic` | `openai` at `api.hyperbolic.xyz` | **shipped** - chat completions. Not in the default list, as in the reference: enable it by name. The reference traces raw `requests.post`; JavaScript applications use the OpenAI client |
| `sambanova` | `openai` at `api.sambanova.ai` | **shipped** - chat completions. The reference patches the `sambanova` Python SDK; there is no maintained JavaScript one |
| `anyscale` | `openai` | **shipped** as the no-op it is in the reference; calls are traced by the `openai` instrumentor |
| `vllm`, `llamacpp` (server) | `openai` with a base URL | Traced by the `openai` instrumentor with the endpoint in `server.address`. Server-metrics pollers: phase 4 |
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

## Not present in Python

Additions fixed across all four SDKs by `contract/SDK_ADDITIONS.md`, so that they agree
with each other where the reference has nothing to agree with.

| Addition | Definition |
|---|---|
| Counter `gen_ai.usage.cost.pricing_missing` | unit `""`, meter `genai_otel.instrumentors.base`, attributes `model` and `call_type`. Incremented once per span whose model has no price, including the 13 pricing-table entries on which the calculator raises |
| `withSession(id, fn, { userId })`, `setSession(id, { userId })`, `currentSession()` | The reference has only the `session_id_extractor` / `user_id_extractor` callbacks (ported). These set `session.id` + `gen_ai.conversation.id` (+ `user.id`) on every span started in scope, from any instrumentation. Pending confirmation as a cross-SDK addition |
| Cohere `chat` / `chatStream` spans (`cohere.chat`) | The reference Cohere instrumentor wraps only `generate` and `embed`. `generate` is Cohere's legacy endpoint; without `chat` a current Cohere application produces no span. Pending confirmation as a cross-SDK addition |
| `telemetry.distro.name = genai-otel-instrument-node` | The reference emits `genai-otel-instrument`, with no suffix |

### JavaScript only: three runtimes

The reference is a server-side library. This package also loads in browsers and in React
Native (`docs/runtimes.md`), which the reference has no counterpart for.

| Item | Node | Browser | React Native |
|---|---|---|---|
| Core: config, cost, semconv, metric registry, base instrumentor | yes | yes | yes |
| `instrument()` | from the environment | explicit options, no default endpoint | explicit options, no default endpoint |
| Export | OTLP http/protobuf, gRPC | OTLP/HTTP JSON over `fetch` | OTLP/HTTP JSON over `fetch` |
| Provider instrumentation by module patching | yes | no | no |
| Manual span helper `traceGenAiCall()` | no (phase 2) | yes | yes |
| Resource host / process / OS attributes | yes | never collected | never collected |
| Flush | on exit, on SIGTERM | on page hide | on app background (`appState`) |
| On-device instrumentors (transformers.js, WebGPU, cactus) | n/a | not yet (phase 2/3) | not yet (phase 2/3) |

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
| `GENAI_CUSTOM_PRICING_JSON` (deliberate difference from Python v1.30.0, to be fixed upstream; `contract/SDK_ADDITIONS.md` section 3) | Ignored by 39 of the 42 instrumentor modules, OpenAI and Anthropic included: their `instrument()` never calls `_setup_config()`, so a custom-priced model is reported `unpriced` (`openai_instrumentor.py:80`, `anthropic_instrumentor.py:244`, `base.py:563`). Cost enrichment of other instrumentation's spans always uses the default table (`auto_instrument.py:381`) | Applied by **every** instrumentor and by the cost-enrichment processor, with the calculator's own merge and validation rules. A custom-priced model gets the `gen_ai.usage.cost.*` attributes and `pricing_source = table`, as the reference calculator reports for it | Founder decision, 2026-10-02: a setting that is accepted and then ignored is a wrong bill |
| Instrumentors the reference writes by hand (Groq, Hyperbolic, ...) | A hand-rolled span with a short attribute list, and request counters tagged `{model, provider}` | The same span name and attributes through the common wrapper, which also adds what it derives centrally (`server.address`, `server.port`, request parameters) and counts requests as every other instrumentor does (`{operation}`) | One code path for streams, cancellation, errors and leaks; a superset of the reference attributes |
| Aggregator instrumentors (OpenRouter, CometAPI, ...) | Patch the client constructor and wrap methods per instance | Wrap the client's class prototypes a second time and act only for a client whose base URL is the provider's | Same spans; also covers clients created before `instrument()` |
| Bedrock InvokeModel response body | Read as a string: boto3 returns a one-shot stream, so in practice the body, its usage and its text are not available to the instrumentor | The JavaScript client returns the body as bytes, which are parsed without disturbing the caller. Token counts are read under the spellings the model families use (`inputTokens`, `input_tokens`, `inputTextTokenCount`, `prompt_token_count`, invocation metrics) | A span with tokens and cost where the data is there to be read |
| Bedrock InvokeModelWithResponseStream | The span ends when the call returns, before the stream is read | The span stays open until the stream ends and takes usage from the invocation metrics on the final chunk | Same rule as every other stream |
| Instrumentation scope / tracer name | `genai_otel.instrumentors.base` | the same | A backend keys on it |
| `OTEL_METRICS_EXEMPLAR_FILTER` defaulted to `always_off` | yes | not needed: the JS SDK records no exemplars | |

## Reference behaviours ported as they are

Found while reading the reference at v1.30.0. Each looks unintended; each was ported as
it behaves, not as it reads, so that the two SDKs report the same thing. They are listed
here so that a fix upstream is a deliberate, synchronised change (bump the pinned tag,
regenerate the contract, adjust the port).

| # | Behaviour | Where |
|---|---|---|
| 1 | *(moved to "Deliberate differences": custom pricing is now honoured by every instrumentor)* | |
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
| 13 | *(moved to "Deliberate differences": cost enrichment now uses custom pricing)* | |
| 15 | A **streamed Responses API** call records no tokens and no cost: the usage arrives on the final `response.completed` event as `event.response.usage`, and usage is read only from `event.usage`. Read from the code of both implementations; not exercised by a test here | `openai_instrumentor.py:519`, `base.py:2447` |
| 14 | Under a hardened profile, an explicit `enable_content_capture=False` passed in code is overridden to true unless one of the two environment variables is also set | `config.py:534` |
