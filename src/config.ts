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
import { ambientEnv, type Env } from './env';
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
  /** Mirror gen_ai.agent.name into the OpenInference agent.name / graph.node.* attributes. */
  enableAgentGraphAttributes: boolean;
  /** Copy session.id / user.id from a session block, or from the parent span, onto every span. */
  enableSessionPropagation: boolean;
  /** Which of session.id / user.id this service sends as W3C baggage. */
  sessionBaggageKeys: string[];
  /** Which of them it accepts from inbound baggage. */
  sessionBaggageAccept: string[];
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
  /** Whether trace context travels between agents on A2A calls (`GENAI_A2A_PROPAGATE`, default true). */
  a2aPropagate: boolean;
  /** Whether A2UI attributes and spans are recorded (`GENAI_A2UI_ENABLED`, default true). */
  a2uiEnabled: boolean;
  captureEmbeddingVectors: boolean;
  contentMaxLength: number;
  customPricingJson: string | undefined;
  /** Keep `openinference.span.kind=LLM` on SystemOne calls (pre-1.38 kind). */
  decisionLegacyLlmKind: boolean;
  /** A plain HTTP POST to a decision endpoint becomes a DECISION span. */
  decisionHttpMatcher: boolean;
  /** The provider behind a host the library cannot recognise. */
  decisionProvider: string | undefined;
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
  /** Where the detectors run once a call has returned: `background` or `inline`. */
  evaluationMode: string;
  /** Spans that may wait for the detectors at once; at least 1. */
  evaluationQueueSize: number;
  /** Characters of prompt / response the detectors analyse. 0 = no limit. */
  evaluationMaxChars: number;
  /** Characters at the end of a prompt the toxicity detector analyses. 0 = no limit of its own. */
  toxicityMaxChars: number;
  /** Seconds given to detectors still running at shutdown; 0 to 3600. */
  evaluationShutdownTimeout: number;
  /** Results each detector remembers. 0 = none. */
  evaluationCacheSize: number;
  /** Run the local toxicity model with 8-bit weights (Python backend). */
  toxicityQuantize: boolean;
  /** Threads for the local toxicity model (Python backend); undefined = unset. */
  toxicityTorchThreads: number | undefined;
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
  'databricks',
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
  'xai_sdk',
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
  // Both do nothing unless their package is installed (`@a2a-js/sdk`, `@a2ui/agent`). Scoped addition from Python 1.48.0 (A2UI-D8).
  'a2a',
  'a2ui',
  'smolagents',
  'litellm',
  'typesafe',
  'claude_agent_sdk',
  'agno',
  'microsoft_agent_framework',
  'strands_agents',
]);

/** Opt-in only in the Python library; listed so an explicit request is recognised. */
export const OPT_IN_INSTRUMENTORS: readonly string[] = Object.freeze(['litellm_latency', 'strands', 'antigravity']);

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

/** `EVALUATION_MODES`: detectors on a worker after the call returns, or before it returns. */
export const EVALUATION_MODE_BACKGROUND = 'background';
export const EVALUATION_MODE_INLINE = 'inline';
export const EVALUATION_MODES: readonly string[] = Object.freeze([EVALUATION_MODE_BACKGROUND, EVALUATION_MODE_INLINE]);
export const DEFAULT_EVALUATION_QUEUE_SIZE = 1000;
export const DEFAULT_EVALUATION_MAX_CHARS = 1500;
/** The local toxicity model is the slowest detector by far, so it reads less. */
export const DEFAULT_TOXICITY_MAX_CHARS = 500;
export const DEFAULT_EVALUATION_SHUTDOWN_TIMEOUT = 5.0;
export const MAX_EVALUATION_SHUTDOWN_TIMEOUT = 3600.0;
export const DEFAULT_EVALUATION_CACHE_SIZE = 256;

/** The ids that may cross a process boundary as baggage, in the order they are reported. */
export const SESSION_BAGGAGE_KEYS: readonly string[] = Object.freeze(['session.id', 'user.id']);

/** `parse_baggage_keys()`: unset or empty means none; unknown names (case-sensitive) are ignored. */
export function parseSessionBaggageKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  const keys = new Set(raw.split(',').map((key) => key.trim()));
  return SESSION_BAGGAGE_KEYS.filter((key) => keys.has(key));
}

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
  | 'instrumentors'
  /** `os.getenv(X, default).strip().lower() != "false"` */
  | 'bool_not_false'
  /** `os.getenv(X, default).lower() != "false"` - no stripping, so `"false "` is true */
  | 'bool_not_false_exact'
  /** `(os.getenv(X) or "").strip() or None` */
  | 'opt_str_strip'
  /** `_parse_session_baggage_keys(os.getenv(X))` */
  | 'baggage_keys'
  /** `_number_from_env(X, default)` - int; blank or garbage warns and falls back to the default */
  | 'int_or_default'
  /** `_number_from_env(X, default, float)` */
  | 'float_or_default'
  /** `_characters_from_env(X)` - int, undefined when unset or garbage (the default is filled in later) */
  | 'opt_int'
  /** `_positive_count(os.getenv(X))` - an int of one or more, else undefined */
  | 'positive_count';

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
  f('enableAgentGraphAttributes', 'GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES', 'bool', 'true'),
  f('enableSessionPropagation', 'GENAI_ENABLE_SESSION_PROPAGATION', 'bool', 'true'),
  f('sessionBaggageKeys', 'GENAI_SESSION_BAGGAGE_KEYS', 'baggage_keys'),
  f('sessionBaggageAccept', 'GENAI_SESSION_BAGGAGE_ACCEPT', 'baggage_keys'),
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
  f('decisionLegacyLlmKind', 'GENAI_DECISION_LEGACY_LLM_KIND', 'bool_strip', 'false'),
  f('decisionHttpMatcher', 'GENAI_DECISION_HTTP_MATCHER', 'bool_not_false', 'true'),
  f('decisionProvider', 'GENAI_DECISION_PROVIDER', 'opt_str_strip'),
  // Scoped addition from Python 1.48.0 (contract/a2a-a2ui.json, A2UI-D8): not in the pinned v1.46.0 contract.
  f('a2aPropagate', 'GENAI_A2A_PROPAGATE', 'bool_not_false_exact', 'true'),
  f('a2uiEnabled', 'GENAI_A2UI_ENABLED', 'bool_not_false_exact', 'true'),
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
  // Normalised together once the options are applied, see normaliseEvaluation.
  f('evaluationMode', 'GENAI_EVALUATION_MODE', 'str', EVALUATION_MODE_BACKGROUND),
  f('evaluationQueueSize', 'GENAI_EVALUATION_QUEUE_SIZE', 'int_or_default', String(DEFAULT_EVALUATION_QUEUE_SIZE)),
  f('evaluationMaxChars', 'GENAI_EVALUATION_MAX_CHARS', 'opt_int'),
  f('toxicityMaxChars', 'GENAI_TOXICITY_MAX_CHARS', 'opt_int'),
  f(
    'evaluationShutdownTimeout',
    'GENAI_EVALUATION_SHUTDOWN_TIMEOUT',
    'float_or_default',
    String(DEFAULT_EVALUATION_SHUTDOWN_TIMEOUT),
  ),
  f('evaluationCacheSize', 'GENAI_EVALUATION_CACHE_SIZE', 'int_or_default', String(DEFAULT_EVALUATION_CACHE_SIZE)),
  f('toxicityQuantize', 'GENAI_TOXICITY_QUANTIZE', 'bool_strip', 'false'),
  f('toxicityTorchThreads', 'GENAI_TOXICITY_TORCH_THREADS', 'positive_count'),
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

export type { Env };

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

/** `_number_from_env()`: blank means the default; garbage warns and means the default. */
function numberOrDefault(field: ConfigField, raw: string | undefined, parse: (raw: string) => number): number {
  const fallback = parse(field.default ?? '0');
  if (raw === undefined || !raw.trim()) return fallback;
  try {
    return parse(raw.trim());
  } catch {
    logger.warn(`Invalid value '${raw}' in ${field.env}. Using default of ${field.default ?? ''}.`);
    return fallback;
  }
}

/** Python `int(x)`: a number truncates; NaN, infinity and a non-numeric string cannot be converted. */
function pyIntOf(value: unknown): number | undefined {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === 'string') {
    try {
      return pyInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** `_positive_count()`: a whole number of one or more, else undefined. */
function positiveCount(value: unknown): number | undefined {
  if (value === undefined || value === null || typeof value === 'boolean') return undefined;
  const count = typeof value === 'string' ? pyIntOf(value) : value;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : undefined;
}

/** `_evaluation_mode()`: an unknown mode warns and becomes the default. */
function evaluationMode(value: unknown): string {
  const mode = String(value ?? '').trim().toLowerCase();
  if (EVALUATION_MODES.includes(mode)) return mode;
  if (mode) {
    logger.warn(
      `${mode} is not a valid option for \`GENAI_EVALUATION_MODE\`. Must be one of ${EVALUATION_MODES.join(', ')}. ` +
        `Defaulting to ${EVALUATION_MODE_BACKGROUND}.`,
    );
  }
  return EVALUATION_MODE_BACKGROUND;
}

/** `_evaluation_shutdown_timeout()`: zero or more finite seconds, capped. */
function evaluationShutdownTimeout(value: unknown): number {
  let seconds = Number.NaN;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'boolean') seconds = value ? 1 : 0;
  else if (typeof value === 'string') {
    try {
      seconds = pyFloat(value);
    } catch {
      seconds = Number.NaN;
    }
  }
  // Written so that NaN, which compares false with everything, fails it.
  if (!(seconds >= 0 && seconds < Infinity)) {
    logger.warn(
      `Invalid value '${String(value)}' in GENAI_EVALUATION_SHUTDOWN_TIMEOUT: it must be a number of seconds, ` +
        `zero or more. Using default of ${DEFAULT_EVALUATION_SHUTDOWN_TIMEOUT}.`,
    );
    return DEFAULT_EVALUATION_SHUTDOWN_TIMEOUT;
  }
  if (seconds > MAX_EVALUATION_SHUTDOWN_TIMEOUT) {
    logger.warn(
      `GENAI_EVALUATION_SHUTDOWN_TIMEOUT of ${String(value)} seconds is more than the ` +
        `${MAX_EVALUATION_SHUTDOWN_TIMEOUT} allowed. Using ${MAX_EVALUATION_SHUTDOWN_TIMEOUT}.`,
    );
    return MAX_EVALUATION_SHUTDOWN_TIMEOUT;
  }
  return seconds;
}

/** `_evaluation_cache_size()`: not a count means the default; negative means none. */
function evaluationCacheSize(value: unknown): number {
  if (typeof value === 'boolean') return DEFAULT_EVALUATION_CACHE_SIZE;
  const size = pyIntOf(value);
  if (size === undefined) {
    logger.warn(
      `Invalid value '${String(value)}' in GENAI_EVALUATION_CACHE_SIZE. Using default of ${DEFAULT_EVALUATION_CACHE_SIZE}.`,
    );
    return DEFAULT_EVALUATION_CACHE_SIZE;
  }
  return Math.max(0, size);
}

/** `_characters()`: the default when not set, never negative. */
function characters(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return Math.max(0, pyIntOf(value) ?? fallback);
}

/**
 * The evaluation half of `OTelConfig.__post_init__`: whether a value came from
 * the environment or as an option, it is made safe to read once, here. Under a
 * hardened profile the detectors read everything unless a limit was set.
 */
function normaliseEvaluation(config: OTelConfig, hardened: boolean): void {
  config.evaluationMode = evaluationMode(config.evaluationMode);
  config.evaluationQueueSize = Math.max(1, pyIntOf(config.evaluationQueueSize) ?? DEFAULT_EVALUATION_QUEUE_SIZE);
  config.evaluationMaxChars = characters(config.evaluationMaxChars, hardened ? 0 : DEFAULT_EVALUATION_MAX_CHARS);
  config.toxicityMaxChars = characters(config.toxicityMaxChars, hardened ? 0 : DEFAULT_TOXICITY_MAX_CHARS);
  config.evaluationShutdownTimeout = evaluationShutdownTimeout(config.evaluationShutdownTimeout);
  config.evaluationCacheSize = evaluationCacheSize(config.evaluationCacheSize);
  config.toxicityQuantize = Boolean(config.toxicityQuantize);
  config.toxicityTorchThreads = positiveCount(config.toxicityTorchThreads);
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
    case 'bool_not_false_exact':
      return withDefault.toLowerCase() !== 'false';
    case 'bool_not_false':
      return withDefault.trim().toLowerCase() !== 'false';
    case 'opt_str_strip':
      return (raw ?? '').trim() || undefined;
    case 'baggage_keys':
      return parseSessionBaggageKeys(raw);
    case 'int_or_default':
      return numberOrDefault(field, raw, pyInt);
    case 'float_or_default':
      return numberOrDefault(field, raw, pyFloat);
    case 'opt_int':
      // `_characters_from_env()`: "not set" stays apart from the default, which depends on the profile.
      if (raw === undefined || !raw.trim()) return undefined;
      try {
        return pyInt(raw);
      } catch {
        logger.warn(`Invalid value '${raw}' in ${field.env}. Using the default.`);
        return undefined;
      }
    case 'positive_count':
      return positiveCount(raw);
  }
}

/**
 * Build the configuration: explicit options first, then the environment, then
 * the defaults; finally the hardening profile (`OTelConfig.__post_init__`).
 *
 * An option that is given explicitly spares its environment variable from being
 * parsed at all, as passing a keyword to the Python dataclass does.
 */
export function loadConfig(overrides: Partial<OTelConfig> = {}, env: Env = ambientEnv()): OTelConfig {
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
  const hardened = HARDENED_PROFILES.has(config.profile);
  normaliseEvaluation(config, hardened);

  if (hardened) {
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
