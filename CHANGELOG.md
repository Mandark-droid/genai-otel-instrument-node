# Changelog

## [Unreleased]

### Added
- Repository scaffold.
- Build and test toolchain: TypeScript, CommonJS + ES-module bundles (tsup), vitest with
  coverage floors on `config`, `cost`, `metrics`, eslint, `tsc --noEmit`.
- `scripts/sync-from-python.mjs`: vendors the cross-language contract and the pricing
  table from the Python reference at the pinned tag (v1.30.0), verifying every file
  against the manifest's sha256. `--check` fails on drift or a hand edit.
- Vendored `contract/*` and `src/pricing/llm_pricing.json` at v1.30.0.
- `loadConfig()`: environment-driven configuration with the Python library's variables,
  defaults and parsing, checked against every case in `contract/config.json`.
- `buildResource()`: resource attributes with `telemetry.sdk.language=nodejs`,
  `telemetry.distro.name=genai-otel-instrument-node` and `telemetry.distro.version`,
  host / os / process attributes, argv credential redaction, `host.ip`, and a random or
  derived `service.instance.id`. The attribute set matches the reference implementation's.
- `instrument()`, `uninstrument()`, `flushTelemetry()`, `instrumentorsReady()`: tracer and
  meter providers with OTLP http/protobuf or gRPC exporters (console exporters when the
  endpoint is empty), trace-id-ratio sampling, W3C trace-context propagation, flush on
  exit and optionally on SIGTERM. Export is batched off the request path; shutdown and
  flush are bounded by a timeout.
- Zero-code entry points: `node --require @traceverse/genai-otel-instrument/register`
  (CommonJS) and `node --import @traceverse/genai-otel-instrument/register` (ES modules).
- GitHub Actions `test` workflow: sync check, typecheck, lint, tests and build on Node
  20 / 22 / 24, and a built-package smoke on Node 18.

- `CostCalculator`: a port of the Python cost calculator - case-insensitive exact match,
  then the longest pricing key that matches on a token boundary; parameter-count tiers
  for local models; custom pricing (`GENAI_CUSTOM_PRICING_JSON`) merged over the shipped
  table; granular cost (prompt, completion, reasoning, cache read, cache write);
  `pricingSource`, `deprecation`, `priceChecked`, `stalePrices`. Passes every vector in
  `contract/cost_vectors.json` bit for bit.
- An unpriced model yields `null`, never `0`: no cost attribute is written, and the call
  is counted in the new `gen_ai.usage.cost.pricing_missing` counter.
- `CostEnrichmentSpanProcessor`: prices GenAI and OpenInference spans produced by other
  instrumentation, at span end.

- `scripts/generate-contract-code.mjs`: generates `src/semconv.generated.ts` and
  `src/metrics.generated.ts` from the vendored contract before build, test, typecheck and
  lint. Attribute names, metric names, units, kinds and bucket boundaries are not typed by
  hand anywhere.
- `genaiSemconvModes()` / `genaiTierOptedIn()`: the `OTEL_SEMCONV_STABILITY_OPT_IN`
  policy, passing every opt-in case in `contract/semconv.json`.
- Shared GenAI client metric instruments (the 20 of the Python base instrumentor) and
  the explicit-bucket histogram views, matching `contract/metrics.json` in name, unit,
  kind, description, instrumentation scope and bucket boundaries.

- `BaseInstrumentor`: the span wrapper of the Python base instrumentor - provider-name
  aliasing, `server.address` / `server.port` from the client base URL, request-parameter
  attributes, token / cache / reasoning / per-modality attributes, cost with
  `gen_ai.usage.cost.pricing_source`, finish reasons, session and user extractors,
  sampled-out fast path, and streaming measurement (time to first token, time between
  tokens, time per output token). Reproduces all 16 spans in `contract/semconv.json`
  (`span_emission`) attribute for attribute.
- `openai` instrumentor (`openai` package, verified on 4.0.0 through 7.27.0): Chat
  Completions buffered and streamed, tool calls, Embeddings, Responses API; any
  OpenAI-compatible endpoint through the same client, with the endpoint recorded and
  base URLs claimed by a dedicated instrumentor left to it.
- `anthropic` instrumentor (`@anthropic-ai/sdk`, verified on 0.20.0 through 0.131.0):
  `messages.create` buffered and streamed, and the `messages.stream()` helper, with usage
  folded across stream events (cumulative `message_delta` counts merged, not summed).
- Both builds of each client library are patched - the CommonJS and the ES-module one are
  separate classes - on the resource prototype, so clients created before `instrument()`
  are traced too. The SDK's own promise and stream objects are returned unchanged
  (`withResponse()`, `asResponse()`, `controller`, `tee()` keep working).
- A cancelled or failed stream ends its span with ERROR status and the tokens seen; a
  stream or promise nobody consumes has its span ended when it is collected. No span is
  left open.
- Examples: `examples/openai`, `examples/anthropic`, and `examples/e2e/smoke` (one chat
  call through an OpenAI-compatible endpoint, for the platform smoke test). Each README
  says what it was and was not run against.
- `scripts/dist-smoke.cjs` and `scripts/sdk-compat.cjs`: the built package, loaded and
  driven through the zero-code hooks, on every supported Node and against each supported
  major of the client libraries. Both run in CI.
- `docs/parity-matrix.md`: every reference instrumentor id with its status here, the
  deliberate differences, and the reference behaviours that were ported as they are.

- The pricing-missing counter also counts a call whose pricing-table entry the calculator
  cannot use (13 shipped entries are in the wrong shape), as fixed across the SDKs in
  `contract/SDK_ADDITIONS.md`.
- `contract/PORTING_NOTES.md` and `contract/SDK_ADDITIONS.md` are vendored with the
  contract.

- Instrumentors for providers reached through the `openai` client at their own base URL:
  OpenRouter, CometAPI (also through `@anthropic-ai/sdk`), Hyperbolic, SambaNova, and the
  Anyscale no-op. Each claims its domain, so a call is traced once, under the provider's
  span name. Azure OpenAI (`AzureOpenAI`) is covered by the OpenAI instrumentor.
- Instrumentors for Groq (`groq-sdk`) and Together AI (`together-ai`).
- Instrumentors for Mistral (`@mistralai/mistralai`), Cohere (`cohere-ai`, including `chat`,
  which the Python library does not trace) and Ollama (`ollama`), with examples.
- ES-module-only client packages are found and patched (`@mistralai/mistralai` ships no
  CommonJS build).
- Instrumentors for Google Gemini (`@google/genai`), Vertex AI (`@google-cloud/vertexai`)
  and AWS Bedrock (`@aws-sdk/client-bedrock-runtime`: Converse, ConverseStream, InvokeModel,
  InvokeModelWithResponseStream), with examples.
- Instrumentors for Replicate (`replicate`), ElevenLabs (`@elevenlabs/elevenlabs-js`) and
  Sarvam AI (`sarvamai`), and `traceHuggingFaceClient()` for `@huggingface/inference`,
  whose client can only be traced by wrapping it. With examples.
- Datastore instrumentation, on by default (`GENAI_ENABLE_MCP_INSTRUMENTATION`): one client
  span per operation and the `mcp.requests`, `mcp.client.operation.duration`,
  `mcp.request.size` and `mcp.response.size` metrics, for PostgreSQL (`pg`, with
  TimescaleDB operations named), MySQL (`mysql2`), Redis (`redis`, `ioredis`) and FalkorDB.
  Statement text is recorded only with content capture on; parameter values never.
- More datastores under the same switch: Kafka (`kafkajs`), RabbitMQ (`amqplib`), OpenSearch,
  Elasticsearch (metrics only: the client makes its own span), MinIO, S3, and the vector
  databases Qdrant, Pinecone, Chroma and Milvus with the retrieval score summary
  (`rag.result.score_max` / `_min` / `_mean` / `_margin`). Message bodies, documents and
  vectors are never recorded.
- Outbound HTTP through `fetch`, off unless `GENAI_ENABLE_HTTP_INSTRUMENTATION=true`.
- Example: `examples/datastores` (a traced Qdrant query).
- On-device inference (spec 6a):
  - transformers.js (`@huggingface/transformers`): `transformers.model.load`,
    `huggingface.pipeline`, `huggingface.model.generate` with measured token counts, time
    to first token, time per output token and tokens per second, the device asked for and
    the device used. `instrumentTransformers(module)` in a browser; found by name on Node.
  - WebGPU: `collectWebGpuFacts()`, `enableWebGpuFacts()` (adapter vendor, architecture,
    fallback flag, features, limits on model-load spans), `watchWebGpuDevice()`.
  - cactus-react-native: `instrumentCactus({ CactusLM, CactusSTT })` - download, init,
    complete (the engine's own token counts, time to first token, decode speed, memory,
    tool calls), embed, transcribe.
  - Examples: `examples/browser-transformers` (chat page, and the same on Node),
    `examples/react-native-cactus`.
- `PatchingInstrumentor`: the shared base for module-patching instrumentors, with
  `instrumentModule(module, config)` for bundled applications. Two instrumentors can now
  wrap the same method; `uninstrument()` removes them last in, first out.
- Examples: `examples/openai-compatible`, `examples/groq`, `examples/together`.
- Session scope: `withSession(id, fn, { userId })`, `setSession(id, { userId })` and
  `currentSession()`. Every span started in scope - from any instrumentation - carries
  `session.id` and `gen_ai.conversation.id` (and `user.id`), which is what the platform
  builds a session from. Not present in the Python library, which has only the extractor
  callbacks; an extractor still wins where configured. All three entries export them.
- Browser and React Native entry points, selected by the `browser` and `react-native`
  export conditions (also `./browser` and `./react-native` subpaths): the runtime-agnostic
  core, an explicit `instrument({...})` exporting OTLP/HTTP JSON over `fetch` with no
  default endpoint, `flushTelemetry()`, `uninstrument()`, and `traceGenAiCall()` for
  calls the app makes itself. React Native flushes when the app leaves the foreground.
  See `docs/runtimes.md`.
- `npm run check:bundles`: fails if the browser or React Native bundle reaches a Node
  built-in, reads `process`, or (React Native) uses a DOM global. Run in CI.
- A second, browser-like (happy-dom) test project runs the config, cost,
  semantic-convention and metric contract tests and the new entries' tests.

### Changed
- A wrapped call now returns the very promise the client library returned, observed on a
  side branch, instead of a promise derived from it. Clients that return a promise
  subclass (`withRawResponse()` on Cohere, ElevenLabs, Sarvam) keep their extra methods.
- `GENAI_CUSTOM_PRICING_JSON` (option `customPricingJson`) is now applied by every
  instrumentor, OpenAI and Anthropic included, and by the cost-enrichment processor. This
  is a deliberate difference from Python v1.30.0, where most instrumentors ignore it; see
  `docs/parity-matrix.md` and `contract/SDK_ADDITIONS.md`.
- The core (config, cost, semconv, metrics, logger, base instrumentor) no longer reads
  `process.env` or uses a Node-only global. `loadConfig(overrides, env)` called without
  `env` now reads the environment its entry point supplied: `process.env` when loaded
  through the Node entry (unchanged behaviour), nothing when a core module is imported
  on its own.
- Coverage floor on `config`, `cost` and `metrics` raised from 90% to 95%.
- `examples/e2e/smoke` defaults its model endpoint to a local Ollama
  (`http://localhost:11434/v1`, no API key); `E2E_LLM_BASE_URL` still overrides it.

### Notes
- `npm audit`: one low-severity finding in `esbuild` (development server on Windows),
  reached only through the build tool. It does not ship and is not exercised.
