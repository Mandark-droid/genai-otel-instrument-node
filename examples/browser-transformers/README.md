# Browser example: on-device chat with transformers.js, traced

A chat page that runs a small language model in the browser - on WebGPU when the browser
has it, on WASM otherwise - and exports a span for the model load, for each pipeline call
and for each `generate()`.

Spans: `transformers.model.load`, `huggingface.pipeline`, `huggingface.model.generate`.
The generate span carries measured token counts, time to first token, time per output
token and tokens per second; the load span carries the device asked for and the device
used, the dtype, the bytes fetched, and the WebGPU adapter facts.

`run-on-node.js` is the same instrumentation on Node, on the CPU.

## Status

| | |
|---|---|
| Instrumentor tested | Yes: `tests/web/on-device.test.ts`, in Node and in a browser-like environment, against a stand-in shaped like the library |
| Against the real library, on Node | **Yes, run here**: `run-on-node.js` with `Xenova/distilgpt2` on the CPU produced the three spans, with 5 prompt and 8 output tokens, time to first token and the device `cpu` |
| Browser bundle built | **Yes, built here** with `npm run build` (2.1 MB, the model library included) |
| Run in a browser | **No.** No browser was driven where this was written. WebGPU, the WASM fallback and cross-origin export to a collector are therefore not exercised |

## Run it

```bash
# in the repository root
npm ci && npm run build

# in this directory
npm install
npm run build
npm run serve          # http://localhost:8080
```

Then open, for example:

```
http://localhost:8080/?endpoint=http://localhost:4318&session=demo-1
```

| Query parameter | Meaning |
|---|---|
| `endpoint` | Collector base URL. Without it the page works and exports nothing |
| `model` | Hub model id. Default `onnx-community/Qwen2.5-0.5B-Instruct` |
| `device` | `webgpu` or `wasm`. Default: `webgpu` when the browser has an adapter |
| `dtype` | Quantisation, e.g. `q4`, `q4f16`, `fp32`. Default `q4` |
| `session` | `session.id` put on every span |
| `service` | `service.name`. Default `genai-sdk-e2e-web` |
| `max_new_tokens` | Default 64 |

For a test driver: `document.body.dataset.ready` becomes `true` when the model is
loaded; after each turn `dataset.turns` is incremented and `dataset.flushed` says whether
the collector accepted the export.

## What it needs from the network

- **The model weights**, from the Hugging Face hub, on first load (cached by the browser
  afterwards). For an environment with no outbound access, serve the model files
  yourself and set `env.allowRemoteModels = false` and `env.localModelPath` in
  transformers.js.
- **The ONNX runtime WASM files**, which transformers.js loads from a public CDN by
  default. To keep that in-house, serve them yourself and set
  `env.backends.onnx.wasm.wasmPaths`.
- **The collector**, which must accept cross-origin OTLP from the page's origin (CORS)
  on `/v1/traces` and `/v1/metrics`.

## What leaves the device

See [docs/runtimes.md](../../docs/runtimes.md). In short: timings, model name, token
counts, device and adapter description, the session id. Not the conversation text.
