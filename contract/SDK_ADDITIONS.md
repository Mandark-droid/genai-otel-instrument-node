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
