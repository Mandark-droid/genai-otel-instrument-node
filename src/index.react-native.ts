/**
 * genai-otel-instrument-node - React Native entry.
 *
 * The same as the browser entry, with no DOM API either, and with a flush when
 * the app leaves the foreground: pass `appState: AppState` to `instrument()`.
 * `react-native` itself is never imported here.
 */
export * from './core';
export {
  flushTelemetry,
  instrument,
  isInstrumented,
  uninstrument,
  type AppStateLike,
  type ReactNativeInstrumentOptions,
  type WebInstrumentationHandle,
} from './web/instrument';
export { instrumentCactus, instrumentTransformers } from './on-device';
export {
  clearWebGpuFacts,
  collectWebGpuFacts,
  enableWebGpuFacts,
  watchWebGpuDevice,
  WEBGPU_DEVICE_LOST_METRIC,
  webGpuFacts,
  type GpuDeviceLostInfo,
  type GpuLike,
  type WebGpuFacts,
} from './webgpu';
export { traceGenAiCall, type GenAiCall, type GenAiResult } from './web/manual';
