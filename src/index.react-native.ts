/**
 * @traceverse/genai-otel-instrument-node - React Native entry.
 *
 * The same as the browser entry, with no DOM API either, and with a flush when
 * the app leaves the foreground. `react-native` and `cactus-react-native` are
 * picked up when the app has them (optional requires), so `instrument({...})`
 * is the only call an app needs.
 */
export * from './core';
import { instrumentCactus } from './on-device';
import {
  instrument as instrumentWeb,
  type AppStateLike,
  type ReactNativeInstrumentOptions,
  type WebInstrumentationHandle,
} from './web/instrument';

/**
 * A module the app may or may not have. The name is a literal so Metro can resolve it, and the
 * require sits in a try block, which Metro treats as an optional dependency.
 */
function optionalModule(load: () => unknown): unknown {
  try {
    return load();
  } catch {
    return undefined;
  }
}

/**
 * Set up OpenTelemetry in a React Native app: the only call it needs. `AppState` (flush when the
 * app leaves the foreground) and `cactus-react-native` (on-device model calls) are picked up when
 * the app has them; see the browser entry's `instrument()` for the options.
 */
export function instrument(options: ReactNativeInstrumentOptions = {}): WebInstrumentationHandle | undefined {
  const appState =
    options.appState ??
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional, see optionalModule
    (optionalModule(() => require('react-native')) as { AppState?: AppStateLike } | undefined)?.AppState;
  const handle = instrumentWeb({ ...options, appState });
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional, see optionalModule
  const cactus = optionalModule(() => require('cactus-react-native'));
  if (handle && cactus) instrumentCactus(cactus);
  return handle;
}

export {
  flushTelemetry,
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
export type { Destination } from './web/destinations';
