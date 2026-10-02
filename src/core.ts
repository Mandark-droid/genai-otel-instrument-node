/**
 * The runtime-agnostic core: configuration, cost, semantic conventions, the
 * metric registry and the base instrumentor.
 *
 * Nothing reachable from here may use a Node built-in, `process`, or a DOM API:
 * this is what the browser and React Native entries are made of.
 * `scripts/check-browser-bundle.mjs` enforces it on the built bundles.
 */
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
export { type Env } from './env';
export { setLogger, type Logger } from './logger';
export {
  BASE_METER_NAME,
  getSharedMetrics,
  METRIC_DEFINITIONS,
  metricViews,
  type MetricDefinition,
  type MetricName,
  type SharedMetrics,
} from './metrics';
export {
  BaseInstrumentor,
  StreamTiming,
  type AttributeExtractor,
  type Params,
  type UsageDict,
} from './instrumentors/base';
export type { Instrumentor } from './instrumentors/registry';
export {
  ATTR,
  genaiSemconvModes,
  genaiTierOptedIn,
  SemanticConvention,
  SUPERSEDED_ATTRIBUTES,
  type SemconvModes,
} from './semconv';
export {
  currentSession,
  SessionSpanProcessor,
  setSession,
  withSession,
  type SessionOptions,
  type SessionScope,
} from './session';
export { VERSION } from './version';
