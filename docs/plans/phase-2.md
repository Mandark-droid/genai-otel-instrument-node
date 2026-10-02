# Phase 2 plan: remaining providers and on-device inference

Scope: spec section 6 (Node providers) and section 6a (on-device set). Reference: the
Python library at v1.30.0, `genai_otel/instrumentors/*.py`. Frameworks, MCP and
datastores are phase 3; GPU, energy, evaluation and media are phase 4.

## Rules for every unit

1. Test first, against the **real client library** pointed at the in-process mock server
   (`tests/helpers/mock-llm.ts`) with hand-written fixtures under `tests/fixtures/<name>/`.
   The fixture test covers: success (span attributes, tokens, cost, metrics), provider
   error (ERROR status, no cost), streaming where the library streams (TTFT, cancelled
   stream), and "library not installed" (skipped, logged, never an error).
2. Span names, `gen_ai.system` values and attribute sets are the Python instrumentor's.
   A behaviour that looks unintended is ported as it behaves and listed in the parity
   matrix; a deliberate difference is listed as one.
3. The client library is an optional peer dependency and a dev dependency, never a
   dependency.
4. Each unit ships: instrumentor, fixture tests, `examples/<name>/` with a README saying
   whether it was run live, a parity-matrix row, a CHANGELOG line, the docs page row.
5. One commit per unit, full suite before and after, pushed.

## Library check (npm, 2026-10-02)

| Provider | Python target | JS library | Version | Status | Decision |
|---|---|---|---|---|---|
| Azure OpenAI | `azure.ai.openai` (legacy client) | `AzureOpenAI` class in `openai` | 7.27 | maintained | Covered by the OpenAI instrumentor, exactly as Python covers `openai.AzureOpenAI`. `@azure/openai` 2.x is a types companion with no client. Test added; no separate instrumentor |
| Azure AI Inference | `azure.ai.inference` | `@azure-rest/ai-inference` | - | REST-path client, no method per operation | Not in the Node target list (spec section 6). Recorded as not ported |
| OpenRouter | `openai` client + base-URL claim | `openai` | | | Port: claim `openrouter.ai`, span `openrouter.chat.completion` / `openrouter.embeddings` |
| CometAPI | `openai` / `anthropic` client + claim | `openai`, `@anthropic-ai/sdk` | | | Port: claim `cometapi.com` |
| Hyperbolic | `requests` to `api.hyperbolic.xyz` | none; OpenAI-compatible | | | Through the OpenAI client by base-URL claim (spec section 6) |
| SambaNova | `sambanova` SDK | none maintained; OpenAI-compatible | | | Through the OpenAI client by base-URL claim |
| Anyscale | no-op in Python (27 lines) | none | | | Registered as a no-op, as in Python |
| vLLM / llama.cpp server | in-process engines in Python | n/a | | | Server endpoints are OpenAI-compatible and already covered; in-process engines are not applicable to JS |
| Groq | `groq` | `groq-sdk` | 1.6.0 | maintained | Port |
| Together | `together` | `together-ai` | 0.57.0 | maintained | Port |
| Mistral | `mistralai` | `@mistralai/mistralai` | 2.7.0 | maintained | Port |
| Cohere | `cohere` | `cohere-ai` | 8.1.0 | maintained | Port |
| Ollama | `ollama` | `ollama` | 0.6.4 | maintained | Port (server-metrics poller is phase 4) |
| Google GenAI | `google.genai`, `google.generativeai` | `@google/genai` | 2.26.0 | maintained | Port. `@google/generative-ai` (0.24.1, last release 2025-04) is end-of-life: not instrumented, recorded |
| Vertex AI | `vertexai` | `@google/genai` with `vertexai: true`; `@google-cloud/vertexai` 1.12.0 | | the latter is superseded | Vertex mode of `@google/genai` is traced by the Google instrumentor as `gen_ai.system = google`, as the reference does; `@google-cloud/vertexai` `GenerativeModel.generateContent` is patched as `vertexai.generate_content` |
| Bedrock | `boto3` bedrock-runtime | `@aws-sdk/client-bedrock-runtime` | 3.1145 | maintained | Port: `InvokeModel`, `InvokeModelWithResponseStream`, `Converse`, plus `ConverseStream` |
| Replicate | `replicate` | `replicate` | 1.4.0 | maintained | Port |
| HuggingFace Inference | `huggingface_hub.InferenceClient` | `@huggingface/inference` | 4.13 | maintained | Port the inference-client half. The `transformers` half is the on-device unit below |
| ElevenLabs | `elevenlabs` | `@elevenlabs/elevenlabs-js` | 2.70 | maintained (`elevenlabs` is deprecated) | Port |
| Sarvam | `sarvamai` | `sarvamai` | 1.1.10 | maintained | Port |
| transformers.js | `transformers` (Python) | `@huggingface/transformers` | 4.3.0 | maintained | New, JS-only shape (spec 6a) |
| WebGPU | none | browser API | | | New, JS-only (spec 6a) |
| cactus | none | `cactus-react-native` | 1.13.1 | maintained | New, JS-only (spec 6a) |
| llama.rn | none | `llama.rn` | 0.13.0-rc | release candidates only | Not in this phase; recorded |

Minimum Node for the libraries: `@google/genai` and `@aws-sdk/client-bedrock-runtime`
need Node 20. Their instrumentors load on Node 18 and skip, as for any absent library.

## Units, in order

| # | Unit | Notes |
|---|---|---|
| 2.1 | `PatchingInstrumentor` | Shared: locate both module copies, patch prototype methods, `instrumentModule(module, config)` for bundled apps, idempotent unpatch. OpenAI and Anthropic keep their own code |
| 2.2 | OpenAI-compatible set | OpenRouter, CometAPI, Hyperbolic, SambaNova, Anyscale; Azure OpenAI test |
| 2.3 | Groq, Together | Stainless-generated clients: same promise and stream machinery as `openai` |
| 2.4 | Mistral, Cohere, Ollama | |
| 2.5 | Google GenAI, Vertex AI | |
| 2.6 | Bedrock | Patch `BedrockRuntimeClient.prototype.send`, dispatch on the command class |
| 2.7 | Replicate, HuggingFace Inference, ElevenLabs, Sarvam | Audio cost by characters / seconds as the Python instrumentors compute it |
| 2.8 | transformers.js | See below |
| 2.9 | WebGPU | See below |
| 2.10 | cactus-react-native | See below |
| 2.11 | Examples | `examples/<provider>/` each; `examples/browser-transformers/` (chat page); `examples/react-native-cactus/` (app modelled on LiquidChat) |

## On-device design (spec 6a)

Nothing can be patched by resolving a module in a browser or in React Native: there is
no `require`, and an ES-module namespace is immutable. The application hands the library
over, and class prototypes are patched:

```js
import * as transformers from '@huggingface/transformers';
import { instrument, instrumentTransformers } from '@traceverse/genai-otel-instrument';
instrument({ serviceName: 'web-chat', endpoint: '...' });
instrumentTransformers(transformers);
```

On Node the same instrumentor is also registered under the name `transformers` and finds
the package itself.

**transformers.js** (`gen_ai.system = huggingface`, as the Python `transformers`
instrumentor):
- `transformers.pipeline.load` span around `pipeline()` / `from_pretrained`: model id,
  task, device requested (`webgpu` / `wasm` / `cpu`), dtype; child facts for download vs
  cache where the progress callback reports them; session-create time.
- `huggingface.pipeline` span (the Python span name) around a pipeline call, and
  `transformers.generate` around `model.generate()`: input and output token counts from
  the tokenizer / output ids, time to first token and tokens per second through a
  streamer hook, finish reason where known.
- Cost: pricing table, else the parameter-count tier (`estimated`), else absent.
- Device actually used versus requested: `gen_ai.request.device`, and
  `webgpu.fallback = true` with the reason when WebGPU was asked for and WASM ran.

**WebGPU**: `collectWebGpuFacts()` reads `navigator.gpu.requestAdapter()` - vendor,
architecture, device, description, `isFallbackAdapter`, selected limits, features - and
returns attributes; `instrument()` in the browser entry adds them to the resource when
asked (`webgpu: true`), and a `device.lost` listener records a span event and a counter.
No utilisation, temperature, power, energy or CO2: the browser exposes none, so none is
emitted - absent, never zero.

**cactus-react-native**: `instrumentCactus({ CactusLM, CactusSTT })` patches
`CactusLM.prototype` `download`, `init`, `complete`, `embed`, `imageEmbed`, and
`CactusSTT.prototype.transcribe`. `complete`: span `cactus.complete`, model from
`getModelName()`, request options, `prefillTokens` -> input tokens, `decodeTokens` ->
output tokens, `timeToFirstTokenMs` -> TTFT, `decodeTps`, `functionCalls` -> tool-call
attributes, `cloudHandoff`, `ramUsageMb`; `onToken` is wrapped to time the stream.
`success: false` ends the span with error status. Fixture tests run against a fake
native layer; a real device run is the lead's.

## Not in this phase

- Framework, MCP and datastore instrumentors (phase 3).
- Ollama server metrics, GPU, energy, CO2, evaluation, media (phase 4).
- `llama.rn`, `@azure-rest/ai-inference`, `@google/generative-ai`: recorded above.
- Live runs against real providers: no keys here. Each example README says so.
- Real-browser and real-device runs: driven by the lead (Playwright, emulator).
