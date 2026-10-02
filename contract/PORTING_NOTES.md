# Porting notes for the SDK contract (genai_otel_instrument v1.30.0)

Read this next to `SCHEMA.md`. `SCHEMA.md` says what shape each file has; this
file says what in the Python library's behaviour will surprise someone porting
it. Everything here was observed while generating the contract and is pinned by
a vector or a field in the JSON files, which are the authority. Where a note
and a vector disagree, the vector wins.

This file is not listed in `MANIFEST.json` and is not produced by
`scripts/generate_sdk_contract.py`. It was written by hand after generation.

Provenance: generator commit `fe157f2` on local branch
`feat/sdk-contract-generator`, one commit ahead of tag `v1.30.0`. That commit
adds only the generator and its test; `MANIFEST.json` records
`library_identical_to_tag: true` (the `genai_otel/` tree hash equals the tag's).

---

## 1. Things that contradict the implementation plan

### 1.1 Toxicity has no rule-based mode
The plan asks for every detector in "rule-based mode". Toxicity does not have
one. Its only backends are the Google Perspective API and the Detoxify model.
With neither available, `is_available()` is false and `detect()` returns
`is_toxic=false, scores={}, max_score=0.0, toxic_categories=[]` for every input.
The span processor then writes `evaluation.toxicity.<prompt|response>.detected = false`.

There is no keyword list or regex to port. All 24 toxicity vectors in
`eval_vectors.json` pin exactly this, and `eval_rules.json` has
`detectors.toxicity.rule_based = false`. A port should not invent a rule set.
Note the tension with the plan's "an unmeasured value is absent" rule: Python
writes `detected=false` here although nothing was measured.

### 1.2 `telemetry.distro.name` has no language suffix in Python
The plan specifies `genai-otel-instrument-<lang>` for the ports. Python emits
`genai-otel-instrument`. It also still dual-emits the superseded
`telemetry.auto.name`, `telemetry.auto.version` and (when `OTEL_ENVIRONMENT` is
set) `environment` alongside `deployment.environment.name`.
See `semconv.json` -> `resource`.

### 1.3 Garbage in a numeric variable is not defaulted
The plan's review focus says "expect the Python behaviour for that variable,
with a logged reason". The Python behaviour is harsher than that implies:

* `GENAI_SAMPLING_RATE=abc` makes `OTelConfig()` raise `ValueError`.
* `genai_otel.instrument()` catches the exception, logs it, and returns
  **without instrumenting anything**, unless `GENAI_FAIL_ON_ERROR=true` (or
  `fail_on_error=True`), in which case it re-raises.
* This applies to every `float(...)` and `int(...)` variable. An empty string
  raises too.
* The one exception is `OTEL_EXPORTER_OTLP_TIMEOUT`, which falls back to 60.
* `nan` and `inf` are accepted as floats without complaint.

In `config.json` these appear as `cases[]` entries with `error` instead of
`parsed`.

### 1.4 Unknown price is `0.0` in the calculator, not absent
The plan says "unknown model price -> no cost attribute". That is true on the
span but not in the calculator:

* `CostCalculator.calculate_cost` returns `0.0` for an unknown model.
  `cost_vectors.json` records that verbatim. Use the `priced` field, never
  `cost == 0`, to tell "no price" from "free".
* On a **chat** span the library omits `gen_ai.usage.cost.*` when the total is
  not above zero and sets `gen_ai.usage.cost.pricing_source = "unpriced"`.
* On a **non-chat** span (`embedding`, `image`, `audio`, `speech_to_text`)
  `pricing_source` is never set at all, so an unpriced embedding call is
  indistinguishable from a free one.
* A priced model with zero tokens also gets no cost attributes, but does get
  `pricing_source = "table"`.

See the `span_emission` scenarios `chat_unpriced_model`,
`chat_zero_tokens`, `embedding[...]` and `speech_to_text_call_type` in
`semconv.json`.

### 1.5 Where things live
`genai_otel/semconv.py` holds its names on a `SemanticConvention` class, not as
module constants, and `genai_otel/metrics.py` holds only histogram bucket lists.
Instruments are created in `instrumentors/base.py`, `gpu_metrics.py`,
`server_metrics.py`, `evaluation/span_processor.py` and
`mcp_instrumentors/base.py`.

---

## 2. Cost calculation

### 2.1 `pricing_source()` has a lookup quirk
It treats `call_type` as a pricing-table section name. The call types are
`chat`, `embedding`, `image`, `audio`; the sections are `chat`, `embeddings`,
`images`, `audio`. So for `embedding` and `image` it falls through to the
**chat** table:

* `dall-e-3` with `call_type="image"` reports `unpriced` while being priced.
* `text-embedding-3-small` with `call_type="embedding"` reports `estimated`.

Do not derive `priced` from `pricing_source`. `SCHEMA.md` defines `priced`.

### 2.2 The `speech_to_text` table is unreachable
`llm_pricing.json` has a `speech_to_text` section (40 entries), but
`calculate_cost` has no branch for that call type and returns `0.0`. Two
instrumentors set `gen_ai.request.type = "speech_to_text"`, so those spans get
no cost. (The Sarvam instrumentor computes its own.) `speech_to_text` is also
rejected as a custom-pricing category.

The plural `embeddings` is likewise an unknown call type and returns `0.0`.

### 2.3 `calculate_cost` raises on 13 shipped entries
* 9 embeddings entries whose value is a dict rather than a number
  (`Snowflake/snowflake-arctic-embed-*`, `google/embeddinggemma-300m`,
  `jina-reranker-v2-base-multilingual`, `nvidia/NV-Embed-v2`,
  `nvidia/llama-embed-nemotron-8b`, `nvidia/omni-embed-nemotron-3b`)
  -> `TypeError: unsupported operand type(s) for *: 'float' and 'dict'`.
* 4 images entries whose value is a bare float (`azure_ai/FLUX-1.1-pro`,
  `azure_ai/FLUX.1-Kontext-pro`, `recraft/recraftv2`, `recraft/recraftv3`)
  -> `TypeError: argument of type 'float' is not iterable`.

The base instrumentor catches the exception and logs a warning, so the span
simply has no cost. These vectors have `cost: null` and an `error` object.
A port must decide to treat them as unpriced; it must not crash.

### 2.4 Keys that differ only by case
Five chat keys exist twice with different casing (`MiniMax-M2.5`/`minimax-m2.5`,
`MiniMax-M2.7`, `MiniMax-M3`, `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.7-Code`).
Lookup is case-insensitive and the later key wins, so one of each pair can never
be resolved. See `case_insensitive_key_collisions`.

### 2.5 Model name resolution
* Case-insensitive exact match first, then the **longest** pricing key that
  occurs in the model name on a token boundary. A boundary is the string edge or
  any non-alphanumeric character; `_` counts as a boundary.
* The model name is not trimmed. `"gpt-4o "` still resolves because the space is
  a boundary.
* Unknown chat models fall back to a price tier inferred from a parameter count
  in the name (`:7b`, `-360m`, or a size word such as `tiny`, `small`, `xl` on a
  token boundary). `pricing_source` is then `estimated`. Tier boundaries are
  inclusive at the lower end; see `local_model_price_tiers`.
* That fallback fabricates a price for a non-chat model sent as chat:
  `text-embedding-3-small` as `chat` is priced as a 0.06B model because of the
  word "small".

### 2.6 Token arithmetic
* Chat prices are per 1,000 tokens.
* Reasoning tokens are charged **in addition to** completion tokens when the
  entry has `reasoningPrice`. Cache-read and cache-write tokens are charged in
  addition to the full prompt tokens. Nothing is subtracted.
* `total_tokens` alone is ignored for chat. For embeddings, `prompt_tokens` is
  used and `total_tokens` only when `prompt_tokens` is zero or missing.
* Audio entries declare a unit (`per_second`, `per_1k_chars`, `per_1k_tokens`).
  If usage is supplied in a different unit the result is `0.0`, by design.
* Image entries with no `standard` quality return `0.0` unless `quality` is
  passed explicitly.
* Results are IEEE-754 doubles computed in the order shown in the Python source.
  Compare with a relative tolerance, not string equality.

---

## 3. Configuration

### 3.1 Booleans
The rule is `value.lower() == "true"`. `1`, `yes` and `on` are **false**.

Whitespace handling is inconsistent:
* Most readers do not strip: `" true "` is false.
* `GENAI_ENABLE_CONTENT_CAPTURE` and `GENAI_CAPTURE_EMBEDDING_VECTORS` do strip.

`TRACEVERDE_TELEMETRY` is the only variable that accepts `1` and `yes`.

### 3.2 The same variable is read in more than one place, differently
* `GENAI_CONTENT_MAX_LENGTH`: default **200** in `OTelConfig`, `PIIConfig` and
  `PIIDetector` (garbage raises `ValueError`), but default **10000** in the
  LiteLLM, MCP and smolagents span enrichment processors (garbage falls back to
  10000).
* `GENAI_AIR_GAPPED`, `GENAI_ALLOW_EXTERNAL_EGRESS` and `GENAI_PROFILE` are read
  by `OTelConfig` and again, independently, by the evaluation config classes and
  detectors.

Every reader site is listed under `variables[].readers` in `config.json`.

### 3.3 Hardening profile
`GENAI_PROFILE` in `strict`, `bfsi`, `bank` (compared after `.lower()`, not
stripped: `"Bank "` is not a profile) forces `allow_external_egress=false`,
`air_gapped=true`, `co2_offline_mode=true`, `toxicity_use_perspective_api=false`
even when those variables are set otherwise, and turns content capture **on**
unless either capture variable is set. It also drops the `process` resource
detector. See `interactions` in `config.json`.

### 3.4 Content capture precedence
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` wins over
`GENAI_ENABLE_CONTENT_CAPTURE` whenever it is non-empty. `EVENT_ONLY` maps to
false. An unrecognised value resolves to **false** and does not fall through to
the library's own variable. It is upper-cased and stripped before lookup.

### 3.5 Other
* `GENAI_PII_MODE` is stored by `OTelConfig` unvalidated. `BLOCK`, `mask` and
  the empty string then fail in `PIIMode(...)` during setup.
* `GENAI_METRICS_PROFILE` is lower-cased and otherwise unvalidated; only `full`
  changes behaviour.
* `GENAI_ENABLED_INSTRUMENTORS` is split on commas and each item stripped; empty
  items are kept; an empty string means "use the defaults". The default list
  order is significant.
* The `instrument()` docstring names `GENAI_LOG_LEVEL` and `GENAI_LOG_FILE`. The
  code reads `GENAI_OTEL_LOG_LEVEL` and has no log-file variable.
* The library writes to the process environment:
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TIMEOUT`,
  `OTEL_PYTHON_REQUESTS_EXCLUDED_URLS`, `OTEL_METRICS_EXEMPLAR_FILTER`
  (defaulted to `always_off`), `OTEL_EXPERIMENTAL_RESOURCE_DETECTORS`,
  `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HAYSTACK_AUTO_TRACE_ENABLED`,
  `CREWAI_TELEMETRY_OPT_OUT`.
* Variables consumed only by the OpenTelemetry SDK itself (for example
  `OTEL_EXPORTER_OTLP_HEADERS`) are not read by the library and are not listed.

---

## 4. Semantic conventions and spans

### 4.1 Superseded names
Default opt-in is `gen_ai/dup`: current and superseded names are both emitted.
Anything that is not exactly the token `gen_ai` or `gen_ai/dup` (unset, empty,
`http/dup`, `GEN_AI`) also means both. Only `gen_ai` drops the superseded names.
The value is a comma-separated token list; tokens are stripped; matching is
case-sensitive.

The seven pairs are in `semconv.json` -> `superseded`.

`gen_ai.system` is the exception. Under `gen_ai` the library only stops
*adding* it; an instrumentor that writes `gen_ai.system` itself (most do) still
emits it. See `provider_name_alias_probes` and the `[gen_ai]` scenarios.

A separate question, `canonical_messages_payload`, gates the heavy
`gen_ai.input.messages` / `gen_ai.output.messages` JSON. There an empty or
unrelated opt-in means **off**.

### 4.2 Values that are not what the convention says
* `gen_ai.request.encoding_formats` reaches the span as the **string**
  `"['float']"`, not an array, because the span wrapper stringifies any
  non-scalar initial attribute.
* `gen_ai.response.finish_reasons` is an array; the superseded
  `gen_ai.response.finish_reason` is a string.

### 4.3 Token attributes
Token attributes are set only when the count is greater than zero. With zero
tokens, or no usage reported, there are no token attributes at all.

### 4.4 Request type versus pricing section
`gen_ai.request.type` uses `chat` and `embedding` (singular). The pricing
section is `embeddings` (plural). They differ on purpose.

### 4.5 Errors
When the wrapped call raises, the span ends with status `ERROR`, the exception
message as the description, and an `exception` event. No response, usage or cost
attributes are present. See scenario `chat_wrapped_call_raises`.

---

## 5. Metrics

* Evaluation metrics are named `genai.evaluation.*` (no underscore). Every other
  metric is `gen_ai.*` or `mcp.*`.
* 11 histograms have no View and therefore use the SDK default boundaries
  `0, 5, 10, 25, ... 10000`, which are useless for their value ranges. They
  include `gen_ai.server.time_to_first_token`,
  `gen_ai.server.time_per_output_token` (both seconds) and every
  `genai.evaluation.*.score` (0 to 1). Only 8 histograms have Views. A port that
  wants parity must reproduce the defaults; a port that wants useful buckets
  must deviate, and should say so.
* The same measurement is recorded under two names:
  `gen_ai.server.ttft` and `gen_ai.server.time_to_first_token`;
  `gen_ai.server.tbt` and `gen_ai.server.time_per_output_token`.
* 22 per-GPU observable gauges are registered only when an NVIDIA or AMD device
  is present (`requires_gpu_device: true`). On a host without one they do not
  exist; they are not emitted as zero.
* `gen_ai.co2.emissions_rate` and `gen_ai.power.consumption` are histograms
  despite their gauge-like names.
* Token histograms, granular cost counters and finish/success/failure counters
  are recorded only when `GENAI_METRICS_PROFILE=full` or the matching
  `GENAI_RECORD_*` flag is true. Span attributes are written regardless.
* Six `mcp.*` names and two `db.*` names exist as constants but no instrument is
  ever created for them.
* Several counters are created with no unit (`""`).

---

## 6. Evaluation detectors

### 6.1 Regex dialect (matters most for Go and JavaScript)
* Patterns are Python `re` string patterns. `\w`, `\d`, `\s` and `\b` are
  Unicode-aware. Go's RE2 and JavaScript without the `u`/`v` flag treat them as
  ASCII.
* No pattern uses lookaround or backreferences; every pattern entry in
  `eval_rules.json` carries `uses_lookaround_or_backreference` to confirm it.
* One hallucination pattern contains non-ASCII superscript digits.
* PII entity offsets are **Unicode code points**, end exclusive. UTF-16 code
  units (JavaScript, Java, .NET) and bytes (Go) give different numbers. Vectors
  `pii-021` (Cyrillic) and `pii-022` (emoji) pin this.

### 6.2 Thresholds differ between two defaults
| Detector | Dataclass default | When configured from the environment |
|---|---|---|
| restricted topics | 0.5 | 0.7 |
| hallucination | 0.7 | 0.6 |

The environment value is what a user actually gets. Comparison is `score >= threshold`,
so a threshold of 0.0 flags everything, including clean text with score 0.0.

### 6.3 PII (regex fallback, used when Presidio is absent)
* `threshold` and `allow_list` are ignored.
* Only 10 of 22 entity types have a pattern. `PERSON`, `LOCATION`, `IBAN_CODE`
  and the rest are never detected, even in GDPR/HIPAA/PCI mode.
* Patterns are independent, so one substring is reported under several types: a
  spaced 16-digit card is also `IN_AADHAAR`; a 10-digit number starting 6-9 is
  both `PHONE_NUMBER` and `IN_PHONE`; `+919000000001` is `IN_AADHAAR` and
  `IN_PHONE`.
* No validation: `999.999.999.999` and a version string `1.2.3.4` are
  `IP_ADDRESS`.
* PAN and IFSC patterns are case-sensitive.
* Redaction replaces each entity with the redaction character repeated to the
  entity's length, then truncates the whole string to `content_max_length`.
* In `redact` and `block` mode `original_text` is null when PII was found.

### 6.4 Bias
* Any sentence starting "She is", "He is", "Women are", "Men are" scores 0.4,
  which meets the default threshold. "She is a doctor." is flagged as gender
  bias.
* Matching is tried on the original text, then a de-leetspeaked copy, then a
  punctuation-stripped copy, stopping at the first that matches.
* `detected_biases` follows Python set iteration order, which is not stable.
  The vectors sort it; compare as a set.
* `block_on_detection` does not change the detector result.

### 6.5 Prompt injection
* `patterns`, `check_patterns`, `use_ml_model` and `log_attempts` are ignored.
* Any single match scores 0.6, above the default 0.5.
* False positives pinned on purpose: "How do I turn on developer mode on
  Android?", "Is there a jailbreak for this phone?", "Hello {0}, welcome back."

### 6.6 Restricted topics
* Keywords match as **substrings** of the lower-cased text: `harm` matches
  "harmless" and "pharmacy"; `crime` matches "crime novel".
* "Should I take a break?" is medical advice. "What is the key to a good
  presentation?" is a personal-information request.
* An empty `restricted_topics` list means all topics. Unknown topic names are
  skipped.

### 6.7 Hallucination
* On a span the **prompt** is passed as context. A prompt containing a negation
  and a response without one, sharing more than two 4+ letter words, adds 0.3.
* Patterns run case-insensitively, so `[A-Z][a-z]+` also matches lower case.
* A substring matched by two claim patterns counts twice ("50% of users" is two
  claims).
* The sentence extractor stops at a decimal point: "$45.7 billion" yields
  "...earned $45." as an unsupported claim.
* There is no block mode.

### 6.8 Blocking
`block_on_detection` and `pii_mode=block` in the span processor only annotate
the span (status `ERROR` plus an `evaluation.*.blocked` attribute) after the
call has returned. Real pre-call blocking is a separate hook in the base
instrumentor that raises before the provider is called.

---

## 7. Resource attributes

* `service.instance.id` is a random UUIDv4 by default. With
  `GENAI_SERVICE_INSTANCE_ID_MODE=derived` it is a UUIDv5 over host name,
  service name and the sorted redacted argument list. An unknown mode falls back
  to random. `OTEL_SERVICE_INSTANCE_ID` or `OTEL_RESOURCE_ATTRIBUTES` wins.
* `process.command_args` is redacted for credential-looking flags and
  `name=value` pairs. A short flag (`-p hunter2`) is **not** redacted. See
  `command_args_redaction_vectors`.
* `host.ip` is derived by the library; there is no upstream detector for it.

---

## 8. What could not be extracted, or is weaker than it looks

* **Attribute names are a static scan.** `attributes[].modules` says where a
  name is written in source. It cannot see names built at run time and may
  include a dotted dict key that is not a span attribute. Only names with
  `"observed_on_span"` in `via` were seen on a real span.
* 24 `SemanticConvention` constants show no literal use
  (`semconv_constants_not_found_by_static_scan`). Some are genuinely unused;
  others are used through `.format()` or `getattr`. The list is a prompt to
  look, not a verdict.
* **Span names** passed through a variable are missed by the scan.
* **Metric attribute keys** were observed at run time only for the base
  instrumentor and the evaluation processor. For GPU, CO2, MCP and streaming
  instruments the keys come from a static scan; 9 are marked
  `attribute_keys_static_complete: false`.
* **Not driven at all:** streaming responses (TTFT and time-per-output-token
  attributes and metrics), media capture, agent-budget attributes, and the MCP
  client instrumentor. Only the non-streaming path of the base wrapper was
  exercised. Each port needs its own tests for these, written from the Python
  source.
* **Seven variables are static only** and have no cases: five the library only
  writes, plus `GENAI_MCP_HASH_SALT` and `TRACEVERDE_TELEMETRY_URL`.
* **Resource detector keys** (`host.*`, `os.*`, `process.*`) are names only and
  reflect the generating host: Windows, OpenTelemetry SDK 1.44.0. Other
  platforms and SDK versions will differ.
* **`python_package_version` in the manifest reads `1.27.1.dev1`.** The
  generated `genai_otel/__version__.py` in the checkout was stale. Trust
  `python_tag` (`v1.30.0`) and `library_identical_to_tag`.
* **The `algorithm` prose in `eval_rules.json` was written by hand** from the
  source. `eval_vectors.json` is what verifies a port.
* **The default instrumentor list depends on the Python version** (three ids are
  added on 3.10+). The file was generated on 3.12.
