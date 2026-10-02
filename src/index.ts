/**
 * @traceverse/genai-otel-instrument
 *
 * OpenTelemetry instrumentation for GenAI applications on Node.js. A port of
 * the Python library `genai_otel_instrument`: same span attributes, same
 * metrics, same environment variables, same cost figures.
 */
export {
  DEFAULT_OTLP_ENDPOINT,
  exporterTimeoutMillis,
  flushTelemetry,
  instrument,
  instrumentorsReady,
  isInstrumented,
  resolveOtlpProtocol,
  uninstrument,
  warnIfDefaultCollectorUnreachable,
  type InstrumentationHandle,
  type InstrumentOptions,
} from './auto-instrument';
export {
  CONFIG_FIELDS,
  ConfigError,
  DEFAULT_INSTRUMENTORS,
  loadConfig,
  OPT_IN_INSTRUMENTORS,
  type ConfigField,
  type IdExtractor,
  type OTelConfig,
} from './config';
export {
  CostCalculator,
  CostEnrichmentSpanProcessor,
  getDefaultCostCalculator,
  PRICING_MISSING_METRIC,
  type CostCalculatorOptions,
  type GranularCost,
  type PricingSource,
  type Usage,
} from './cost';
export { setLogger, type Logger } from './logger';
export {
  buildResource,
  DISTRO_NAME,
  hostIpAddresses,
  redactCommandArgs,
  SDK_LANGUAGE,
} from './resource';
export {
  availableInstrumentors,
  registerInstrumentor,
  type Instrumentor,
} from './instrumentors/registry';
export { VERSION } from './version';
