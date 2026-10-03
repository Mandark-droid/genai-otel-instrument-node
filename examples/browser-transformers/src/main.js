/**
 * A chat page that runs a small model in the browser with transformers.js and
 * traces it.
 *
 * Configuration comes from the query string, so a test can drive it:
 *   ?endpoint=http://collector:4318   where to export (required: there is no default)
 *   &model=onnx-community/Qwen2.5-0.5B-Instruct
 *   &device=webgpu|wasm               default: webgpu when the browser has it
 *   &dtype=q4f16|q4|fp32...
 *   &session=<id>                     session.id for every span
 *   &service=genai-sdk-e2e-web
 *   &max_new_tokens=64
 */
import * as transformers from '@huggingface/transformers';
import {
  enableWebGpuFacts,
  flushTelemetry,
  instrument,
  instrumentTransformers,
  setSession,
  watchWebGpuDevice,
} from '@traceverse/genai-otel-instrument';

const query = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const status = (text) => {
  $('status').textContent = text;
};
const fact = (name, value) => {
  const term = document.createElement('dt');
  term.textContent = name;
  const detail = document.createElement('dd');
  detail.textContent = String(value);
  $('facts').append(term, detail);
};

const endpoint = query.get('endpoint');
const modelId = query.get('model') ?? 'onnx-community/Qwen2.5-0.5B-Instruct';
const dtype = query.get('dtype') ?? 'q4';

// 1. Telemetry. Without an endpoint nothing is exported and the page still works.
if (endpoint) {
  instrument({ serviceName: query.get('service') ?? 'genai-sdk-e2e-web', endpoint });
  setSession(query.get('session') ?? 'web-' + [...globalThis.crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
} else {
  fact('telemetry', 'off: pass ?endpoint=http://<collector>:4318 to export');
}
// 2. Hand the library over: a browser cannot look a package up by name.
instrumentTransformers(transformers);

// 3. What the browser says about its GPU. Model-load spans carry these facts.
const gpu = await enableWebGpuFacts();
fact('webgpu.available', gpu['webgpu.available']);
if (gpu['webgpu.available']) {
  fact('adapter', [gpu['webgpu.adapter.vendor'], gpu['webgpu.adapter.architecture']].filter(Boolean).join(' / ') || 'not disclosed');
  fact('fallback adapter', gpu['webgpu.adapter.is_fallback'] ?? 'not disclosed');
} else {
  fact('webgpu reason', gpu['webgpu.unavailable_reason']);
}

// 4. Load the model: on WebGPU when there is one, else WASM - and say which.
let device = query.get('device') ?? (gpu['webgpu.available'] ? 'webgpu' : 'wasm');
let generator;
status('Loading ' + modelId + ' on ' + device + '...');
try {
  generator = await transformers.pipeline('text-generation', modelId, { device, dtype });
} catch (error) {
  if (device !== 'webgpu') throw error;
  // WebGPU was asked for and could not be used: fall back, and record why.
  fact('webgpu load error', error?.message ?? error);
  device = 'wasm';
  status('WebGPU failed; loading ' + modelId + ' on wasm...');
  generator = await transformers.pipeline('text-generation', modelId, { device, dtype });
}
fact('device', device);
fact('dtype', dtype);

// A lost GPU device ends generation abruptly; count it rather than guess.
const gpuDevice = transformers.env?.backends?.onnx?.webgpu?.device;
if (gpuDevice?.lost) void watchWebGpuDevice(gpuDevice, { model: modelId });

status('Ready.');
$('send').disabled = false;
document.body.dataset.ready = 'true';

const messages = [{ role: 'system', content: 'You are a helpful assistant. Answer briefly.' }];

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  $('send').disabled = true;
  messages.push({ role: 'user', content: prompt });
  $('log').textContent += 'you: ' + prompt + '\n';
  status('Generating...');
  const started = performance.now();
  try {
    const output = await generator(messages, { max_new_tokens: Number(query.get('max_new_tokens') ?? 64), do_sample: false });
    const reply = output[0].generated_text.at(-1).content;
    messages.push({ role: 'assistant', content: reply });
    $('log').textContent += 'model: ' + reply + '\n';
    status('Done in ' + ((performance.now() - started) / 1000).toFixed(1) + ' s.');
  } catch (error) {
    $('log').textContent += 'error: ' + (error?.message ?? error) + '\n';
    status('Failed.');
  }
  // Export what this turn produced before reporting it done.
  const flushed = endpoint ? await flushTelemetry(10) : undefined;
  document.body.dataset.turns = String((Number(document.body.dataset.turns) || 0) + 1);
  document.body.dataset.flushed = String(flushed);
  $('send').disabled = false;
});
