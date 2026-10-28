/**
 * `instrument()` for runtimes without a process: browsers and React Native.
 *
 * What differs from Node:
 *  - configuration is passed in, under the option names or under the same
 *    names as the environment variables (`OTEL_SERVICE_NAME: 'my-app'`), which
 *    are parsed exactly as the environment is;
 *  - there is no default endpoint. Exporting from a user's device is a data
 *    path out of that device, so where it goes is always said explicitly;
 *  - export is OTLP/HTTP JSON over `fetch`;
 *  - nothing is patched. Calls are traced with `traceGenAiCall()`;
 *  - the resource carries no host, process or OS attributes.
 */
import { context, metrics, trace } from '@opentelemetry/api';
import { defaultResource, resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { loadConfig, type OTelConfig } from '../config';
import { costCalculatorFor } from '../cost/default';
import { CostEnrichmentSpanProcessor } from '../cost/enrichment-processor';
import { resetPricingMissingCounter } from '../cost/pricing-missing';
import { setAmbientEnv, type Env } from '../env';
import { logger } from '../logger';
import { metricViews, resetSharedMetrics } from '../metrics';
import { OPENINFERENCE_PROJECT_NAME } from '../resource-attributes';
import { OpenInferenceSpanProcessor } from '../openinference';
import { SessionSpanProcessor } from '../session';
import { clearStateSlot, globalState } from '../state';
import { VERSION } from '../version';
import { startOnDeviceInstrumentors, stopOnDeviceInstrumentors } from '../on-device';
import { manualInstrumentor } from './manual';
import { setAppSpanContentCapture } from '../app-spans';
import { setActivateCallSpans } from '../call-scope';
import { RootSpanFlushProcessor } from './root-flush';
import { type Destination, fanOutFetch } from './destinations';
import { PromiseScopeContextManager } from './promise-context';
import { FetchMetricExporter, FetchSpanExporter, signalUrl, type FetchLike } from './otlp-fetch';

/** One package, one distro name, whichever runtime it is loaded in. */
const DISTRO_NAME = 'genai-otel-instrument-node';
const STATE_SLOT = 'web.instrumentation';
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** React Native's `AppState`, or anything shaped like it. */
export interface AppStateLike {
  addEventListener(event: 'change', listener: (state: string) => void): { remove(): void } | undefined;
}

export interface WebInstrumentOptions extends Partial<OTelConfig> {
  /** `fetch` to export with; the global one by default. */
  fetch?: typeof fetch;
  /** Extra span processors, run before the exporting processor. */
  spanProcessors?: SpanProcessor[];
  /** Extra metric readers, alongside the exporting reader. */
  metricReaders?: IMetricReader[];
  /** Milliseconds between metric exports. Default 60000. */
  metricExportIntervalMillis?: number;
  /**
   * More backends that receive the same telemetry as `endpoint`, each with its own headers
   * (e.g. your own collector and a hosted one).
   */
  additionalDestinations?: Destination[];
  /**
   * Add `openinference.span.kind` to every span (default true), so Arize AX and
   * Phoenix classify on-device operations that have no GenAI operation to map:
   * speech to text, model loads, the application's own pipeline steps.
   */
  openInferenceSpanKinds?: boolean;
  /** Any setting under its environment-variable name, as a string. */
  [envName: Uppercase<string>]: string | undefined;
}

export interface ReactNativeInstrumentOptions extends WebInstrumentOptions {
  /**
   * React Native's `AppState`, to flush when the app leaves the foreground. The React Native
   * entry finds it on its own; pass it only to use another.
   */
  appState?: AppStateLike;
}

export interface WebInstrumentationHandle {
  config: OTelConfig;
  resource: Resource;
  tracerProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
  exporter: 'otlp-http-json';
}

interface ActiveState {
  handle: WebInstrumentationHandle;
  spanExporter: FetchSpanExporter;
  metricExporter: FetchMetricExporter;
  registeredTracer: boolean;
  registeredMeter: boolean;
  registeredContext: boolean;
  appStateSubscription: { remove(): void } | undefined;
}

const NON_CONFIG_OPTIONS = new Set([
  'fetch',
  'additionalDestinations',
  'spanProcessors',
  'metricReaders',
  'metricExportIntervalMillis',
  'appState',
  'openInferenceSpanKinds',
]);

function activeState(): ActiveState | undefined {
  return globalState()[STATE_SLOT] as ActiveState | undefined;
}

/** Split what the application passed into environment-named settings and option-named ones. */
function splitOptions(options: Record<string, unknown>): { env: Env; overrides: Partial<OTelConfig> } {
  const env: Env = {};
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || NON_CONFIG_OPTIONS.has(key)) continue;
    if (ENV_NAME.test(key)) env[key] = String(value);
    else overrides[key] = value;
  }
  return { env, overrides: overrides as Partial<OTelConfig> };
}

function randomInstanceId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  // React Native has no Web Crypto by default. This id names an app instance; it is not a secret.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function buildWebResource(config: OTelConfig, env: Env): Resource {
  const attributes: Record<string, string> = {
    'service.name': config.serviceName,
    'service.instance.id': env.OTEL_SERVICE_INSTANCE_ID || randomInstanceId(),
    'telemetry.distro.name': DISTRO_NAME,
    'telemetry.distro.version': VERSION,
  };
  if (env.OTEL_ENVIRONMENT) attributes['deployment.environment.name'] = env.OTEL_ENVIRONMENT;
  // Arize AX files traces under a project and rejects those that name none.
  attributes[OPENINFERENCE_PROJECT_NAME] = env.OPENINFERENCE_PROJECT_NAME || config.serviceName;
  // defaultResource() supplies telemetry.sdk.* for the runtime the OpenTelemetry SDK was built for.
  return defaultResource().merge(resourceFromAttributes(attributes));
}

function withDeadline<T>(work: Promise<T>, millis: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), millis);
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

function setup(
  config: OTelConfig,
  env: Env,
  options: ReactNativeInstrumentOptions,
  endpoint: string,
  fetchImpl: FetchLike,
): WebInstrumentationHandle {
  const resource = buildWebResource(config, env);
  const timeoutMillis = Math.max(1, Math.trunc(config.exporterTimeout * 1000));
  const spanExporter = new FetchSpanExporter({
    url: signalUrl(endpoint, 'v1/traces'),
    fetch: fetchImpl,
    headers: config.headers,
    timeoutMillis,
  });
  const metricExporter = new FetchMetricExporter({
    url: signalUrl(endpoint, 'v1/metrics'),
    fetch: fetchImpl,
    headers: config.headers,
    timeoutMillis,
  });

  const spanProcessors: SpanProcessor[] = [new SessionSpanProcessor()];
  if (config.enableCostTracking) spanProcessors.push(new CostEnrichmentSpanProcessor(costCalculatorFor(config.customPricingJson)));
  spanProcessors.push(...(options.spanProcessors ?? []));
  if (options.openInferenceSpanKinds !== false) spanProcessors.push(new OpenInferenceSpanProcessor());
  // Batched: ending a span only enqueues it. Nothing is sent on the caller's path.
  spanProcessors.push(new BatchSpanProcessor(spanExporter));
  // Then a finished trace is sent at once: the batch timer stalls when the app is in the
  // background, which is where a trace often ends (a tool that opened another app).
  spanProcessors.push(new RootSpanFlushProcessor(() => tracerProvider.forceFlush()));

  const sampler = config.samplingRate < 1.0 ? new TraceIdRatioBasedSampler(config.samplingRate) : undefined;
  const tracerProvider = new BasicTracerProvider({ resource, sampler, spanProcessors });
  const exportIntervalMillis = options.metricExportIntervalMillis ?? 60000;
  const meterProvider = new MeterProvider({
    resource,
    views: metricViews(),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis,
        exportTimeoutMillis: Math.min(timeoutMillis, exportIntervalMillis),
      }),
      ...(options.metricReaders ?? []),
    ],
  });

  const state: ActiveState = {
    handle: { config, resource, tracerProvider, meterProvider, exporter: 'otlp-http-json' },
    spanExporter,
    metricExporter,
    registeredTracer: trace.setGlobalTracerProvider(tracerProvider),
    registeredMeter: metrics.setGlobalMeterProvider(meterProvider),
    // No async context here: without this every instrumented call starts its own trace.
    registeredContext: context.setGlobalContextManager(new PromiseScopeContextManager().enable()),
    appStateSubscription: undefined,
  };
  globalState()[STATE_SLOT] = state;
  setAppSpanContentCapture(config.enableContentCapture, config.contentMaxLength);
  // One shared scope stack here: a model call running in the background must not become the
  // parent of everything started meanwhile. Only the application's context.with() scopes count.
  if (state.registeredContext) setActivateCallSpans(false);
  // Instruments are bound to the provider that created them.
  resetPricingMissingCounter();
  resetSharedMetrics();
  manualInstrumentor().instrument(config);
  startOnDeviceInstrumentors(config);

  const appState = options.appState;
  if (appState) {
    // A backgrounded app may be suspended or killed without notice: send what is queued now.
    state.appStateSubscription =
      appState.addEventListener('change', (next) => {
        if (next === 'background' || next === 'inactive') void flushTelemetry();
      }) ?? undefined;
  }
  logger.info(`Instrumentation started, exporting OTLP/HTTP JSON to ${endpoint}`);
  return state.handle;
}

/**
 * Set up OpenTelemetry for a GenAI application in a browser or in React Native.
 *
 * Returns a handle, or `undefined` when instrumentation could not be set up -
 * the reason has been logged and the application runs uninstrumented. With
 * `failOnError: true` (or `GENAI_FAIL_ON_ERROR: 'true'`) the error is thrown.
 */
export function instrument(options: ReactNativeInstrumentOptions = {}): WebInstrumentationHandle | undefined {
  const existing = activeState();
  if (existing) {
    logger.warn('Instrumentation already initialized, skipping re-initialization');
    return existing.handle;
  }
  const { env, overrides } = splitOptions(options as Record<string, unknown>);
  // The logger's threshold and every later setting read come from what was passed in.
  setAmbientEnv(env);
  const failOnError = overrides.failOnError ?? (env.GENAI_FAIL_ON_ERROR ?? '').toLowerCase() === 'true';
  try {
    const endpoint = overrides.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        'no endpoint: pass `endpoint` (or OTEL_EXPORTER_OTLP_ENDPOINT) to instrument(). ' +
          'There is no default in a browser or a React Native app; telemetry leaves the device only for a collector you name.',
      );
    }
    const fetchImpl = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchImpl !== 'function') throw new Error('no fetch available: pass `fetch` to instrument()');
    const config = loadConfig({ ...overrides, endpoint }, env);
    const exportFetch = fanOutFetch(endpoint, options.additionalDestinations ?? [], fetchImpl as unknown as FetchLike);
    return setup(config, env, options, endpoint, exportFetch);
  } catch (error) {
    logger.error(`Failed to initialize instrumentation: ${String(error)}`);
    if (failOnError) throw error;
    return undefined;
  }
}

export function isInstrumented(): boolean {
  return activeState() !== undefined;
}

/**
 * Send what is queued. Resolves true only if the collector accepted everything
 * within `timeoutSeconds`. Never rejects.
 */
export async function flushTelemetry(timeoutSeconds = 5.0): Promise<boolean> {
  const state = activeState();
  if (!state) return true;
  const timeoutMs = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  const failuresBefore = state.spanExporter.failures + state.metricExporter.failures;
  const flushed = await Promise.all(
    [state.handle.tracerProvider, state.handle.meterProvider].map(async (provider) => {
      try {
        return (await withDeadline(provider.forceFlush(), timeoutMs)) !== 'timeout';
      } catch (error) {
        logger.debug(`forceFlush failed: ${String(error)}`);
        return false;
      }
    }),
  );
  return flushed.every(Boolean) && state.spanExporter.failures + state.metricExporter.failures === failuresBefore;
}

/** Stop: flush under one deadline, shut the providers down, take down the globals this put up. */
export async function uninstrument(timeoutSeconds = 5.0): Promise<void> {
  const state = activeState();
  if (!state) return;
  clearStateSlot(STATE_SLOT);
  try {
    state.appStateSubscription?.remove();
  } catch (error) {
    logger.debug(`Could not remove the app-state listener: ${String(error)}`);
  }
  manualInstrumentor().uninstrument();
  stopOnDeviceInstrumentors();

  const timeoutMs = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  await Promise.all(
    [state.handle.tracerProvider, state.handle.meterProvider].map(async (provider) => {
      try {
        if ((await withDeadline(provider.shutdown(), timeoutMs)) === 'timeout') {
          logger.warn(`Telemetry did not shut down within ${timeoutSeconds}s; it may be incomplete`);
        }
      } catch (error) {
        logger.debug(`Error shutting down telemetry: ${String(error)}`);
      }
    }),
  );
  resetPricingMissingCounter();
  resetSharedMetrics();
  if (state.registeredTracer) trace.disable();
  if (state.registeredMeter) metrics.disable();
  if (state.registeredContext) {
    context.disable();
    setActivateCallSpans(true);
  }
}
