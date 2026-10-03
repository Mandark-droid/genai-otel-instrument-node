/**
 * @traceverse/genai-otel-instrument
 *
 * OpenTelemetry instrumentation for GenAI applications on Node.js. A port of
 * the Python library `genai_otel_instrument`: same span attributes, same
 * metrics, same environment variables, same cost figures.
 */
import './node-env';

export { extractBudgetAttributes } from './agent-budget';

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
  buildResource,
  DISTRO_NAME,
  hostIpAddresses,
  redactCommandArgs,
  SDK_LANGUAGE,
} from './resource';
export {
  AnthropicInstrumentor,
  AnyscaleInstrumentor,
  availableInstrumentors,
  BaseInstrumentor,
  BedrockInstrumentor,
  clearBaseUrlClaims,
  CohereInstrumentor,
  CometAPIInstrumentor,
  ElevenLabsInstrumentor,
  findBaseUrlClaim,
  GoogleGenAIInstrumentor,
  GroqInstrumentor,
  HyperbolicInstrumentor,
  MistralInstrumentor,
  OllamaInstrumentor,
  OpenAIInstrumentor,
  OpenRouterInstrumentor,
  PatchingInstrumentor,
  registerBaseUrlClaim,
  registerInstrumentor,
  ReplicateInstrumentor,
  SambaNovaInstrumentor,
  SarvamInstrumentor,
  StreamTiming,
  TogetherInstrumentor,
  traceHuggingFaceClient,
  TransformersInstrumentor,
  VertexAIInstrumentor,
  type AttributeExtractor,
  type Instrumentor,
  type Params,
  type PatchTarget,
  type UsageDict,
} from './instrumentors';
export {
  ChromaInstrumentor,
  DatastoreInstrumentor,
  ElasticsearchInstrumentor,
  estimatePayloadSize,
  FalkorDBInstrumentor,
  HttpInstrumentor,
  KafkaInstrumentor,
  MilvusInstrumentor,
  MinIOInstrumentor,
  MySQLInstrumentor,
  OpenSearchInstrumentor,
  PineconeInstrumentor,
  PostgresInstrumentor,
  QdrantInstrumentor,
  RabbitMQInstrumentor,
  RedisInstrumentor,
  S3Instrumentor,
} from './datastores';
export {
  buildCallAttributes,
  buildErrorAttributes,
  buildResultAttributes,
  CommerceAttributes,
  computeCartHash,
  getCallContext,
  hashIdentifier,
  hashUserFields,
  MCPAttributes,
  MCPInstrumentor,
  mcpInstrumentor,
  MCPSessionRegistry,
  MCPSessionState,
  MCPToolRegistry,
  withExpectedTool,
  withMcpSession,
  type MCPCallContext,
  type ToolMetadata,
  type ToolResolution,
} from './mcp';
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
export {
  clearWebGpuFacts,
  collectWebGpuFacts,
  enableWebGpuFacts,
  watchWebGpuDevice,
  webGpuFacts,
  type WebGpuFacts,
} from './webgpu';
export { VERSION } from './version';
export { NvidiaSmiSource, parseNvidiaSmi } from './gpu/nvidia-smi';
export { FilesystemStore } from './media/filesystem-store';
