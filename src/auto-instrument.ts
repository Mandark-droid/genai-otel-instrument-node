/**
 * One-call setup: tracer and meter providers, OTLP exporters, instrumentors.
 *
 * Port of `genai_otel/auto_instrument.py`. The parts that belong to later
 * phases (GPU collection, server metrics, MCP/datastore instrumentors,
 * evaluation) are not wired here yet; a setting that asks for one of them is
 * reported, never silently ignored.
 */
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
  type ViewOptions,
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
import {
  instrumentorFactory,
  isReferenceOnlyInstrumentor,
  type Instrumentor,
} from './instrumentors/registry';
import { logger } from './logger';
import { buildResource } from './resource';
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
}

/**
 * Hooks later modules attach to the setup: metric views and extra span
 * processors. Kept as registration points so this file does not import a
 * module that an earlier build of the package does not have.
 */
type ViewProvider = () => ViewOptions[];
type ProcessorProvider = (config: OTelConfig) => SpanProcessor[];
const viewProviders: ViewProvider[] = [];
const processorProviders: ProcessorProvider[] = [];

export function registerViewProvider(provider: ViewProvider): void {
  viewProviders.push(provider);
}

export function registerSpanProcessorProvider(provider: ProcessorProvider): void {
  processorProviders.push(provider);
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

/** Settings whose feature lands in a later phase of this SDK. Reported, not ignored. */
function reportUnhonouredSettings(config: OTelConfig, env: Env): void {
  const pending: [boolean, string][] = [
    [config.enablePiiDetection, 'GENAI_ENABLE_PII_DETECTION'],
    [config.enableToxicityDetection, 'GENAI_ENABLE_TOXICITY_DETECTION'],
    [config.enableBiasDetection, 'GENAI_ENABLE_BIAS_DETECTION'],
    [config.enablePromptInjectionDetection, 'GENAI_ENABLE_PROMPT_INJECTION_DETECTION'],
    [config.enableRestrictedTopics, 'GENAI_ENABLE_RESTRICTED_TOPICS'],
    [config.enableHallucinationDetection, 'GENAI_ENABLE_HALLUCINATION_DETECTION'],
    [config.enableCo2Tracking, 'GENAI_ENABLE_CO2_TRACKING'],
    [config.enableHttpInstrumentation, 'GENAI_ENABLE_HTTP_INSTRUMENTATION'],
    [config.mediaCaptureMode !== 'off', 'GENAI_OTEL_MEDIA_CAPTURE_MODE'],
  ];
  const asked = pending.filter(([enabled]) => enabled).map(([, name]) => name);
  if (asked.length > 0) {
    logger.warn(
      `Not available in @traceverse/genai-otel-instrument ${VERSION} and therefore NOT in effect: ` +
        `${asked.join(', ')}. See docs/parity-matrix.md.`,
    );
  }
  // On by default in the reference implementation, so only say it loudly when
  // the operator asked for it by name.
  for (const [enabled, name] of [
    [config.enableGpuMetrics, 'GENAI_ENABLE_GPU_METRICS'],
    [config.enableMcpInstrumentation, 'GENAI_ENABLE_MCP_INSTRUMENTATION'],
  ] as const) {
    if (!enabled) continue;
    const message = `${name} is enabled but not available in @traceverse/genai-otel-instrument ${VERSION}; nothing is collected for it.`;
    if (env[name] !== undefined) logger.warn(message);
    else logger.debug(message);
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
  logger.info('Starting auto-instrumentation setup...');
  installDiagLogger();

  const resource = buildResource(config.serviceName, VERSION, config.profile);

  const spanProcessors: SpanProcessor[] = [];
  for (const provider of processorProviders) spanProcessors.push(...provider(config));
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

  const views: ViewOptions[] = [];
  for (const provider of viewProviders) views.push(...provider());
  const readers: IMetricReader[] = [
    new PeriodicExportingMetricReader({ exporter: metricExporter, ...metricIntervals() }),
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

  reportUnhonouredSettings(config, process.env);
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

  for (const instrumentor of state.instrumentors) {
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
