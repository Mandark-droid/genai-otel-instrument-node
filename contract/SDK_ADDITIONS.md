# Cross-SDK additions (not present in Python v1.30.0)

Decided by the lead so all four SDKs agree. Not in `MANIFEST.json`; not generated.
Each SDK lists these in its parity matrix as "not present in Python".

## 1. Pricing-missing counter

| | |
|---|---|
| Name | `gen_ai.usage.cost.pricing_missing` |
| Kind | counter |
| Unit | `""` |
| Meter | `genai_otel.instrumentors.base` |
| Attributes | `model`, `call_type` |
| When | incremented once per span whose model has no price (contract `priced: false`) and for the 13 pricing entries on which Python's calculator raises |

## 2. Resource identity

`telemetry.distro.name` is `genai-otel-instrument-<lang>` (`node`, `dotnet`, `java`,
`go`). Python emits `genai-otel-instrument` with no suffix. `telemetry.sdk.language` is
whatever the OpenTelemetry SDK for that language sets (`nodejs`, `dotnet`, `java`, `go`).

## 3. Custom pricing is honoured by every instrumentor (decision, 2026-10-02)

In Python v1.30.0, `GENAI_CUSTOM_PRICING_JSON` is ignored by 39 of 42 instrumentor
modules (OpenAI and Anthropic included) because `instrument()` never calls
`_setup_config()`. **The SDKs do not copy this.** In every SDK, custom pricing supplied
through `GENAI_CUSTOM_PRICING_JSON` (or the equivalent option) applies to every
instrumentor and to the cost-enrichment processor, with the merge semantics of
`CostCalculator._merge_custom_pricing` (accepted categories and validation as recorded
in `cost_vectors.json`). A span priced from custom pricing reports the same
`gen_ai.usage.cost.*` attributes and `pricing_source` the Python calculator reports for a
custom-priced model. Each SDK needs a test that fails if an instrumentor ignores it, and
lists this in the parity matrix as a deliberate difference from Python v1.30.0 (to be
fixed upstream).

## 4. Session API (decided 2026-10-02)

Python offers only `session_id_extractor` / `user_id_extractor` config callbacks (set
`session.id`, `gen_ai.conversation.id`, `user.id` on base-wrapper spans) and the
resource route `OTEL_RESOURCE_ATTRIBUTES=session.id=...`. Every SDK ports the extractors
and adds the same explicit API, named idiomatically per language:

| Operation | Semantics |
|---|---|
| `withSession(id, fn, {userId})` (scope) | Scoped through the language's context mechanism (OTel Context / AsyncLocal / `context.Context`); holds across async boundaries where the runtime allows. |
| `setSession(id, {userId})` / clear | Process-wide default; the scoped value wins over it. |
| `currentSession()` | Returns the effective session and user id. |
| Session span processor | Installed first by `instrument()`. Stamps `session.id`, `gen_ai.conversation.id` and (when given) `user.id` on EVERY span started in scope, from any instrumentation. Never overwrites a value the span was started with; an extractor still wins for the spans it applies to. |

Why: a backend that builds sessions groups spans into one only for spans or
resources carrying `session.id`, `gen_ai.session.id` or `gen_ai.conversation.id`.
Listed in each parity matrix as not present in Python.

## 5. Never leak content, never damage the caller (decisions, 2026-10-02)

- **Content only when capture is on.** Several Python instrumentors write prompt or
  completion text to the span regardless of `GENAI_ENABLE_CONTENT_CAPTURE` (the
  `AsyncOpenAI` wrapper; `gen_ai.response` in Bedrock, Groq, Mistral, SambaNova and Azure
  OpenAI). No SDK ports this. Content reaches a span only when content capture is on.
- **Observe only.** Python's Bedrock `invoke_model` wrapper drains the response body, so
  the caller reads an empty stream. No SDK ports a behaviour that changes what the
  application receives.
- **No toxicity attribute without a backend.** Python has no rule-based toxicity and
  writes `detected=false` with nothing measured. The SDKs emit no toxicity attribute
  unless a backend (ONNX model or configured endpoint) actually ran.
- **Host matching for OpenAI-compatible vendors** is host-or-subdomain, not Python's
  substring-anywhere-in-URL.

Each is listed in the parity matrix as a deliberate difference from Python v1.30.0 and is
a candidate upstream fix.

## 6. Uniform span content across providers (decisions, 2026-10-02)

Python's instrumentors were written one at a time and disagree with each other. The SDKs
record every provider through the shared core, so the span is the same shape whichever
provider answered. Where that makes an SDK span a superset of Python's, that is intended.

- **`gen_ai.operation.name` on every model-call span** (`chat`, `embeddings`, ...), also
  where Python omits it (Anthropic, Groq, hand-built spans). The platform's
  session-aggregator selects single model requests by it; without it no
  `inference_metrics` row is written for that call.
- **Wire values, not Python enum text.** Finish reasons, safety categories and similar
  enumerations are written as the provider sent them (`STOP`, `HARM_CATEGORY_...`), never
  as Python's `str(enum)` (`FinishReason.STOP`) and never as the string `"None"` for a
  missing value (omit the attribute).
- **Content capture is all or nothing.** With content capture ON, prompt and completion
  content is captured for every provider, including the ones where Python captures none
  (Google, Together, Hyperbolic); the evaluation detectors need it. With capture OFF,
  none is (section 5).
- **Shared-core superset.** Spans Python builds by hand (Groq, Hyperbolic,
  `converse_stream`, ...) carry the standard attributes, status and metric labels here.
- **Tokens the provider reports are used.** Where the provider returns counts Python does
  not read (Bedrock `X-Amzn-Bedrock-*-Token-Count` headers, Anthropic-shaped Bedrock
  bodies, the streamed Responses API's final event, Gemini thinking / cached tokens,
  Bedrock Converse cache tokens), the SDKs read them and price them. A span with real
  usage and no tokens is a defect, not parity.
- **Cohere chat, Google streamed generation, Azure AI Inference chat** get spans
  (`cohere.chat`; Google's existing generate span name; Azure AI Inference chat is
  recorded under the provider's own system, not as `openai`).
- **Metrics from every instrumentor.** In Python v1.30.0 only the first instrumentor
  class constructed in a process emits metrics. No SDK reproduces that.

Each is a deliberate difference from Python v1.30.0, listed in the parity matrix, and a
candidate upstream fix. The contract's cost vectors and config cases are unaffected.

## 7. Span names the contract does not give (decisions, 2026-10-02)

`contract/semconv.json` lists the span names Python emits. For calls Python does not
trace, every SDK uses the same name, chosen by these rules, in order:

1. **Streaming and async never change the span name.** A streamed or async call has the
   name of its buffered, blocking counterpart; streaming is carried by the attribute
   Python already uses for it. No `_stream` and no `aio` variants - unless Python itself
   has a distinct name for that call, in which case Python's name is used.
2. **Azure OpenAI is `openai.*`** with `server.address` showing the Azure host. Python's
   `azure.ai.openai` instrumentor never activates, so real Azure traffic is recorded as
   `openai` there too. No `azure.openai.*` span names.
3. **An OpenAI-compatible vendor** uses the prefix Python uses for that vendor's chat
   span, with the operation part replaced: `groq.embeddings`, `sambanova.embeddings`,
   `hyperbolic.embeddings`. The Responses API through a vendor keeps `openai.responses`
   with that vendor's `gen_ai.system`.
4. **Fixed names:** `cohere.chat` (v1 and v2, buffered and streamed);
   Google generation, streamed or not, is the name Python uses for `generate_content`;
   Azure AI Inference chat is `azure.ai.inference.chat` (Python's embeddings span is
   `azure.ai.inference.embeddings`), with `gen_ai.system = azure_ai_inference`.
5. Anything else: `<gen_ai.system>.<operation>` in Python's style, and it is reported to
   the lead so it can be added here.

**Ollama token estimate.** When the Ollama server omits its eval counts, Python estimates
tokens (4 characters per token, 256 per image) and sets
`gen_ai.usage.token_count_estimated=true`. Every SDK ports this, flag included: an
estimate that says it is one is better than a span with no usage.

**Streamed completions are content too.** With content capture ON, a streamed call
carries the completion text assembled from the stream, truncated to
`GENAI_CONTENT_MAX_LENGTH`, exactly as a buffered call does. Python's streaming path never
assembles it, which leaves the evaluation detectors nothing to read on the most common
kind of chat call. With capture OFF nothing is assembled or kept.

## 8. Framework spans (decisions, 2026-10-02)

- **Content on framework spans is gated like everywhere else.** Python records agent
  instructions, run input/output, graph state, retrieval queries and similar text on
  framework spans always (bounded to 200-500 characters). The SDKs record them only with
  content capture ON. Names, counts, lengths and ids are always recorded.
- **A span that carries its own session id** (graph thread, agent session, MCP session)
  puts that session in force for the calls inside it, unless a `withSession` scope is
  already open. A framework's session fallback consults the `withSession` scope before
  generating a UUID.
- **Datastore spans:** `db.statement` only with content capture ON.
- **One model call, one usage record (decision, 2026-10-02).** In Python
  v1.30.0 a framework span (LangChain chat model and similar) and the provider span
  beneath it both carry the full tokens and cost, and both record the token and cost
  metrics, so anything that sums spans or reads the counters reports the call twice
  (reproduced: `langchain.chat_model.invoke` 153 tokens / 8.67e-05 and its child
  `openai.chat.completion` 153 tokens / 8.67e-05 for ONE call). **No SDK reproduces
  this.** The rule:

  1. Every span this SDK creates for a model call or a framework step owns a small
     usage holder, visible to spans started beneath it (through the language's context
     mechanism).
  2. When the SDK records usage on a span (token attributes, cost attributes, token and
     cost metrics), it marks the holder of every enclosing SDK span: *a descendant
     recorded usage*. A model-call span also marks its enclosing holders as *in flight*
     when it starts and clears that when it ends.
  3. When an enclosing span ends and a descendant recorded usage, or a descendant
     model call is still in flight (a stream being read after the framework call
     returned), the enclosing span writes **no** `gen_ai.usage.*` token attributes, **no**
     `gen_ai.usage.cost.*` attributes and records **no** token or cost metrics. It sets
     `gen_ai.usage.recorded_by = "descendant"` so a reader can see why it is empty.
  4. When no descendant recorded usage (the provider is not instrumented, or the
     framework talks to it in a way the SDK does not see), the enclosing span records its
     own usage exactly as before. Nothing is lost.
  5. The cost-enrichment processor follows the same rule: it never prices a span whose
     holder says a descendant recorded usage.
  6. Spans produced by third-party instrumentation (OpenInference, a vendor's own OTel
     spans) are outside this mechanism; where an SDK normalises such spans it prices each
     real call once, as the Vercel AI SDK processor already does.

  Tests, in every SDK: framework span over an instrumented provider call (buffered and
  streamed) - usage and metrics exactly once, on the provider span; framework span over
  an uninstrumented provider - usage once, on the framework span; two sequential provider
  calls under one framework span - two records, none on the framework span; a provider
  call that errors with no usage under a framework span that has usage - the framework
  span keeps its usage.

## 9. GPU energy, power cost and CO2 (decisions, 2026-10-02)

- **Energy is computed correctly.** Python's manual path
  (`gpu_metrics.py::_collect_loop`) computes
  `delta_energy_wh = (power_w / 1000) * (delta_time_hours * 3600)`, which is
  kilowatt-seconds, and then uses it as watt-hours: 300 W for 10 s is 0.833 Wh, Python
  records 3.0. `gen_ai.power.cost` is therefore 3.6x too high in Python always, and
  `gen_ai.co2.emissions` 3.6x too high whenever codecarbon is absent. The SDKs have no
  codecarbon, so this is their only path, and they compute
  `energy_kWh = watts * seconds / 3_600_000`. Deliberate difference; upstream fix needed.
- **CO2 = energy x `GENAI_CARBON_INTENSITY`** (contract default 475 gCO2e/kWh), emitted
  only when `GENAI_ENABLE_CO2_TRACKING` is on, as in Python's manual path. There is no
  vendored country / region intensity table: Python gets regional data from codecarbon,
  not from its own files, so there is nothing to vendor. The docs must say the figure is
  a configured factor applied to measured energy, not a measured grid value.
  `GENAI_CO2_COUNTRY_ISO_CODE`, `GENAI_CO2_REGION`, `GENAI_CO2_CLOUD_*` and
  `GENAI_CO2_OFFLINE_MODE` are accepted and reported as having no effect in the SDK.
- **No GPU, no GPU metrics.** Fields the driver reports as `[N/A]` (power limit, fan,
  ECC on some cards) are absent for that device, never zero.
- **Browser and React Native** have no access to power or utilisation: no GPU, energy,
  power-cost or CO2 metrics there at all.

## 10. Third-party spans, names chosen in phase 3, and span kinds (decisions, 2026-10-03)

- **Content guard for spans we did not create.** Frameworks that emit their own spans
  write prompts and answers on them regardless of our content-capture setting (Genkit
  `genkit:input` / `genkit:output`; OpenInference `input.value`, `output.value`,
  `llm.input_messages.*`, `llm.output_messages.*`; Vercel AI SDK `ai.prompt*`,
  `ai.response.text`, `ai.response.toolCalls`; LangChain4j / Spring AI observation
  content attributes where enabled). Because `instrument()` installs the tracer provider
  they export through our pipeline. Every SDK installs a content guard that, with content
  capture OFF, removes these attributes (and the matching span events where the runtime
  allows events to be removed) before export. Where removal is impossible (span events
  in .NET), the SDK documents it and logs one warning when it sees such content.
  The list lives in one place per SDK and is extended when a new framework is added.
- **Span names for calls Python does not trace** (section 7 rule 5), now fixed for all:
  `langchain4j.chat_model.chat`, `langchain4j.embedding_model.embed`,
  `spring_ai.chat_model.call`, `spring_ai.embedding_model.call`,
  `eino.<component>` (snake case), `genkit.generate`, `genkit.flow.<name>`,
  `langchain.tool.<name>`, `mcp.server.call_tool {tool}` (the client keeps Python's
  `mcp.call_tool {server}.{tool}`), `opensearch.<endpoint>` / `elasticsearch.<endpoint>`,
  `qdrant.<rpc>` / `pinecone.<rpc>` / `milvus.<rpc>` for calls Python does not trace,
  `weaviate.<resource>.<verb>`, `chroma.<action>`. Python's names are kept wherever they
  exist.
- **Span kind:** a span for a call that leaves the process (vector store, datastore,
  MCP client, HTTP API) is `CLIENT`; an MCP server span is `SERVER`. Python uses
  `INTERNAL` for most of these; this is a deliberate difference.
- **Metric label `db.system`** is the database (`postgresql`, `mysql`), not the driver
  name Python uses (`psycopg2`). Python's guessed 100 bytes per row for response size is
  not ported: no measurement, no attribute.
- **Session ids in E2E programs** use a random hex or UUID suffix, never a timestamp: the
  platform's collector masks 13-19 digit runs as card numbers.

## 11. More span names (lead, 2026-10-03, from the Node phase 4 report)

Fixed for every SDK that has the call: `transformers.model.load`; `cactus.download`,
`cactus.init`, `cactus.complete`, `cactus.embed`, `cactus.stt.transcribe`; `s3.<operation>`;
`opensearch.<api>`; `aws.bedrock.send` (a Bedrock runtime command outside the four named
ones). Python templates the contract's static scan missed - use them as Python writes them:
`elevenlabs.text_to_speech.<method>`, `api.call.<method>.<host>`, `minio.<op>`,
`rabbitmq.<op>`, `timescaledb.<op>`, `pinecone.index.<op>`, `mistralai.chat.complete <model>`
and `mistralai.chat.stream <model>` (Python's own stream name, allowed by section 7 rule 1).

**Single usage record in browser / React Native:** with no async context manager, only
synchronous nesting is detected there; a framework span that awaits a provider call may
still record usage alongside it. Each SDK documents where the guarantee holds.

## 12. Evaluation and engine metrics (decisions, 2026-10-03, from the .NET phase 4 report)

- **Evaluate without exporting content.** With content capture OFF, the SDK still runs the
  rule-based detectors on its OWN calls' prompt and response (streamed answers included),
  passing the text in-process only; it is never written to a span or exported. Python
  evaluates only what is on the span, i.e. nothing when capture is off. Deliberate
  difference.
- **New variables, same name in every SDK:** `GENAI_TOXICITY_JUDGE_URL` (on-prem HTTP
  toxicity judge), `GENAI_TOXICITY_ONNX_MODEL` (local ONNX model path; ship the ONNX
  runtime as an optional add-on package, never a core dependency),
  `GENAI_SERVER_METRICS_ENDPOINTS` (comma-separated vLLM / llama.cpp Prometheus endpoints
  to scrape).
- **Engine metrics describe the engine now.** Ollama KV-cache entries are replaced on every
  poll; an unloaded model disappears instead of keeping a stale value (Python keeps it).
  Engine pollers stamp their samples with `server_metrics_source="engine"`; the in-flight
  count the SDK keeps for its own calls is `"client"` (a backend can store it). Values an application sets itself carry no label; the platform reads a missing label as unknown, never as either.
- **Pre-call blocking is required where Python has it.** When a detector's
  `*_BLOCK_ON_DETECTION` is on, the call is refused before it reaches the provider, with the
  language's idiomatic error (a typed exception carrying detector, categories, score) and
  the span ended as an error carrying Python's and Node's names: `evaluation.<detector>.prompt.blocked`, `evaluation.blocked`, `evaluation.blocked_reasons` (correction 2026-10-03: not `evaluation.<detector>.blocked`). No request, tokens or cost are recorded; `gen_ai.client.errors` counts it with `error_type=PolicyViolationError`.
- **`evaluation.completed`** is set only when something was evaluated.
- **Hallucination factual-claim group order** is dates, numbers, names, statistics (taken
  from Python's source; not in eval_rules.json yet).
- `weaviate.<rpc>` for Weaviate gRPC calls.

## 13. Engine prefix cache (decision, 2026-10-04)

- The vLLM endpoint poller (`GENAI_SERVER_METRICS_ENDPOINTS`) also reads vLLM's prefix-cache counters from `/metrics`: `vllm:prefix_cache_queries_total` and `vllm:prefix_cache_hits_total` (older vLLM: `vllm:gpu_prefix_cache_queries_total` / `vllm:gpu_prefix_cache_hits_total`), summed over the endpoint's label sets.
- It reports them as two OBSERVABLE GAUGES (not counters: a counter gains a `_total` suffix in the Prometheus exporter and the platform would not match it): `gen_ai.server.prefix_cache.queries` and `gen_ai.server.prefix_cache.hits`, unit `{token}` (a curly-brace unit is dropped by the Prometheus translator, so the platform reads `gen_ai_server_prefix_cache_queries` / `_hits`), each with `server_metrics_source="engine"` and `model` when vLLM labels it, value = the engine's cumulative counter as read.
- A server that does not export them (llama.cpp, Ollama, older vLLM without prefix caching) records nothing: absent, never 0. No hit percentage is computed in the SDK; the platform derives it.
- Meter: the same `genai.server` meter as the other server metrics.

## 14. A2A and A2UI: a scoped addition from Python 1.47.0 / 1.48.0 (lead decision A2UI-D8, 2026-11-12)

The contract above stays pinned at Python v1.46.0. The A2A (1.47.0) and A2UI (1.48.0) instrumentation
came after that pin, and a full re-pin would also bring in unrelated 1.46.x to 1.48.0 changes, so
only these names are taken, from one commit:

| | |
|---|---|
| Source | genai_otel_instrument tag `v1.48.0` (commit `7762b71`): `genai_otel/a2a_semconv/attributes.py`, `genai_otel/a2ui_semconv/attributes.py`, the span and event names in `a2ui_semconv/instrumentor.py`, and `GENAI_A2A_PROPAGATE` / `GENAI_A2UI_ENABLED` in `config.py` |
| Vendored as | `contract/a2a-a2ui.json`, written by `scripts/sync-a2a-a2ui-from-python.mjs` (`npm run sync:a2a-a2ui`), with the sha256 of each source file and of the names. Turned into `src/a2a-a2ui.generated.ts` by `npm run generate`. `npm run sync:a2a-a2ui:check` (CI) fails on a hand edit |
| Not in | `MANIFEST.json`, `config.json`, `semconv.json`: the contract tests are unchanged except that they allow the two settings and the two default-list names listed here |
| Names | `a2a.*` (OpenTelemetry A2A conventions plus this library's counts), `a2ui.*` (provisional), reused `gen_ai.agent.*`, `gen_ai.conversation.id`, `error.type`, `server.*`; span names `{method} {target}`, `a2ui.parse_response`, `a2ui.parse_stream`; event `a2ui.error` |
| Settings | `GENAI_A2A_PROPAGATE`, `GENAI_A2UI_ENABLED`: `os.getenv(X, "true").lower() != "false"`, no stripping |
| Default instrumentors | `a2a`, `a2ui` after `crewai`, as in Python |
| Not present in Python | the `a2ui_web_core` opt-in adapter and its `a2ui.apply` span; `recordA2uiReceived` / `recordA2uiSent` / `recordA2uiRendererError`; the explicit hand-over functions. Python has no renderer |
| Not ported | the A2A server side (decision A2UI-D6, later); `a2ui.process` (`@a2ui/agent` 0.1.0 has no renderer-to-agent processor); `a2ui.validation_failed` (Python's workaround for a function that swallows its error) |
