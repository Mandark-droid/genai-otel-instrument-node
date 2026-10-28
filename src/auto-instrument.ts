/**
 * One-call setup: tracer and meter providers, OTLP exporters, instrumentors.
 *
 * Port of `genai_otel/auto_instrument.py`. The parts that belong to later
 * phases (GPU collection, server metrics, MCP/datastore instrumentors,
 * evaluation) are not wired here yet; a setting that asks for one of them is
 * reported, never silently ignored.
 */
import './node-env';
import { connect } from 'node:net';
import { context, diag, DiagLogLevel, metrics, propagation, trace, type DiagLogger } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter as GrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as HttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as HttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { Resource } from '@opentelemetry/resources';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TraceIdRatioBasedSampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ConfigError, loadConfig, type Env, type OTelConfig } from './config';
import { datastoreInstrumentors } from './datastores';
import { resetMcpMetrics } from './datastores/mcp-metrics';
import { costCalculatorFor } from './cost/default';
import { CostEnrichmentSpanProcessor } from './cost/enrichment-processor';
import { activeEvaluation, EvaluationEngine, EvaluationSpanProcessor, evaluationConfigsFrom, setActiveEvaluation } from './evaluation/engine';
import { AiSdkSpanProcessor, isAiSdkAggregate } from './frameworks/ai-sdk';
import { GpuMetricsCollector, gpuSourceFactory } from './gpu/collector';
import { NvidiaSmiSource } from './gpu/nvidia-smi';
import { mediaIdle } from './media/emit';
import './media/node-stores';
import { httpToxicityJudge } from './evaluation/http-judge';
import { onnxToxicityJudge } from './evaluation/onnx-addon';
import { toxicityWaitSeconds } from './evaluation/engine';
import { currentGauges } from './gauge-temporality';
import { initializeServerMetrics, resetServerMetrics, setVramDetector, startEndpointPollers, type PrometheusServerMetricsPoller } from './server-metrics';
import { resetPricingMissingCounter } from './cost/pricing-missing';
// Registers the shipped instrumentors.
import './instrumentors';
import {
  instrumentorFactory,
  isReferenceOnlyInstrumentor,
  type Instrumentor,
} from './instrumentors/registry';
import { logger } from './logger';
import { metricViews, resetSharedMetrics } from './metrics';
import { buildResource } from './resource';
import { setAppSpanContentCapture } from './app-spans';
import { SessionSpanProcessor } from './session';
import { clearStateSlot, globalState } from './state';
import { VERSION } from './version';

export const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318';

const STATE_SLOT = 'instrumentation';

export interface InstrumentOptions extends Partial<OTelConfig> {
  /** Extra span processors, run before the exporting processor. */
  spanProcessors?: SpanProcessor[];
  /** Extra metric readers, alongside the exporting reader. */
  metricReaders?: IMetricReader[];
}

export interface InstrumentationHandle {
  readonly config: OTelConfig;
  readonly resource: Resource;
  readonly tracerProvider: BasicTracerProvider;
  readonly meterProvider: MeterProvider;
  /** Which exporter pair is active. */
  readonly exporter: 'otlp-http' | 'otlp-grpc' | 'console';
}

interface ActiveState {
  handle: InstrumentationHandle;
  instrumentors: Instrumentor[];
  /** Settles when every instrumentor has finished patching, ESM builds included. */
  ready: Promise<void>;
  contextManager: AsyncLocalStorageContextManager | undefined;
  registeredTracer: boolean;
  registeredMeter: boolean;
  registeredPropagator: boolean;
  onBeforeExit: (() => void) | undefined;
  onSigterm: (() => void) | undefined;
  gpu?: GpuMetricsCollector | undefined;
  /** vLLM / llama.cpp endpoints from GENAI_SERVER_METRICS_ENDPOINTS. */
  enginePollers?: PrometheusServerMetricsPoller[];
}

/**
 * Drop instruments created against a meter provider that is going away. An
 * instrument stays bound to the provider that created it.
 */
function resetMeterBoundState(): void {
  resetPricingMissingCounter();
  resetSharedMetrics();
  resetMcpMetrics();
  resetServerMetrics();
}

function activeState(): ActiveState | undefined {
  return globalState()[STATE_SLOT] as ActiveState | undefined;
}

export function isInstrumented(): boolean {
  return activeState() !== undefined;
}

/**
 * Resolves once every instrumentor has finished patching.
 *
 * CommonJS builds of the client libraries are patched synchronously inside
 * `instrument()`. Their ES-module builds can only be reached through a dynamic
 * `import()`, which is asynchronous; an application that wants the very first
 * call instrumented awaits this. Never rejects.
 */
export function instrumentorsReady(): Promise<void> {
  return activeState()?.ready ?? Promise.resolve();
}

/** `os.getenv("OTEL_EXPORTER_OTLP_PROTOCOL", "").lower()` */
export function otlpProtocolFromEnv(env: Env = process.env): string {
  return (env.OTEL_EXPORTER_OTLP_PROTOCOL ?? '').toLowerCase();
}

/** `os.getenv("GENAI_SKIP_COLLECTOR_CHECK", "").lower() == "true"` */
export function skipCollectorCheck(env: Env = process.env): boolean {
  return (env.GENAI_SKIP_COLLECTOR_CHECK ?? '').toLowerCase() === 'true';
}

/**
 * OTLP protocol: `OTEL_EXPORTER_OTLP_PROTOCOL` if set, else by port (4317 is
 * gRPC), else HTTP. Anything that is not `grpc` means http/protobuf.
 */
export function resolveOtlpProtocol(endpoint: string, env: Env = process.env): 'grpc' | 'http' {
  const explicit = otlpProtocolFromEnv(env);
  if (explicit) return explicit === 'grpc' ? 'grpc' : 'http';
  try {
    return new URL(endpoint).port === '4317' ? 'grpc' : 'http';
  } catch {
    return 'http';
  }
}

/**
 * The configured exporter timeout is in SECONDS, as in the Python library,
 * although the OpenTelemetry specification defines `OTEL_EXPORTER_OTLP_TIMEOUT`
 * in milliseconds. It is therefore passed to the exporters explicitly and never
 * left for them to read from the environment.
 */
export function exporterTimeoutMillis(seconds: number): number {
  return Math.max(1, Math.round(seconds * 1000));
}

function diagLevel(): DiagLogLevel {
  const raw = (process.env.OTEL_LOG_LEVEL ?? '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'verbose' || raw === 'all') return DiagLogLevel.DEBUG;
  if (raw === 'info') return DiagLogLevel.INFO;
  if (raw === 'warn') return DiagLogLevel.WARN;
  if (raw === 'none') return DiagLogLevel.NONE;
  return DiagLogLevel.ERROR;
}

/**
 * Route the OpenTelemetry SDK's own diagnostics through this library's logger.
 *
 * A failed export is reported by the SDK through `diag`, which is silent until
 * a logger is installed - and a silent export failure is how telemetry
 * disappears without anyone noticing.
 */
function installDiagLogger(): void {
  const adapter: DiagLogger = {
    verbose: (message, ...args) => logger.debug(message, ...args),
    debug: (message, ...args) => logger.debug(message, ...args),
    info: (message, ...args) => logger.info(message, ...args),
    warn: (message, ...args) => logger.warn(message, ...args),
    error: (message, ...args) => logger.error(message, ...args),
  };
  diag.setLogger(adapter, { logLevel: diagLevel(), suppressOverrideMessage: true });
}

function metricIntervals(): { exportIntervalMillis: number; exportTimeoutMillis: number } {
  const parse = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const exportIntervalMillis = parse('OTEL_METRIC_EXPORT_INTERVAL', 60000);
  // The reader refuses a timeout longer than its interval.
  const exportTimeoutMillis = Math.min(parse('OTEL_METRIC_EXPORT_TIMEOUT', 30000), exportIntervalMillis);
  return { exportIntervalMillis, exportTimeoutMillis };
}

/** Settings this SDK accepts and cannot act on, said so at start-up rather than ignored. */
function reportUnhonouredSettings(config: OTelConfig, env: Env): void {
  // CO2 is computed from GPU energy: without GPU metrics there is nothing to compute it from.
  if (config.enableCo2Tracking && !config.enableGpuMetrics) {
    logger.warn('GENAI_ENABLE_CO2_TRACKING is on but GENAI_ENABLE_GPU_METRICS is off: CO2 is computed from measured GPU energy, so nothing is collected for it.');
  }
  // codecarbon's location and mode settings: accepted, and said to have no effect here.
  const codecarbon = [
    'GENAI_CO2_COUNTRY_ISO_CODE',
    'GENAI_CO2_REGION',
    'GENAI_CO2_CLOUD_PROVIDER',
    'GENAI_CO2_CLOUD_REGION',
    'GENAI_CO2_OFFLINE_MODE',
    'GENAI_CO2_TRACKING_MODE',
    'GENAI_CO2_USE_MANUAL',
    'GENAI_CODECARBON_LOG_LEVEL',
  ].filter((name) => env[name] !== undefined);
  if (codecarbon.length > 0) {
    logger.warn(
      `${codecarbon.join(', ')}: codecarbon settings, with no effect in this SDK. CO2 here is measured GPU energy ` +
        'times GENAI_CARBON_INTENSITY (a configured factor, not a reading of the grid). See docs/gpu-energy.md.',
    );
  }
}

/**
 * GPU, energy and CO2 metrics, when this runtime has a way to read a GPU and
 * the host has one. Started without waiting: the first sample runs a process.
 */
function startGpuMetrics(config: OTelConfig): GpuMetricsCollector | undefined {
  try {
    const factory = gpuSourceFactory();
    const source = factory ? factory() : new NvidiaSmiSource();
    // The Ollama poller needs the GPU's VRAM for a model's share of it.
    setVramDetector(
      source
        ? async (): Promise<number | undefined> => {
            try {
              const total = (await source.sample())?.[0]?.memoryTotalMiB;
              return typeof total === 'number' && total > 0 ? total / 1024 : undefined;
            } catch {
              return undefined;
            }
          }
        : undefined,
    );
    if (!config.enableGpuMetrics) return undefined;
    if (!source) {
      logger.debug('GPU metrics: no source of GPU readings');
      return undefined;
    }
    const collector = new GpuMetricsCollector(config, source);
    void collector.start();
    return collector;
  } catch (error) {
    logger.error(`Failed to start GPU metrics collection: ${String(error)}`);
    if (config.failOnError) throw error;
    return undefined;
  }
}

function startInstrumentors(
  config: OTelConfig,
  explicitList: boolean,
): { started: Instrumentor[]; ready: Promise<void> } {
  const started: Instrumentor[] = [];
  const pendingWork: Promise<void>[] = [];
  for (const name of config.enabledInstrumentors) {
    const factory = instrumentorFactory(name);
    if (!factory) {
      if (isReferenceOnlyInstrumentor(name)) {
        const message = `Instrumentor '${name}' is not available in the Node.js SDK ${VERSION}; skipping. See docs/parity-matrix.md.`;
        if (explicitList) logger.warn(message);
        else logger.debug(message);
      } else {
        logger.warn(`Unknown instrumentor '${name}' requested.`);
      }
      continue;
    }
    try {
      const instrumentor = factory();
      const pending = instrumentor.instrument(config);
      if (pending && typeof pending.then === 'function') {
        pendingWork.push(
          pending.then(undefined, (error: unknown) => logger.error(`Failed to instrument ${name}: ${String(error)}`)),
        );
      }
      started.push(instrumentor);
      logger.info(`${name} instrumentation enabled`);
    } catch (error) {
      logger.error(`Failed to instrument ${name}: ${String(error)}`);
      if (config.failOnError) throw error;
    }
  }
  // Datastores and tools: all of them, each a no-op when its library is absent.
  if (config.enableMcpInstrumentation) {
    for (const instrumentor of datastoreInstrumentors(config)) {
      try {
        const pending = instrumentor.instrument(config);
        if (pending && typeof pending.then === 'function') {
          pendingWork.push(pending.then(undefined, (error: unknown) => logger.error(`Failed to instrument a datastore: ${String(error)}`)));
        }
        started.push(instrumentor);
      } catch (error) {
        logger.error(`Failed to instrument a datastore: ${String(error)}`);
        if (config.failOnError) throw error;
      }
    }
  } else {
    logger.info('MCP / datastore instrumentation disabled (GENAI_ENABLE_MCP_INSTRUMENTATION=false)');
  }
  return { started, ready: Promise.all(pendingWork).then(() => undefined) };
}

/**
 * Say once, clearly, that the default collector is not there.
 *
 * Only when the endpoint was never changed from the default: someone who set it
 * knows where their collector is. This does not quiet the export failures that
 * follow - it adds the one line that says what to do about them.
 */
export function warnIfDefaultCollectorUnreachable(config: OTelConfig, env: Env = process.env): Promise<boolean> {
  if (skipCollectorCheck(env)) return Promise.resolve(false);
  if (config.endpoint !== DEFAULT_OTLP_ENDPOINT) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (unreachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (unreachable) {
        logger.warn(
          `No OTLP collector is listening on ${config.endpoint}, which is the default endpoint. ` +
            'Spans and metrics will be recorded but every export will fail. ' +
            'Start a collector, point OTEL_EXPORTER_OTLP_ENDPOINT at one, or set it ' +
            'empty to print telemetry to the console instead. ' +
            'Set GENAI_SKIP_COLLECTOR_CHECK=true to silence this check.',
        );
      }
      resolve(unreachable);
    };
    const socket = connect({ host: 'localhost', port: 4318 });
    socket.setTimeout(250, () => finish(true));
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    // Never keep the host process alive for a courtesy check.
    socket.unref();
  });
}

function withDeadline<T>(work: Promise<T>, millis: number): Promise<T | 'timeout'> {
  return new Promise<T | 'timeout'>((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), millis);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Force-flush the active providers. Resolves true if everything flushed.
 *
 * Bounded by `timeoutSeconds`, so a collector that is down cannot turn a
 * shutdown path into a hang. Never rejects.
 */
export async function flushTelemetry(timeoutSeconds = 5.0): Promise<boolean> {
  const state = activeState();
  if (!state) return true;
  const timeoutMs = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  // Spans still waiting for an evaluation scorer end first, so that they are flushed too.
  const evaluation = activeEvaluation();
  if (evaluation) await withDeadline(evaluation.idle(), timeoutMs);
  await withDeadline(mediaIdle(), timeoutMs);
  // The first GPU sample runs a process; a run shorter than that would export no GPU reading at all.
  if (state.gpu?.firstAttempt) await withDeadline(state.gpu.firstAttempt, timeoutMs);
  const results = await Promise.all(
    [state.handle.tracerProvider, state.handle.meterProvider].map(async (provider) => {
      try {
        return (await withDeadline(provider.forceFlush(), timeoutMs)) !== 'timeout';
      } catch (error) {
        logger.debug(`forceFlush failed: ${String(error)}`);
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

function installSigtermFlushHandler(config: OTelConfig, state: ActiveState): void {
  const handler = (): void => {
    void flushTelemetry(config.sigtermFlushTimeout).then((flushed) => {
      logger.info(`SIGTERM received, telemetry flush ${flushed ? 'complete' : 'partial'}`);
      // Chain to whatever else is registered; if we are the only listener, fall
      // through to the default disposition so the exit status stays conventional.
      if (process.listenerCount('SIGTERM') === 0) process.kill(process.pid, 'SIGTERM');
    });
  };
  process.once('SIGTERM', handler);
  state.onSigterm = handler;
  logger.info(`SIGTERM flush handler installed (timeout ${config.sigtermFlushTimeout.toFixed(1)}s)`);
}

function setup(config: OTelConfig, options: InstrumentOptions, explicitInstrumentors: boolean): InstrumentationHandle {
  setAppSpanContentCapture(config.enableContentCapture, config.contentMaxLength);
  logger.info('Starting auto-instrumentation setup...');
  installDiagLogger();

  const resource = buildResource(config.serviceName, VERSION, config.profile);

  // First, so the session is on the span before any other processor reads it.
  const spanProcessors: SpanProcessor[] = [new SessionSpanProcessor()];
  // Before the cost processor: it fills in what that one prices from.
  spanProcessors.push(new AiSdkSpanProcessor({ contentCapture: config.enableContentCapture }));
  try {
    const evaluation = evaluationConfigsFrom(config);
    if (evaluation) {
      // After any scorer given in code (SDK_ADDITIONS.md section 12): the operator's HTTP judge,
      // its request bounded by the time a span waits for a score; else a local ONNX model through
      // the optional add-on.
      const judgeUrl = process.env.GENAI_TOXICITY_JUDGE_URL?.trim();
      const onnxModel = process.env.GENAI_TOXICITY_ONNX_MODEL?.trim();
      const judge = !evaluation.toxicity?.enabled
        ? undefined
        : judgeUrl
          ? httpToxicityJudge(judgeUrl, toxicityWaitSeconds())
          : onnxModel
            ? onnxToxicityJudge(onnxModel)
            : undefined;
      const engine = new EvaluationEngine(evaluation, { fallbackToxicityScorer: judge });
      setActiveEvaluation(engine);
      spanProcessors.push(new EvaluationSpanProcessor(engine));
      logger.info('Evaluation and safety span processor added');
    } else {
      setActiveEvaluation(undefined);
    }
  } catch (error) {
    setActiveEvaluation(undefined);
    logger.warn(`Failed to add evaluation span processor: ${String(error)}`);
  }
  if (config.enableCostTracking) {
    try {
      // Spans from other instrumentation are priced from the same table as our
      // own, custom pricing included.
      spanProcessors.push(new CostEnrichmentSpanProcessor(costCalculatorFor(config.customPricingJson), isAiSdkAggregate));
      logger.info('Cost enrichment processor added');
    } catch (error) {
      logger.warn(`Failed to add cost enrichment processor: ${String(error)}`);
    }
  }
  spanProcessors.push(...(options.spanProcessors ?? []));

  let spanExporter: SpanExporter;
  let metricExporter: PushMetricExporter;
  let exporter: InstrumentationHandle['exporter'];
  if (config.endpoint) {
    // The exporters derive the per-signal paths (/v1/traces, /v1/metrics) from
    // this variable themselves, and still honour the per-signal overrides.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = config.endpoint;
    const exporterOptions = { headers: config.headers, timeoutMillis: exporterTimeoutMillis(config.exporterTimeout) };
    if (resolveOtlpProtocol(config.endpoint) === 'grpc') {
      // The gRPC exporters take their metadata from OTEL_EXPORTER_OTLP_HEADERS.
      spanExporter = new GrpcTraceExporter({ timeoutMillis: exporterOptions.timeoutMillis });
      metricExporter = new GrpcMetricExporter({ timeoutMillis: exporterOptions.timeoutMillis });
      exporter = 'otlp-grpc';
      if (config.headers) logger.warn('`headers` is ignored for OTLP gRPC; use OTEL_EXPORTER_OTLP_HEADERS.');
      logger.info(`Using OTLP gRPC protocol (endpoint: ${config.endpoint})`);
    } else {
      spanExporter = new HttpTraceExporter(exporterOptions);
      metricExporter = new HttpMetricExporter(exporterOptions);
      exporter = 'otlp-http';
      logger.info(`Using OTLP HTTP protocol (endpoint: ${config.endpoint})`);
    }
  } else {
    spanExporter = new ConsoleSpanExporter();
    metricExporter = new ConsoleMetricExporter();
    exporter = 'console';
    logger.info('No OTLP endpoint configured, traces and metrics will be exported to console.');
  }
  // Batched and exported off the request path: a span's end() only enqueues.
  spanProcessors.push(new BatchSpanProcessor(spanExporter));

  // Sampling rate below 1.0 means probabilistic sampling by trace id.
  const sampler = config.samplingRate < 1.0 ? new TraceIdRatioBasedSampler(config.samplingRate) : undefined;
  if (sampler) logger.info(`Trace sampling rate set to ${config.samplingRate}`);
  const tracerProvider = new BasicTracerProvider({ resource, sampler, spanProcessors });

  // Histogram bucket boundaries are set by Views, as in the reference implementation.
  const views = metricViews();
  const readers: IMetricReader[] = [
    // Gauges report what is observed now; see gauge-temporality.ts.
    new PeriodicExportingMetricReader({ exporter: currentGauges(metricExporter), ...metricIntervals() }),
    ...(options.metricReaders ?? []),
  ];
  const meterProvider = new MeterProvider({ resource, readers, views });

  const state: ActiveState = {
    handle: { config, resource, tracerProvider, meterProvider, exporter },
    instrumentors: [],
    ready: Promise.resolve(),
    contextManager: undefined,
    registeredTracer: trace.setGlobalTracerProvider(tracerProvider),
    registeredMeter: metrics.setGlobalMeterProvider(meterProvider),
    registeredPropagator: propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
    onBeforeExit: undefined,
    onSigterm: undefined,
  };
  // Without a context manager a span started here is never the parent of what
  // the host does next, so nested calls would not share a trace.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  if (context.setGlobalContextManager(contextManager)) state.contextManager = contextManager;
  else contextManager.disable();

  globalState()[STATE_SLOT] = state;
  // Instruments are bound to the provider that created them; forget the ones
  // made against whatever provider was global before.
  resetMeterBoundState();
  try {
    // KV cache, request queue: values arrive from the instrumented calls and the pollers.
    initializeServerMetrics(undefined, config.enableConcurrencyMetrics);
    state.enginePollers = startEndpointPollers(process.env.GENAI_SERVER_METRICS_ENDPOINTS);
  } catch (error) {
    logger.error(`Failed to initialize server metrics: ${String(error)}`);
    if (config.failOnError) throw error;
  }

  reportUnhonouredSettings(config, process.env);
  state.gpu = startGpuMetrics(config);
  const { started, ready } = startInstrumentors(config, explicitInstrumentors);
  state.instrumentors = started;
  state.ready = ready;

  void warnIfDefaultCollectorUnreachable(config).catch((error: unknown) => {
    logger.debug(`Collector reachability check skipped: ${String(error)}`);
  });

  // Node has no equivalent of the SDK's atexit hook: without this, whatever is
  // still queued when the event loop drains is lost.
  const onBeforeExit = (): void => {
    void uninstrument();
  };
  process.once('beforeExit', onBeforeExit);
  state.onBeforeExit = onBeforeExit;

  if (config.flushOnSigterm) {
    try {
      installSigtermFlushHandler(config, state);
    } catch (error) {
      logger.error(`Failed to install SIGTERM flush handler: ${String(error)}`);
      if (config.failOnError) throw error;
    }
  }

  logger.info('Auto-instrumentation setup complete');
  return state.handle;
}

/**
 * Set up OpenTelemetry for a GenAI application.
 *
 * Options override environment variables. Returns a handle, or `undefined` when
 * instrumentation could not be set up - in which case the reason has been
 * logged and the host application runs uninstrumented. With
 * `GENAI_FAIL_ON_ERROR=true` the error is thrown instead.
 */
export function instrument(options: InstrumentOptions = {}): InstrumentationHandle | undefined {
  const existing = activeState();
  if (existing) {
    logger.warn('Auto-instrumentation already initialized, skipping re-initialization');
    return existing.handle;
  }

  const { spanProcessors: _spanProcessors, metricReaders: _metricReaders, ...overrides } = options;
  const failOnError =
    overrides.failOnError ?? (process.env.GENAI_FAIL_ON_ERROR ?? 'false').toLowerCase() === 'true';
  const explicitInstrumentors =
    overrides.enabledInstrumentors !== undefined || Boolean(process.env.GENAI_ENABLED_INSTRUMENTORS);

  try {
    const config = loadConfig(overrides);
    return setup(config, options, explicitInstrumentors);
  } catch (error) {
    // A half-built setup must not be left registered.
    if (activeState()) void uninstrument();
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      error instanceof ConfigError
        ? `Invalid configuration, the application is NOT instrumented: ${reason}`
        : `Failed to set up instrumentation, the application is NOT instrumented: ${reason}`,
    );
    if (failOnError) throw error;
    return undefined;
  }
}

/**
 * Flush and shut down the providers, remove the patches, and allow
 * `instrument()` to be called again. Bounded by `timeoutSeconds`; never rejects.
 */
export async function uninstrument(timeoutSeconds = 5.0): Promise<void> {
  const state = activeState();
  if (!state) {
    logger.debug('Instrumentation not initialized, nothing to uninstrument');
    return;
  }
  clearStateSlot(STATE_SLOT);

  if (state.onBeforeExit) process.removeListener('beforeExit', state.onBeforeExit);
  if (state.onSigterm) process.removeListener('SIGTERM', state.onSigterm);
  state.gpu?.stop();
  for (const poller of state.enginePollers ?? []) poller.stop();

  // Last in, first out: an instrumentor that wrapped a method on top of another's comes off first.
  for (const instrumentor of [...state.instrumentors].reverse()) {
    try {
      instrumentor.uninstrument();
    } catch (error) {
      logger.debug(`Error removing instrumentation: ${String(error)}`);
    }
  }

  // Both providers share one deadline: a collector that is down must not turn
  // shutdown into a hang, and the two waits must not add up.
  const timeoutMs = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  await Promise.all(
    (
      [
        ['TracerProvider', state.handle.tracerProvider],
        ['MeterProvider', state.handle.meterProvider],
      ] as const
    ).map(async ([name, provider]) => {
      try {
        const outcome = await withDeadline(provider.shutdown(), timeoutMs);
        if (outcome === 'timeout') {
          logger.warn(`${name} did not shut down within ${timeoutSeconds}s; telemetry may be incomplete`);
        } else {
          logger.info(`${name} shut down`);
        }
      } catch (error) {
        logger.debug(`Error shutting down ${name}: ${String(error)}`);
      }
    }),
  );

  resetMeterBoundState();

  // Only take down the globals this call put up; a host application's own
  // providers are not ours to remove.
  if (state.registeredTracer) trace.disable();
  if (state.registeredMeter) metrics.disable();
  if (state.registeredPropagator) propagation.disable();
  if (state.contextManager) {
    context.disable();
    state.contextManager.disable();
  }
  logger.info('Instrumentation teardown complete');
}
