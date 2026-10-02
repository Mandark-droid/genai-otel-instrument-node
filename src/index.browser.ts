/**
 * @traceverse/genai-otel-instrument - browser entry.
 *
 * The runtime-agnostic core, an explicit `instrument({...})` that exports OTLP
 * over `fetch`, and `traceGenAiCall()` for calls the application makes itself.
 * No Node built-in, no `process`. Provider instrumentation by module patching
 * and the zero-code register hook are Node-only and are not here.
 */
import { instrument as start, type WebInstrumentationHandle, type WebInstrumentOptions } from './web/instrument';

export * from './core';
export {
  flushTelemetry,
  isInstrumented,
  uninstrument,
  type WebInstrumentationHandle,
  type WebInstrumentOptions,
} from './web/instrument';
export { traceGenAiCall, type GenAiCall, type GenAiResult } from './web/manual';

export function instrument(options: WebInstrumentOptions = {}): WebInstrumentationHandle | undefined {
  return start(options);
}
