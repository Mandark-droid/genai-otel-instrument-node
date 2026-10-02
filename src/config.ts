/**
 * Configuration, loaded from the same environment variables as the Python
 * library (`genai_otel/config.py`, class `OTelConfig`) with the same defaults
 * and the same parsing.
 *
 * "The same parsing" is meant literally. The Python fields are small
 * expressions - `os.getenv(X, "true").lower() == "true"`, `float(os.getenv(X))`
 * - and their corner cases are part of the contract: `yes` is not true, a
 * leading space defeats a boolean, a garbage float raises. Each field below
 * names the expression it ports, and `contract/config.json` checks the result.
 */
import { logger } from './logger';

/** Raised where the Python library raises `ValueError` while building `OTelConfig`. */
export class ConfigError extends Error {
  readonly envVar: string | undefined;

  constructor(message: string, envVar?: string) {
    super(message);
    this.name = 'ConfigError';
    this.envVar = envVar;
  }
}

export type IdExtractor = (instance: unknown, args: unknown[], params: Record<string, unknown>) => string | undefined | null;

export interface OTelConfig {
  serviceName: string;
  endpoint: string;
  enabledInstrumentors: string[];
  enableGpuMetrics: boolean;
  enableCostTracking: boolean;
  enableMcpInstrumentation: boolean;
  enableHttpInstrumentation: boolean;
  failOnError: boolean;
  /** Programmatic only. `OTEL_EXPORTER_OTLP_HEADERS` is read by the exporters themselves. */
  headers: Record<string, string> | undefined;
  enableCo2Tracking: boolean;
  /** Seconds, as in the Python library - not the milliseconds of the OTel specification. */
  exporterTimeout: number;
  carbonIntensity: number;
  powerCostPerKwh: number;
  gpuCollectionInterval: number;
  co2CountryIsoCode: string | undefined;
  co2Region: string | undefined;
  co2CloudProvider: string | undefined;
  co2CloudRegion: string | undefined;
  co2OfflineMode: boolean;
  co2TrackingMode: string;
  co2UseManual: boolean;
  codecarbonLogLevel: string;
  samplingRate: number;
  metricsProfile: string;
  recordTokenHistograms: boolean;
  recordGranularCostMetrics: boolean;
  recordFinishMetrics: boolean;
  enableConcurrencyMetrics: boolean;
  profile: string;
  allowExternalEgress: boolean;
  airGapped: boolean;
  semconvStabilityOptIn: string;
  flushOnSigterm: boolean;
  sigtermFlushTimeout: number;
  enableContentCapture: boolean;
  captureEmbeddingVectors: boolean;
  contentMaxLength: number;
  customPricingJson: string | undefined;
  enablePiiDetection: boolean;
  piiMode: string;
  piiThreshold: number;
  piiGdprMode: boolean;
  piiHipaaMode: boolean;
  piiPciDssMode: boolean;
  /** Programmatic only. */
  piiCustomPatterns: Record<string, unknown>;
  enableToxicityDetection: boolean;
  toxicityThreshold: number;
  toxicityUsePerspectiveApi: boolean;
  toxicityPerspectiveApiKey: string | undefined;
  toxicityBlockOnDetection: boolean;
  enableBiasDetection: boolean;
  biasThreshold: number;
  biasBlockOnDetection: boolean;
  enablePromptInjectionDetection: boolean;
  promptInjectionThreshold: number;
  promptInjectionBlockOnDetection: boolean;
  enableRestrictedTopics: boolean;
  restrictedTopicsThreshold: number;
  restrictedTopicsBlockOnDetection: boolean;
  enableHallucinationDetection: boolean;
  hallucinationThreshold: number;
  mediaCaptureMode: string;
  mediaStore: string;
  mediaStoreEndpoint: string | undefined;
  mediaStoreBucket: string;
  mediaStorePrefix: string;
  mediaStoreAccessKey: string | undefined;
  mediaStoreSecretKey: string | undefined;
  mediaMaxBytes: number;
  mediaAllowedModalities: string;
  mediaRedactor: string | undefined;
  /** Programmatic only. `(instance, args, params) => session id`. */
  sessionIdExtractor: IdExtractor | undefined;
  /** Programmatic only. `(instance, args, params) => user id`. */
  userIdExtractor: IdExtractor | undefined;
}

/**
 * Instrumentors enabled when `GENAI_ENABLED_INSTRUMENTORS` is unset.
 *
 * This is the Python list verbatim (`DEFAULT_INSTRUMENTORS` on Python >= 3.10),
 * because the variable and its default are part of the cross-language contract.
 * Names with no Node counterpart are skipped at instrumentation time; which
 * ones exist is recorded in docs/parity-matrix.md.
 */
export const DEFAULT_INSTRUMENTORS: readonly string[] = Object.freeze([
  'openai',
  'openrouter',
  'cometapi',
  'anthropic',
  'google.generativeai',
  'boto3',
  'azure.ai.inference',
  'azure.ai.openai',
  'cohere',
  'mistralai',
  'together',
  'groq',
  'llamacpp',
  'ollama',
  'vllm',
  'vertexai',
  'replicate',
  'anyscale',
  'sambanova',
  'sarvamai',
  'elevenlabs',
  'langchain',
  'langgraph',
  'llama_index',
  'transformers',
  'sentence_transformers',
  'liquid_audio',
  'autogen',
  'autogen_agentchat',
  'google_adk',
  'pydantic_ai',
  'openai_agents',
  'bedrock_agents',
  'crewai',
  'smolagents',
  'litellm',
  'typesafe',
]);

/** Opt-in only in the Python library; listed so an explicit request is recognised. */
export const OPT_IN_INSTRUMENTORS: readonly string[] = Object.freeze(['litellm_latency', 'strands']);

export const OTEL_GENAI_CAPTURE_MESSAGE_CONTENT = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';

/** `_CONTENT_CAPTURE_MODES`: EVENT_ONLY is deliberately false, see config.py. */
export const CONTENT_CAPTURE_MODES: Readonly<Record<string, boolean>> = Object.freeze({
  NO_CONTENT: false,
  SPAN_ONLY: true,
  EVENT_ONLY: false,
  SPAN_AND_EVENT: true,
});

/** `GENAI_PROFILE` values that lock the deployment down. */
export const HARDENED_PROFILES: ReadonlySet<string> = new Set(['strict', 'bfsi', 'bank']);

const PY_FLOAT = /^[+-]?(?:\d+(?:_\d+)*\.?(?:\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const PY_FLOAT_SPECIAL = /^([+-]?)(?:inf(?:inity)?|(nan))$/i;
const PY_INT = /^[+-]?\d+(?:_\d+)*$/;

/** Python `float(str)`: surrounding whitespace, `_` digit separators, inf/nan; raises on anything else. */
export function pyFloat(raw: string): number {
  const text = raw.trim();
  const special = PY_FLOAT_SPECIAL.exec(text);
  if (special) {
    if (special[2] !== undefined) return Number.NaN;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  if (!PY_FLOAT.test(text)) throw new ConfigError(`could not convert string to float: '${raw}'`);
  return Number(text.replace(/_/g, ''));
}

/** Python `int(str)`: base 10, surrounding whitespace, `_` digit separators; raises on anything else. */
export function pyInt(raw: string): number {
  const text = raw.trim();
  if (!PY_INT.test(text)) throw new ConfigError(`invalid literal for int() with base 10: '${raw}'`);
  return Number.parseInt(text.replace(/_/g, ''), 10);
}

export type ConfigFieldKind =
  /** `os.getenv(X, default)` */
  | 'str'
  /** `os.getenv(X, default).lower()` */
  | 'str_lower'
  /** `os.getenv(X)` - undefined when unset */
  | 'opt_str'
  /** `os.getenv(X, default).lower() == "true"` */
  | 'bool'
  /** `os.getenv(X, default).strip().lower() == "true"` */
  | 'bool_strip'
  /** `float(os.getenv(X, default))` - raises on garbage */
  | 'float'
  /** `int(os.getenv(X, default))` - raises on garbage */
  | 'int'
  /** `_get_exporter_timeout()` - int, warns and falls back to 60 on garbage */
  | 'int_timeout'
  /** `_get_enabled_instrumentors()` */
  | 'instrumentors';

export interface ConfigField {
  readonly field: keyof OTelConfig;
  readonly env: string;
  readonly kind: ConfigFieldKind;
  /** The default exactly as the Python source passes it to `os.getenv`. */
  readonly default?: string;
}

const f = (field: keyof OTelConfig, env: string, kind: ConfigFieldKind, def?: string): ConfigField =>
  Object.freeze({ field, env, kind, default: def });

/** One row per environment-driven `OTelConfig` field, in Python declaration order. */
export const CONFIG_FIELDS: readonly ConfigField[] = Object.freeze([
  f('serviceName', 'OTEL_SERVICE_NAME', 'str', 'genai-app'),
  f('endpoint', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'str', 'http://localhost:4318'),
  f('enabledInstrumentors', 'GENAI_ENABLED_INSTRUMENTORS', 'instrumentors'),
  f('enableGpuMetrics', 'GENAI_ENABLE_GPU_METRICS', 'bool', 'true'),
  f('enableCostTracking', 'GENAI_ENABLE_COST_TRACKING', 'bool', 'true'),
  f('enableMcpInstrumentation', 'GENAI_ENABLE_MCP_INSTRUMENTATION', 'bool', 'true'),
  f('enableHttpInstrumentation', 'GENAI_ENABLE_HTTP_INSTRUMENTATION', 'bool', 'false'),
  f('failOnError', 'GENAI_FAIL_ON_ERROR', 'bool', 'false'),
  f('enableCo2Tracking', 'GENAI_ENABLE_CO2_TRACKING', 'bool', 'false'),
  f('exporterTimeout', 'OTEL_EXPORTER_OTLP_TIMEOUT', 'int_timeout', '60'),
  f('carbonIntensity', 'GENAI_CARBON_INTENSITY', 'float', '475.0'),
  f('powerCostPerKwh', 'GENAI_POWER_COST_PER_KWH', 'float', '0.12'),
  f('gpuCollectionInterval', 'GENAI_GPU_COLLECTION_INTERVAL', 'int', '5'),
  f('co2CountryIsoCode', 'GENAI_CO2_COUNTRY_ISO_CODE', 'opt_str'),
  f('co2Region', 'GENAI_CO2_REGION', 'opt_str'),
  f('co2CloudProvider', 'GENAI_CO2_CLOUD_PROVIDER', 'opt_str'),
  f('co2CloudRegion', 'GENAI_CO2_CLOUD_REGION', 'opt_str'),
  f('co2OfflineMode', 'GENAI_CO2_OFFLINE_MODE', 'bool', 'true'),
  f('co2TrackingMode', 'GENAI_CO2_TRACKING_MODE', 'str', 'machine'),
  f('co2UseManual', 'GENAI_CO2_USE_MANUAL', 'bool', 'false'),
  f('codecarbonLogLevel', 'GENAI_CODECARBON_LOG_LEVEL', 'str', 'error'),
  f('samplingRate', 'GENAI_SAMPLING_RATE', 'float', '1.0'),
  f('metricsProfile', 'GENAI_METRICS_PROFILE', 'str_lower', 'standard'),
  f('recordTokenHistograms', 'GENAI_RECORD_TOKEN_HISTOGRAMS', 'bool', ''),
  f('recordGranularCostMetrics', 'GENAI_RECORD_GRANULAR_COST_METRICS', 'bool', ''),
  f('recordFinishMetrics', 'GENAI_RECORD_FINISH_METRICS', 'bool', ''),
  f('enableConcurrencyMetrics', 'GENAI_ENABLE_CONCURRENCY_METRICS', 'bool', 'true'),
  f('profile', 'GENAI_PROFILE', 'str_lower', ''),
  f('allowExternalEgress', 'GENAI_ALLOW_EXTERNAL_EGRESS', 'bool', 'true'),
  f('airGapped', 'GENAI_AIR_GAPPED', 'bool', 'false'),
  f('semconvStabilityOptIn', 'OTEL_SEMCONV_STABILITY_OPT_IN', 'str', 'gen_ai/dup'),
  f('flushOnSigterm', 'GENAI_FLUSH_ON_SIGTERM', 'bool', 'false'),
  f('sigtermFlushTimeout', 'GENAI_SIGTERM_FLUSH_TIMEOUT', 'float', '5.0'),
  // Resolved together with OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, see contentCaptureFromEnv.
  f('enableContentCapture', 'GENAI_ENABLE_CONTENT_CAPTURE', 'bool_strip', 'false'),
  f('captureEmbeddingVectors', 'GENAI_CAPTURE_EMBEDDING_VECTORS', 'bool_strip', 'false'),
  f('contentMaxLength', 'GENAI_CONTENT_MAX_LENGTH', 'int', '200'),
  f('customPricingJson', 'GENAI_CUSTOM_PRICING_JSON', 'opt_str'),
  f('enablePiiDetection', 'GENAI_ENABLE_PII_DETECTION', 'bool', 'false'),
  f('piiMode', 'GENAI_PII_MODE', 'str', 'detect'),
  f('piiThreshold', 'GENAI_PII_THRESHOLD', 'float', '0.5'),
  f('piiGdprMode', 'GENAI_PII_GDPR_MODE', 'bool', 'false'),
  f('piiHipaaMode', 'GENAI_PII_HIPAA_MODE', 'bool', 'false'),
  f('piiPciDssMode', 'GENAI_PII_PCI_DSS_MODE', 'bool', 'false'),
  f('enableToxicityDetection', 'GENAI_ENABLE_TOXICITY_DETECTION', 'bool', 'false'),
  f('toxicityThreshold', 'GENAI_TOXICITY_THRESHOLD', 'float', '0.7'),
  f('toxicityUsePerspectiveApi', 'GENAI_TOXICITY_USE_PERSPECTIVE_API', 'bool', 'false'),
  f('toxicityPerspectiveApiKey', 'GENAI_TOXICITY_PERSPECTIVE_API_KEY', 'opt_str'),
  f('toxicityBlockOnDetection', 'GENAI_TOXICITY_BLOCK_ON_DETECTION', 'bool', 'false'),
  f('enableBiasDetection', 'GENAI_ENABLE_BIAS_DETECTION', 'bool', 'false'),
  f('biasThreshold', 'GENAI_BIAS_THRESHOLD', 'float', '0.4'),
  f('biasBlockOnDetection', 'GENAI_BIAS_BLOCK_ON_DETECTION', 'bool', 'false'),
  f('enablePromptInjectionDetection', 'GENAI_ENABLE_PROMPT_INJECTION_DETECTION', 'bool', 'false'),
  f('promptInjectionThreshold', 'GENAI_PROMPT_INJECTION_THRESHOLD', 'float', '0.5'),
  f('promptInjectionBlockOnDetection', 'GENAI_PROMPT_INJECTION_BLOCK_ON_DETECTION', 'bool', 'false'),
  f('enableRestrictedTopics', 'GENAI_ENABLE_RESTRICTED_TOPICS', 'bool', 'false'),
  f('restrictedTopicsThreshold', 'GENAI_RESTRICTED_TOPICS_THRESHOLD', 'float', '0.7'),
  f('restrictedTopicsBlockOnDetection', 'GENAI_RESTRICTED_TOPICS_BLOCK_ON_DETECTION', 'bool', 'false'),
  f('enableHallucinationDetection', 'GENAI_ENABLE_HALLUCINATION_DETECTION', 'bool', 'false'),
  f('hallucinationThreshold', 'GENAI_HALLUCINATION_THRESHOLD', 'float', '0.6'),
  f('mediaCaptureMode', 'GENAI_OTEL_MEDIA_CAPTURE_MODE', 'str', 'off'),
  f('mediaStore', 'GENAI_OTEL_MEDIA_STORE', 'str', 'none'),
  f('mediaStoreEndpoint', 'GENAI_OTEL_MEDIA_STORE_ENDPOINT', 'opt_str'),
  f('mediaStoreBucket', 'GENAI_OTEL_MEDIA_STORE_BUCKET', 'str', 'genai-otel-media'),
  f('mediaStorePrefix', 'GENAI_OTEL_MEDIA_STORE_PREFIX', 'str', 'traces/{date}/{trace_id}/'),
  f('mediaStoreAccessKey', 'GENAI_OTEL_MEDIA_STORE_ACCESS_KEY', 'opt_str'),
  f('mediaStoreSecretKey', 'GENAI_OTEL_MEDIA_STORE_SECRET_KEY', 'opt_str'),
  f('mediaMaxBytes', 'GENAI_OTEL_MEDIA_MAX_BYTES', 'int', String(10 * 1024 * 1024)),
  f('mediaAllowedModalities', 'GENAI_OTEL_MEDIA_ALLOWED_MODALITIES', 'str', 'image,audio,video,document'),
  f('mediaRedactor', 'GENAI_OTEL_MEDIA_REDACTOR', 'opt_str'),
]);

export type Env = Record<string, string | undefined>;

/** `_content_capture_from_env()`: the cross-library variable first, then our own. */
function contentCaptureFromEnv(env: Env): boolean {
  const standard = (env[OTEL_GENAI_CAPTURE_MESSAGE_CONTENT] ?? '').trim();
  if (standard) {
    const mode = CONTENT_CAPTURE_MODES[standard.toUpperCase()];
    if (mode !== undefined) return mode;
    logger.warn(
      `${standard} is not a valid option for \`${OTEL_GENAI_CAPTURE_MESSAGE_CONTENT}\`. ` +
        `Must be one of ${Object.keys(CONTENT_CAPTURE_MODES).join(', ')}. Defaulting to no capture.`,
    );
    return false;
  }
  return (env.GENAI_ENABLE_CONTENT_CAPTURE ?? 'false').trim().toLowerCase() === 'true';
}

function numberField(field: ConfigField, raw: string, parse: (raw: string) => number): number {
  try {
    return parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${field.env}: ${reason}`, field.env);
  }
}

/**
 * Parse one field from the environment, exactly as the Python default factory does.
 *
 * Exported so the contract test can drive a single variable at a time.
 */
export function parseConfigField(field: ConfigField, env: Env): OTelConfig[keyof OTelConfig] {
  const raw = env[field.env];
  const withDefault = raw ?? field.default ?? '';
  switch (field.kind) {
    case 'str':
      return withDefault;
    case 'str_lower':
      return withDefault.toLowerCase();
    case 'opt_str':
      return raw;
    case 'bool':
      return withDefault.toLowerCase() === 'true';
    case 'bool_strip':
      if (field.field === 'enableContentCapture') return contentCaptureFromEnv(env);
      return withDefault.trim().toLowerCase() === 'true';
    case 'float':
      return numberField(field, withDefault, pyFloat);
    case 'int':
      return numberField(field, withDefault, pyInt);
    case 'int_timeout':
      try {
        return pyInt(withDefault);
      } catch {
        logger.warn(
          `Invalid timeout value '${withDefault}' in ${field.env}. Using default of 60 seconds.`,
        );
        return 60;
      }
    case 'instrumentors':
      // An empty string is falsy in Python, so it means "the default list" too.
      if (raw) return raw.split(',').map((name) => name.trim());
      return [...DEFAULT_INSTRUMENTORS];
  }
}

/**
 * Build the configuration: explicit options first, then the environment, then
 * the defaults; finally the hardening profile (`OTelConfig.__post_init__`).
 *
 * An option that is given explicitly spares its environment variable from being
 * parsed at all, as passing a keyword to the Python dataclass does.
 */
export function loadConfig(overrides: Partial<OTelConfig> = {}, env: Env = process.env): OTelConfig {
  const values: Record<string, unknown> = {
    headers: undefined,
    piiCustomPatterns: {},
    sessionIdExtractor: undefined,
    userIdExtractor: undefined,
  };
  for (const field of CONFIG_FIELDS) {
    const override = overrides[field.field];
    values[field.field] = override !== undefined ? override : parseConfigField(field, env);
  }
  for (const key of ['headers', 'piiCustomPatterns', 'sessionIdExtractor', 'userIdExtractor'] as const) {
    if (overrides[key] !== undefined) values[key] = overrides[key];
  }
  const config = values as unknown as OTelConfig;

  if (HARDENED_PROFILES.has(config.profile)) {
    // Hard overrides: no third-party egress, no runtime downloads.
    config.allowExternalEgress = false;
    config.airGapped = true;
    config.co2OfflineMode = true;
    config.toxicityUsePerspectiveApi = false;
    // Soft default: audit content capture on, unless pinned under either spelling.
    if ((env.GENAI_ENABLE_CONTENT_CAPTURE ?? '') === '' && (env[OTEL_GENAI_CAPTURE_MESSAGE_CONTENT] ?? '').trim() === '') {
      config.enableContentCapture = true;
    }
  }
  return config;
}
