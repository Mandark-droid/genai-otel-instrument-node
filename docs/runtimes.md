# Runtimes: Node, browser, React Native

One package, three entry points over one runtime-agnostic core. A bundler or runtime
picks the entry through the package's conditional exports; nothing has to be configured.

| Entry | Chosen by | File | What it has |
|---|---|---|---|
| Node | default (`import` / `require`) | `dist/index.mjs`, `dist/index.js` | everything: `instrument()` from the environment, the `register` hook, provider instrumentation by module patching, OTLP over http/protobuf or gRPC |
| Browser | the `browser` condition, or `@traceverse/genai-otel-instrument-node/browser` | `dist/index.browser.mjs` (ES modules) | the core, an explicit `instrument({...})`, OTLP/HTTP JSON over `fetch`, `traceGenAiCall()` |
| React Native | the `react-native` condition, or `@traceverse/genai-otel-instrument-node/react-native` | `dist/index.react-native.js` (CommonJS) | the same as the browser entry, no DOM API, plus a flush when the app leaves the foreground |

The core is: configuration (`loadConfig`), the cost calculator and the vendored pricing
table, the semantic-convention constants, the metric registry, and the base instrumentor.
It uses no Node built-in, never reads `process`, and uses no DOM API. Pricing and contract
data are bundled into the files above; nothing is read from disk or fetched at run time.

## Using it in a browser or a React Native app

```js
import { instrument, traceGenAiCall, flushTelemetry } from '@traceverse/genai-otel-instrument-node';

instrument({
  serviceName: 'support-chat-web',
  endpoint: 'https://collector.bank.example',   // required: there is no default
  headers: { 'x-tenant': 'retail' },
});

const answer = await traceGenAiCall(
  { name: 'transformers.generate', system: 'transformers.js', model: 'onnx-community/Qwen2.5-0.5B-Instruct' },
  async () => {
    const text = await generate(prompt);
    return { text, usage: { prompt_tokens: 212, completion_tokens: 48, total_tokens: 260 }, finish_reason: 'stop' };
  },
);
```

React Native, additionally:

```js
import { AppState } from 'react-native';
instrument({ serviceName: 'liquid-chat', endpoint: 'https://collector.bank.example', appState: AppState });
```

### Configuration

There is no process environment in these runtimes. Pass settings to `instrument()`,
either under the option names (`serviceName`, `enableCostTracking`, ...) or under the
**same names as the environment variables**, as strings, which are parsed exactly as the
environment is on Node (`docs/configuration.md`):

```js
instrument({
  OTEL_SERVICE_NAME: 'support-chat-web',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.bank.example',
  GENAI_ENABLE_COST_TRACKING: 'false',
  GENAI_OTEL_LOG_LEVEL: 'DEBUG',
});
```

An option name wins over the same setting given under its environment name. Invalid
values behave as on Node: the reason is logged and the app runs uninstrumented, unless
`failOnError: true`.

Other options: `fetch` (default: the global one), `spanProcessors`, `metricReaders`,
`metricExportIntervalMillis` (default 60000), and for React Native `appState`.

### What leaves the device

Exporting from a browser or a phone is a data path out of the user's device, so:

- **There is no default endpoint.** Without `endpoint` (or `OTEL_EXPORTER_OTLP_ENDPOINT`)
  `instrument()` refuses to start and nothing is sent anywhere.
- What is sent, to `<endpoint>/v1/traces` and `<endpoint>/v1/metrics`, as OTLP/HTTP JSON:
  span names, timings and status; model and provider names; token counts; the cost
  computed from the bundled pricing table; whatever attributes the application passes
  to `traceGenAiCall`; the service name and a random per-load instance id.
- **Not sent:** prompt and completion text. Content capture is off by default, as on
  Node, and `traceGenAiCall` records no content.
- **Not collected:** host name, IP address, process, OS or user attributes. The resource
  carries `service.name`, `service.instance.id`, `telemetry.sdk.*` and
  `telemetry.distro.*` only (plus `deployment.environment.name` when `OTEL_ENVIRONMENT`
  is passed).
- The collector must accept cross-origin OTLP from the page's origin (CORS).

### `traceGenAiCall(call, fn)`

Runs `fn` inside a span and returns exactly what it returns (the same promise, if it
returns one). If the value has a `usage` object (`prompt_tokens`, `completion_tokens`,
`total_tokens`, and the optional cache / reasoning keys) the span gets the token
attributes, the cost and the metrics a patched provider call gets on Node. Without
`usage` the span has no token or cost attributes: absent, not zero. If `fn` throws or
rejects, the span ends with error status and the error is rethrown. Before
`instrument()` it simply calls `fn`.

Cost for an on-device model follows the same rule as everywhere: a model in the pricing
table is priced from it; otherwise a parameter count in the name (`0.5B`, `:7b`, `small`)
selects a size tier and `gen_ai.usage.cost.pricing_source` is `estimated`; otherwise
there is no cost attribute, `pricing_source` is `unpriced`, and the pricing-missing
counter is incremented.

### Sessions

Call `setSession('chat-41', { userId })` once the app knows which conversation it is in;
every span from then on carries `session.id`, `gen_ai.conversation.id` and `user.id`.
`withSession(id, fn)` also exists, but with no context manager in these runtimes it
covers only what `fn` starts synchronously.

### Export behaviour

Spans are batched; ending a span only enqueues it. An export that fails (collector down,
CORS refusal, HTTP error) is dropped and never reaches the application.
`flushTelemetry(seconds)` sends what is queued and resolves `true` only if the collector
accepted it. In React Native, with `appState` given, a flush runs whenever the app goes
to `background` or `inactive`. In a browser the OpenTelemetry batch processor flushes on
`visibilitychange` / `pagehide`.

## On-device models

Hand the library over once; it does not matter whether before or after `instrument()`.

```js
// Browser: transformers.js
import * as transformers from '@huggingface/transformers';
import { enableWebGpuFacts, instrumentTransformers } from '@traceverse/genai-otel-instrument-node';
instrumentTransformers(transformers);
await enableWebGpuFacts();        // optional: adapter facts on model-load spans

// React Native: cactus
import { CactusLM, CactusSTT } from 'cactus-react-native';
import { instrumentCactus } from '@traceverse/genai-otel-instrument-node';
instrumentCactus({ CactusLM, CactusSTT });
```

| Span | When | What it carries |
|---|---|---|
| `transformers.model.load` | `from_pretrained()` (also inside `pipeline()`) | model id; `transformers.device.requested` / `transformers.device`; `transformers.dtype`; `webgpu.fallback` when WebGPU was asked for; `transformers.load.files`, `.bytes`, `.fetch_ms`, `.session_create_ms`; the `webgpu.*` adapter facts once collected |
| `huggingface.model.generate` | `model.generate()` | input and output tokens counted from the tensors; time to first token; time per output token; `transformers.tokens_per_second`; cost |
| `huggingface.pipeline` | a pipeline call | task, model; for feature extraction the vector count and size. No tokens: they are on the generate span |
| `cactus.download`, `cactus.init` | `CactusLM.download()` / `init()` | model, duration |
| `cactus.complete` | `CactusLM.complete()` | the engine's token counts, time to first token, `cactus.decode_tps`, `cactus.prefill_tps`, `cactus.ram_usage_mb`, tool calls, `cactus.cloud_handoff`; a result with `success: false` is an error span |

Cost of an on-device model: from the pricing table if it is there; else the size tier
when the name carries a parameter count (`pricing_source = estimated`); else none.

What a browser does not expose is not reported: GPU utilisation, temperature, power,
energy and CO2 are absent for on-device spans, never zero. Whether model files came from
the cache or the network is not reported either: the library does not say.

Without a context manager in these runtimes, the load, pipeline and generate spans of
one interaction are separate traces; `setSession()` is what ties them together.

## Not in the browser and React Native entries

- Provider instrumentation by module patching (`OpenAIInstrumentor`,
  `AnthropicInstrumentor`) and the `register` hook: Node only.
- `buildResource()` and its host / process / OS detection: Node only.
- gRPC and http/protobuf export: Node only.
- Trace context is not propagated across `await` (there is no `AsyncLocalStorage`):
  spans started inside a traced call are not automatically its children.
- `sendBeacon` export on page unload: not yet.

## How it is kept true

- `npm test` runs the configuration, cost, semantic-convention and metric contract tests
  twice: in Node, and in a browser-like environment (happy-dom), with the browser and
  React Native entry tests.
- `npm run check:bundles` (after `npm run build`) bundles each of the two entries for
  `platform: 'browser'` with all dependencies and fails on any Node built-in in the
  graph, on any read of `process` in our code, and for React Native on any DOM global.
  CI runs it on every push.
