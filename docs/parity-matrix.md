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
| Agent budget governance | shipped | `gen_ai.agent.iteration_budget`, `gen_ai.agent.token_budget`, the two `.consumed` attributes and the `gen_ai.invoke_agent.token_budget.utilization` histogram, accumulated through the context so that sampled-out child calls still count |
| Server concurrency gauge (`GENAI_ENABLE_CONCURRENCY_METRICS`) | planned, phase 4 | |
| GPU, energy, CO2 metrics | **shipped** for NVIDIA on Node | 16 per-device gauges and 4 aggregates from `nvidia-smi`, polled every `GENAI_GPU_COLLECTION_INTERVAL` seconds; energy, electricity cost and CO2 from measured GPU power. Parsed against the real output of an RTX 5090 Laptop GPU (driver 592.02). **Not shipped:** AMD (`amd-smi`), CPU and RAM energy, PCIe throughput. Not run on a multi-GPU or data-centre host. See [gpu-energy.md](gpu-energy.md) |
| Evaluation (PII, toxicity, bias, prompt injection, restricted topics, hallucination) and pre-call blocking | **shipped** | The five rule-based detectors match all 170 of their vectors in `contract/eval_vectors.json` exactly, floats included, and the span attributes match the 10 non-toxicity `span_attribute_vectors`. Rules are generated from `contract/eval_rules.json`; Python `re` semantics (Unicode `\w \d \s \b`, code-point offsets) are reproduced. Toxicity: see the differences table. Pre-call blocking throws `PolicyViolationError`. See [evaluation.md](evaluation.md) |
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
| `replicate` | `replicate` | **shipped** - `run()`. No tokens and no cost: Replicate bills by hardware time, as the reference notes |
| `elevenlabs` | `@elevenlabs/elevenlabs-js` | **shipped** - `textToSpeech.convert` / `stream` (cost by character), `speechToText.convert` (cost by second) |
| `sarvamai` | `sarvamai` | **shipped** - chat completions, translate, transliterate, identify-language, speech-to-text (transcribe, translate), text-to-speech (convert, stream); cost per thousand characters |
| `openrouter` | `openai` at `openrouter.ai` | **shipped** - chat completions (buffered, streamed, tool calls), embeddings |
| `cometapi` | `openai` / `@anthropic-ai/sdk` at `cometapi.com` | **shipped** - chat completions, embeddings, `messages.create` |
| `hyperbolic` | `openai` at `api.hyperbolic.xyz` | **shipped** - chat completions. Not in the default list, as in the reference: enable it by name. The reference traces raw `requests.post`; JavaScript applications use the OpenAI client |
| `sambanova` | `openai` at `api.sambanova.ai` | **shipped** - chat completions. The reference patches the `sambanova` Python SDK; there is no maintained JavaScript one |
| `anyscale` | `openai` | **shipped** as the no-op it is in the reference; calls are traced by the `openai` instrumentor |
| `vllm`, `llamacpp` (server) | `openai` with a base URL | Traced by the `openai` instrumentor with the endpoint in `server.address`. Server-metrics pollers: phase 4 |
| `transformers` (inference client half) | `@huggingface/inference` | **shipped, by wrapping** - `chatCompletion`, `chatCompletionStream`, `textGeneration` on a client passed through `traceHuggingFaceClient()`. The client cannot be patched from outside (per-instance non-configurable methods, read-only exports) |
| `transformers` (local pipeline half) | `@huggingface/transformers` (transformers.js) | **shipped** - `huggingface.pipeline`, `huggingface.model.generate`, and `transformers.model.load`. On Node found by name; in a browser handed over with `instrumentTransformers()` |
| `litellm_latency`, `litellm` | - | not applicable: LiteLLM is a Python library. A LiteLLM *gateway* is reached through the `openai` client and is traced by the `openai` instrumentor |
| `llamacpp` (in-process), `vllm` (in-process) | - | not applicable: Python in-process bindings |
| `sentence_transformers` | - | not applicable: Python-only library |
| `liquid_audio` | - | not applicable: Python-only library |

## Frameworks

| Reference id | Node library | Status |
|---|---|---|
| `langchain` | `@langchain/core` | **shipped** - `langchain.chat_model.invoke` / `.batch` / `.stream` on `BaseChatModel` (provider from the class name, model, message count, tokens, cost) and `langchain.chain.<Class>` on runnable sequences, which are the chains of the JavaScript library. Not ported: `langchain.agent.execute` (`AgentExecutor` lives in the separate `langchain` package and is superseded by LangGraph there) |
| `langgraph` | `@langchain/langgraph` | **shipped** - `langgraph.graph.invoke` / `langgraph.graph.stream` on a compiled graph: node, edge and channel structure, thread and checkpoint ids, recursion limit as the iteration budget, and what the model calls inside consumed. One span per run (`invoke` runs through `stream`). The sequences LangGraph builds around its nodes are not reported as LangChain chains |
| `llama_index` | `llamaindex` | **shipped** - `llamaindex.query_engine` on `BaseQueryEngine.query`, as far as the reference goes |
| `openai_agents` | `@openai/agents` | **shipped** - `openai_agents.runner.run` on `Runner.run` (which the package's `run()` also goes through): agent, tools, handoffs, guardrails, turn limit as the iteration budget, output length, guardrail results. No `run_sync` in the JavaScript library |
| `google_adk` | `@google/adk` | **shipped** - `google_adk.runner.run` on `Runner.runAsync`, open until the event stream ends: app, agent, sub-agents, tools, user and session. No `run_debug` in the JavaScript library |
| `bedrock_agents` | `@aws-sdk/client-bedrock-agent-runtime` | **shipped** - `bedrock.agents.invoke_agent`, `bedrock.agents.retrieve`, `bedrock.agents.retrieve_and_generate` on the client's `send`, by command; every other command passes through untraced. The `InvokeAgent` span ends when the call returns, before the completion stream is read, as in the reference |
| `mcp_client`, `mcp` | `@modelcontextprotocol/sdk` | **shipped**, opt-in by name as in the reference - one client span per `callTool` with the `mcp.*` / `commerce.*` attribution (server, stage, behaviour, idempotency, tool-selection correctness, hallucinated identifiers, cart hash, duplicate placement); the tool registry, session tracker and identifier hashing of `mcp_semconv`. Checked against vectors generated by running the reference. The terminal-state classifier (`terminal_state.py`) is not ported yet: phase 4 |
| `autogen`, `autogen_agentchat` | - | not applicable: no maintained JavaScript port of AutoGen |
| `crewai` | - | not applicable: Python-only |
| `dspy` | - | not applicable: Python-only |
| `haystack` | - | not applicable: Python-only |
| `instructor` | `@instructor-ai/instructor` | **not ported.** It wraps the `openai` client, whose calls are traced by the OpenAI instrumentor; the reference's own `instructor.*` spans are not produced |
| `guardrails` | - | not applicable: Python-only |
| `pydantic_ai` | - | not applicable: Python-only |
| `smolagents` | - | not applicable: Python-only |
| `strands` | `@strands-agents/sdk` | **not ported** |
| `typesafe` | - | to be confirmed in phase 2: no JavaScript client known |
| - | Vercel AI SDK (`ai` 7 with `@ai-sdk/otel`) | **shipped**, JavaScript only - the SDK's functions cannot be patched and it emits OpenTelemetry spans itself; a span processor fills in provider, operation and total tokens on them, the cost processor prices the model-call span (not the `invoke_agent` span that repeats its tokens), the session is applied, and the prompts and responses the SDK records are removed unless content capture is on. Both attribute styles of `@ai-sdk/otel` (`ai.*` and `gen_ai.*`) are covered. Node entry only: the browser and React Native entries do not install the processor |
| - | Mastra (`@mastra/core`) | **not exercised.** Named in the design; nothing was built or run for it. Spans it exports through OpenTelemetry that carry `gen_ai.request.model` and `gen_ai.usage.*` would be priced by the cost processor like any other; that is untested |

A name from the reference list that is not shipped here is skipped at start-up. When it
was requested explicitly (`GENAI_ENABLED_INSTRUMENTORS` or the `enabledInstrumentors`
option) a warning says so; with the default list it is logged at debug level.

## Datastores and tools

Started together when `GENAI_ENABLE_MCP_INSTRUMENTATION` is on (the default), as the
reference's `MCPInstrumentorManager` does. Each is skipped when its library is not
installed. Every operation is one client span plus the four `mcp.*` metrics
(`mcp.requests`, `mcp.client.operation.duration`, `mcp.request.size`,
`mcp.response.size`).

| Store | Reference | Node library | Status |
|---|---|---|---|
| PostgreSQL | psycopg2 (contrib span + metrics) | `pg` | **shipped** - span named for the verb, `db.system = postgresql`; pool queries counted once |
| TimescaleDB | psycopg2 cursor | `pg` | **shipped** - a statement using a TimescaleDB function is named `timescaledb.<operation>`, with the reference's operation list |
| MySQL | mysql-connector | `mysql2` | **shipped** - `query`, `execute`, also through the promise wrapper |
| MongoDB | pymongo | `mongodb` | not ported: not in the Node target list |
| SQLAlchemy | sqlalchemy | - | not applicable: a Python ORM; the drivers are covered directly |
| Redis | redis-py (contrib span) | `redis`, `ioredis` | **shipped** - span named for the command |
| FalkorDB | falkordb | `falkordb` | **shipped** - `falkordb.query`, `falkordb.ro_query`, `falkordb.delete`, `falkordb.copy` |
| Kafka | kafka-python (contrib span) | `kafkajs` | **shipped** - `<topic> send` (producer), `<topic> receive` (consumer, around the application's `eachMessage`). `@confluentinc/kafka-javascript` is not covered |
| RabbitMQ | pika | `amqplib` | **shipped** - `rabbitmq.basic_publish`, `basic_consume`, `basic_get`, `queue_declare`, `queue_delete`, `exchange_declare`, `exchange_delete`; patched when the first connection and channel are created |
| OpenSearch | opensearch-py (contrib span) | `@opensearch-project/opensearch` | **shipped** - `opensearch.<api>` (`search`, `bulk`, `doc`, ...), with the index |
| Elasticsearch | elasticsearch-py (contrib span) | `@elastic/elasticsearch` | **shipped, metrics only** - the client creates its own OpenTelemetry span per request; this adds the `mcp.*` metrics, which is the reference's own split |
| MinIO | minio | `minio` | **shipped** - `minio.put_object`, `get_object`, `remove_object`, `list_objects`, `make_bucket`, `remove_bucket`, `list_buckets`, `stat_object`, `fput_object`, `fget_object`, with bucket and object |
| S3 | - | `@aws-sdk/client-s3` | **shipped** (not present in Python) - `s3.<operation>` for every command, with bucket and key |
| Qdrant | qdrant-client | `@qdrant/js-client-rest` | **shipped** - `qdrant.query_points`, `qdrant.search`, with collection, top-k and the `rag.result.score_*` summary |
| Pinecone | pinecone | `@pinecone-database/pinecone` | **shipped** - `pinecone.index.query`, `.upsert`, `.delete`, with the score summary |
| Chroma | chromadb | `chromadb` | **shipped** - `chroma.query`; the collection class is patched when the client first hands one back |
| Milvus | pymilvus | `@zilliz/milvus2-sdk-node` | **shipped** - `milvus.search` |
| Weaviate | weaviate-client | `weaviate-client` | not ported: the v3 client builds its query objects per collection and its classes can only be reached through a live connection |
| FAISS, LanceDB | faiss, lancedb | - | not ported: not in the Node target list |
| HTTP | httpx | global `fetch` | **shipped**, off by default (`GENAI_ENABLE_HTTP_INSTRUMENTATION`) - `api.call.<method>.<host>`. `url.full` is recorded without its query string, which can carry credentials |

## Not present in Python

Additions fixed across all four SDKs by `contract/SDK_ADDITIONS.md`, so that they agree
with each other where the reference has nothing to agree with.

| Addition | Definition |
|---|---|
| Counter `gen_ai.usage.cost.pricing_missing` | unit `""`, meter `genai_otel.instrumentors.base`, attributes `model` and `call_type`. Incremented once per span whose model has no price, including the 13 pricing-table entries on which the calculator raises |
| `withSession(id, fn, { userId })`, `setSession(id, { userId })`, `currentSession()` | The reference has only the `session_id_extractor` / `user_id_extractor` callbacks (ported). These set `session.id` + `gen_ai.conversation.id` (+ `user.id`) on every span started in scope, from any instrumentation. Confirmed as the cross-SDK shape (`contract/SDK_ADDITIONS.md` section 4) |
| Cohere `chat` / `chatStream` spans (`cohere.chat`) | The reference Cohere instrumentor wraps only `generate` and `embed`. `generate` is Cohere's legacy endpoint; without `chat` a current Cohere application produces no span. Pending confirmation as a cross-SDK addition |
| On-device spans: `transformers.model.load`, `cactus.download`, `cactus.init`, `cactus.complete`, `cactus.embed`, `cactus.stt.transcribe`; attributes `transformers.device`, `transformers.device.requested`, `transformers.dtype`, `transformers.load.*`, `transformers.tokens_per_second`, `webgpu.*`, `cactus.*`; counter `webgpu.device.lost` | JavaScript only: models that run in the page or on the phone. `gen_ai.*` attributes are used wherever one exists (tokens, time to first token, model, cost) |
| MCP server span `mcp.server.call_tool <tool>` (server kind) | The reference instruments the MCP client only. Here the point where an `McpServer` runs a tool handler is wrapped too, so both sides of a call are spans |
| `withMcpSession()` is also a session scope | In the reference `mcp_session()` puts the session id on MCP spans only, and model spans get it through the extractor. Here everything started inside carries `session.id` |
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
| transformers.js (`instrumentTransformers`) | yes, also by name | yes | yes |
| WebGPU adapter facts (`collectWebGpuFacts`, `enableWebGpuFacts`, `watchWebGpuDevice`) | n/a | yes | n/a |
| cactus-react-native (`instrumentCactus`) | n/a | n/a | yes |

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
| Text-to-speech audio streams (ElevenLabs, Sarvam) | The audio iterator is wrapped: the span covers the whole synthesis and records time to first byte | The span ends when the stream is handed to the application | The JavaScript clients return a web `ReadableStream`, usually read through a reader or piped; that cannot be observed in place without replacing the object the application receives |
| `huggingface.pipeline` token counts | Estimated from text length and marked as estimated; the `generate` span nested in it carries counts too | The pipeline span carries no tokens and no cost; the nested `huggingface.model.generate` span carries the measured ones | Both carrying them counts every token twice |
| Model load: cache or download | n/a | Not reported | transformers.js does not say which happened; a guess from timing would be a fabricated fact. Fetch time and session-create time are reported instead |
| Datastore spans | Taken from the OpenTelemetry contrib instrumentation of each driver (psycopg2, redis, kafka, elasticsearch, httpx); this library adds the `mcp.*` metrics | Made by this SDK, to the same database conventions (`db.system`, `db.operation`, `db.name`, `db.user`, `net.peer.name`, `net.peer.port`, client kind), plus the same metrics | The contrib packages for Node hook module loading, which misses modules loaded earlier and needs a second loader flag for ES-module applications. Prototype patching works for both, with no extra dependency |
| `db.statement` | Recorded always by the contrib instrumentations; FalkorDB records it bounded | Recorded only with content capture on, bounded by `GENAI_CONTENT_MAX_LENGTH` (2000 characters when that is 0). Bound parameter values and Redis values are never recorded; `AUTH` arguments never | A statement can carry literal personal data; telemetry must not collect it by accident |
| `db.system` label on the `mcp.*` metrics | The Python driver's name (`psycopg2`, `mysql`, `pymongo`) | The database (`postgresql`, `mysql`, `redis`, ...), the same value as the span attribute | A driver name of another language means nothing here; the label matches the span |
| Content on framework spans | Recorded always, bounded to 200 or 500 characters: agent instructions, run input and output (`openai.agent.*`), graph state (`langgraph.input.*`, `langgraph.output.*`), `google_adk.input_message`, `bedrock.agent.input_text`, `bedrock.retrieval.query`, `bedrock.rag.*_text`, `llamaindex.query` | Recorded only with content capture on, bounded by `GENAI_CONTENT_MAX_LENGTH` (the reference's bound when that is unset). Names, counts, lengths and identifiers are always recorded | Content capture is off by default in this SDK, and a framework span is not an exception to it. **Pending the lead's confirmation** |
| Session of the calls inside a framework run | Each span resolves its own session | A span that carries a session id of its own (a graph's thread, an agent session, a `sessionId` in the request) puts it in force for the calls made inside it, unless a `withSession` scope is already open | Otherwise the model calls of a run would be in no session, or in a different generated one each |
| Session fallback for LangChain and LangGraph | call arguments, extractor, a generated UUID | call arguments, extractor, the session in scope (`withSession`), a generated UUID | The scope is this SDK's way to name a session; a generated id must not displace it |
| Bedrock `RetrieveAndGenerate` inference parameters | Read from `inferenceConfig.temperature` / `maxTokens` / `topP` | Read from `inferenceConfig.textInferenceConfig.*`, then from the reference's place | The API nests them; the reference's path never matches a real request |
| Toxicity with nothing to measure it | The detector answers "not toxic" and the span gets `evaluation.toxicity.<prompt\|response>.detected = false` | **No toxicity attribute and no toxicity metric.** The detector's own return value is the reference's (the 24 toxicity vectors pass); nothing downstream reads it as a measurement | A "false" that nothing measured is a fabricated measurement. Decided by the lead |
| Toxicity backends | Detoxify (local model), Perspective API | A scorer function the application supplies, synchronous or asynchronous (`setToxicityScorer`). No model and no client ships | No Python dependency; no call out of the organisation made by this package |
| Where spans are evaluated | Inside each instrumentor before the span ends, and again in a span processor for other spans | One span processor, in `onEnding`, for every span; an instrumented call hands it the full prompt and the response | The JS SDK lets a processor write a span that is ending |
| `evaluation.completed` | Set on every span the processor sees | Set only on a span that had a prompt or a response to evaluate | A database or HTTP span is not "evaluated" |
| Evaluation metric instruments | All 22 created at start-up | Created on first use | A detector that never fires leaves no empty series |
| Response text on streamed calls | Not evaluated (the result is a stream) | The same: prompt evaluated, response not | |
| Server gauges before anything was measured | `gen_ai.server.requests.running` / `.waiting` / `.max` report 0 from start-up | Each reports nothing until its value was set once | A zero nobody measured is not reported |
| Ollama model share when the host's VRAM is unknown | Computed against an assumed 8 GB | Not reported; one log line says to set `GENAI_OLLAMA_MAX_VRAM_GB` | A percentage of an assumed denominator is not a measurement |
| `gen_ai.latency.*` from llama.cpp `timings` | Set by the in-process `llama_cpp` instrumentor only | Set on any instrumented call whose response carries a `timings` object (a llama.cpp server behind an OpenAI-compatible client) | There is no in-process llama.cpp in Node; the server reports the same timings over HTTP |
| How the GPU is read | NVML in-process (`nvidia-ml-py`), each gauge reading the device when collected | `nvidia-smi --query-gpu` run on an interval; the gauges report the latest sample | There is no NVML binding for Node to depend on. Named in the design |
| GPU energy, electricity cost and manual CO2 | `energy = (power_w / 1000) * seconds`, then used as watt-hours: **3.6 times too high** | `energy_kWh = watts x seconds / 3 600 000`, with the mean power of the interval's two ends | The reference's line multiplies kilowatts by seconds and calls it watt-hours. **Pending the lead's confirmation** (a cross-SDK decision) |
| Energy and CO2 source | codecarbon when installed (CPU + GPU + RAM, regional grid data); otherwise the manual formula | Measured GPU power only; CO2 is that energy times `GENAI_CARBON_INTENSITY` (default 475 gCO2e/kWh). The `GENAI_CO2_*` location and mode variables are read and have no effect | No codecarbon outside Python; the staged contract has no carbon-intensity table to vendor. CPU and RAM energy are not measured, so not reported |
| `gen_ai.codecarbon.task.duration` | Recorded per codecarbon task | Never recorded | There is no codecarbon task |
| `gen_ai.gpu.pcie.tx` / `.rx` | From NVML | Never reported | `nvidia-smi --query-gpu` has no such field |
| A GPU field the device does not report | The NVML call raises and the observation is skipped | `[N/A]` in the output: no point for that gauge and device | The same outcome by a different road |
| GPU source failing | Each gauge callback logs an error on every collection, forever | After 5 consecutive failed samples collection stops, with one warning | "Not zeros and not a crash loop" (plan, phase 4) |
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
| 16 | A LangChain chat-model span carries the tokens and cost the model reported, and so does the provider span beneath it when that provider's client is instrumented too. Summing both counts the call twice | `langchain_instrumentor.py` (`_extract_usage`) |
| 17 | With no session to be found, LangChain and LangGraph spans get a generated UUID as `session.id`, so unrelated calls each look like a session of their own | `langchain_instrumentor.py`, `langgraph_instrumentor.py` (`_resolve_session_id`) |
| 18 | `gen_ai.request.model` on an OpenAI Agents run is the agent's name, not a model | `openai_agents_instrumentor.py` (`_extract_runner_attributes`) |
| 19 | Agent-framework spans (OpenAI Agents, Google ADK, Bedrock Agents) carry no tokens of their own; the Bedrock `InvokeAgent` span ends before its completion stream is read | `openai_agents_instrumentor.py`, `google_adk_instrumentor.py`, `bedrock_agents_instrumentor.py` (`_extract_usage`) |
| 20 | Evaluation false positives are the reference's: "She is a doctor." is gender bias (0.4, at the threshold); restricted-topic keywords match as substrings (`harm` in "pharmacy"); the hallucination sentence extractor stops at a decimal point ("...earned $45." is reported as a claim); a spaced 16-digit card is also reported as `IN_AADHAAR` | `evaluation/*_detector.py`; pinned by `contract/eval_vectors.json` |
| 21 | Two thresholds differ between the detector's own default and what the environment gives: restricted topics 0.5 / 0.7, hallucination 0.7 / 0.6. `instrument()` uses the environment's, as the reference does | `evaluation/config.py`, `config.py` |
| 22 | PII `threshold` and `allow_list` are ignored by the pattern path; 12 of 22 entity types (names, locations, IBAN, ...) have no pattern, in GDPR / HIPAA / PCI mode too | `pii_detector.py` (`_fallback_detection`) |
| 23 | Prompt-injection `patterns`, `check_patterns`, `use_ml_model` and `log_attempts` are accepted and ignored | `prompt_injection_detector.py` |
| 24 | On a response, a blocking detector only annotates: the response has already been returned to the application | `evaluation/span_processor.py` |
| 25 | What the Ollama poller reports as `gen_ai.server.kv_cache.usage` is each loaded model's VRAM as a share of the GPU's, not KV-cache usage; `gen_ai.server.requests.max` is the number of loaded models, not a request capacity | `ollama_server_metrics_poller.py` (`_collect_metrics`) |
| 26 | `gen_ai.server.requests.running` counts client calls in flight in this process, not requests running on a server | `instrumentors/base.py` (`increment_requests_running`) |
