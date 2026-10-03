/**
 * Server-side serving metrics: KV-cache usage per model, requests running and
 * waiting, and capacity. Port of `server_metrics.py` and of
 * `instrumentors/ollama_server_metrics_poller.py`, with the vLLM / llama.cpp
 * endpoint poller and the prefix cache of contract/SDK_ADDITIONS.md sections 12
 * and 13.
 *
 * Where each value comes from is on it (section 12):
 * - `server_metrics_source="engine"`: what a poller read from a serving engine
 *   (Ollama, vLLM, llama.cpp). Every poll replaces that engine's figures, so a
 *   model that unloads disappears; an engine that cannot be read reports nothing.
 * - `server_metrics_source="client"`: the number of this SDK's own model calls in
 *   flight (`GENAI_ENABLE_CONCURRENCY_METRICS`, default on).
 * - no label: what the application sets through the collector's methods, the
 *   reference's API.
 *
 * A value nobody measured is not reported: a "0 requests waiting" that nobody
 * measured would read as an idle server.
 */
import { metrics, type Meter, type ObservableResult } from '@opentelemetry/api';
import { logger } from './logger';
import { METRIC_DEFINITIONS, type MetricName } from './metrics';
import { ownFetch } from './own-fetch';
import { clearStateSlot, stateSlot } from './state';

export const SERVER_METER_NAME = 'genai.server';

export const SERVER_METRICS_SOURCE = 'server_metrics_source';
const ENGINE = { [SERVER_METRICS_SOURCE]: 'engine' };
const CLIENT = { [SERVER_METRICS_SOURCE]: 'client' };

/**
 * Section 13: vLLM's prefix-cache counters, reported as gauges of the engine's
 * cumulative value - a counter would be exported with a `_total` suffix, which
 * the platform does not read. Not in the reference.
 */
const PREFIX_CACHE = {
  queries: { name: 'gen_ai.server.prefix_cache.queries', description: 'Prefix-cache queries reported by the serving engine, in tokens (cumulative)' },
  hits: { name: 'gen_ai.server.prefix_cache.hits', description: 'Prefix-cache hits reported by the serving engine, in tokens (cumulative)' },
} as const;

function gauge(meter: Meter, name: MetricName, observe: (result: ObservableResult) => void): void {
  const definition = METRIC_DEFINITIONS[name];
  meter
    .createObservableGauge(definition.name, { description: definition.description, ...(definition.unit ? { unit: definition.unit } : {}) })
    .addCallback(observe);
}

/** One engine's latest reading. An absent figure was not reported. Prefix-cache maps are keyed by model ('' when unlabelled). */
export interface EngineReading {
  kvCacheByModel?: Map<string, number>;
  waiting?: number;
  max?: number;
  prefixQueriesByModel?: Map<string, number>;
  prefixHitsByModel?: Map<string, number>;
}

const clamp = (value: number): number => Math.min(100.0, Math.max(0.0, value));

export class ServerMetricsCollector {
  private readonly kvCacheUsage = new Map<string, number>();
  private running: number | undefined;
  private waiting: number | undefined;
  private max: number | undefined;
  private clientRunning = 0;
  private readonly engines = new Map<string, EngineReading>();

  constructor(
    meter: Meter,
    private readonly countClientCalls = true,
  ) {
    gauge(meter, 'gen_ai.server.kv_cache.usage', (result) => {
      const byModel = new Map<string, number>();
      for (const reading of this.engines.values()) {
        // A model two engines report keeps the larger figure.
        for (const [model, usage] of reading.kvCacheByModel ?? []) byModel.set(model, Math.max(byModel.get(model) ?? 0, clamp(usage)));
      }
      for (const [model, usage] of byModel) result.observe(usage, { model, ...ENGINE });
      for (const [model, usage] of this.kvCacheUsage) result.observe(usage, { model });
    });
    gauge(meter, 'gen_ai.server.requests.running', (result) => {
      if (this.countClientCalls) result.observe(this.clientRunning, CLIENT);
      if (this.running !== undefined) result.observe(this.running);
    });
    gauge(meter, 'gen_ai.server.requests.waiting', (result) => this.observeQueue(result, this.waiting, (reading) => reading.waiting));
    gauge(meter, 'gen_ai.server.requests.max', (result) => this.observeQueue(result, this.max, (reading) => reading.max));
    for (const [figure, definition] of [
      ['prefixQueriesByModel', PREFIX_CACHE.queries],
      ['prefixHitsByModel', PREFIX_CACHE.hits],
    ] as const) {
      meter.createObservableGauge(definition.name, { description: definition.description, unit: '{token}' }).addCallback((result) => {
        const byModel = new Map<string, number>();
        for (const reading of this.engines.values()) {
          for (const [model, value] of reading[figure] ?? []) byModel.set(model, (byModel.get(model) ?? 0) + value);
        }
        for (const [model, value] of byModel) result.observe(value, model ? { model, ...ENGINE } : ENGINE);
      });
    }
    logger.info('Server metrics collector initialized');
  }

  private observeQueue(result: ObservableResult, manual: number | undefined, figure: (reading: EngineReading) => number | undefined): void {
    let total = 0;
    let any = false;
    for (const reading of this.engines.values()) {
      const value = figure(reading);
      if (value === undefined) continue;
      total += value;
      any = true;
    }
    if (any) result.observe(total, ENGINE);
    if (manual !== undefined) result.observe(manual);
  }

  // --- the reference's API: values the application sets itself -----------------------

  /** KV-cache usage of a model, as a percentage; bounded to 0..100. */
  setKvCacheUsage(modelName: string, usagePercent: number): void {
    this.kvCacheUsage.set(modelName, clamp(usagePercent));
  }

  setRequestsRunning(count: number): void {
    this.running = Math.max(0, count);
  }

  setRequestsWaiting(count: number): void {
    this.waiting = Math.max(0, count);
  }

  setRequestsMax(count: number): void {
    this.max = Math.max(0, count);
  }

  incrementRequestsRunning(delta = 1): void {
    this.running = Math.max(0, (this.running ?? 0) + delta);
  }

  decrementRequestsRunning(delta = 1): void {
    this.running = Math.max(0, (this.running ?? 0) - delta);
  }

  incrementRequestsWaiting(delta = 1): void {
    this.waiting = Math.max(0, (this.waiting ?? 0) + delta);
  }

  decrementRequestsWaiting(delta = 1): void {
    this.waiting = Math.max(0, (this.waiting ?? 0) - delta);
  }

  // --- this SDK's own calls -------------------------------------------------------------

  /** One of this SDK's model calls started. */
  clientCallStarted(): void {
    this.clientRunning += 1;
  }

  /** One of this SDK's model calls ended. */
  clientCallEnded(): void {
    this.clientRunning = Math.max(0, this.clientRunning - 1);
  }

  // --- engines --------------------------------------------------------------------------

  /** Replace everything `source` reported with this reading. */
  replaceEngine(source: string, reading: EngineReading): void {
    this.engines.set(source, reading);
  }

  /** Forget what `source` reported: it stopped, or could not be read. */
  forgetEngine(source: string): void {
    this.engines.delete(source);
  }
}

const SLOT = 'server-metrics';

/** The process-wide collector, or undefined before `instrument()`. */
export function getServerMetrics(): ServerMetricsCollector | undefined {
  return stateSlot<{ collector?: ServerMetricsCollector }>(SLOT, () => ({})).collector;
}

export function initializeServerMetrics(meter: Meter = metrics.getMeter(SERVER_METER_NAME), countClientCalls = true): ServerMetricsCollector {
  const slot = stateSlot<{ collector?: ServerMetricsCollector }>(SLOT, () => ({}));
  if (!slot.collector) slot.collector = new ServerMetricsCollector(meter, countClientCalls);
  return slot.collector;
}

export function resetServerMetrics(): void {
  clearStateSlot(SLOT);
}

// --- the host's GPU ---------------------------------------------------------------

type VramDetector = () => Promise<number | undefined>;

/**
 * How to find the VRAM of the host's first GPU, in GB. Set by the entry of a
 * runtime that can (Node, through `nvidia-smi`); absent elsewhere.
 */
export function setVramDetector(detector: VramDetector | undefined): void {
  stateSlot<{ detector?: VramDetector }>('server-metrics.vram', () => ({})).detector = detector;
}

export function vramDetector(): VramDetector | undefined {
  return stateSlot<{ detector?: VramDetector }>('server-metrics.vram', () => ({})).detector;
}

// --- engine pollers -----------------------------------------------------------------

export interface EnginePollerOptions {
  baseUrl: string;
  /** Default 5. */
  intervalSeconds?: number;
  /** Seconds before a poll is abandoned. Default 2. */
  timeoutSeconds?: number;
}

/**
 * Polls one serving engine on an interval and hands each reading to the
 * collector. Only http(s) URLs are polled. A poll that fails leaves the engine
 * unreported until it can be read again. Never keeps a finished application alive.
 */
abstract class EnginePoller {
  readonly baseUrl: string;
  protected readonly source: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly urlValid: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;

  protected constructor(kind: string, options: EnginePollerOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.source = `${kind}:${this.baseUrl}`;
    this.intervalMs = Math.max(1, (options.intervalSeconds ?? 5.0) * 1000);
    this.timeoutMs = Math.max(1, (options.timeoutSeconds ?? 2.0) * 1000);
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(this.baseUrl)?.[1]?.toLowerCase();
    this.urlValid = scheme === 'http' || scheme === 'https';
    if (!this.urlValid) {
      logger.warn(`${kind} server metrics poller: refusing to poll non-http(s) URL '${this.baseUrl}' (scheme=${scheme ?? 'none'}); polling disabled`);
    }
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined || !this.urlValid) return;
    const tick = (): void => {
      void this.collect();
    };
    this.timer = setInterval(tick, this.intervalMs);
    // Polling must not keep a finished application alive.
    (this.timer as { unref?: () => void }).unref?.();
    tick();
    logger.info(`Server metrics poller started (interval=${this.intervalMs / 1000}s, url=${this.baseUrl})`);
  }

  /** Stop polling and forget what this engine reported. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    getServerMetrics()?.forgetEngine(this.source);
  }

  /** One poll. Never rejects: a server that is down is the normal case on most hosts. */
  async collect(): Promise<void> {
    if (!this.urlValid) return;
    const collector = getServerMetrics();
    if (!collector) {
      logger.debug('Server metrics collector not initialized, skipping update');
      return;
    }
    try {
      const reading = await this.read();
      collector.replaceEngine(this.source, reading);
    } catch (error) {
      // Connection refused, timeout, an answer that cannot be read: nothing is known now.
      collector.forgetEngine(this.source);
      logger.debug(`Cannot collect server metrics from ${this.baseUrl}: ${String(error)}`);
    }
  }

  protected abstract read(): Promise<EngineReading>;

  /** GET `baseUrl + path`, untraced; a 2xx answer. */
  protected async get(path: string): Promise<Response> {
    const response = await ownFetch(`${this.baseUrl}${path}`, {}, this.timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }
}

// --- Ollama ------------------------------------------------------------------------

const GIB = 1024 ** 3;

export interface OllamaPollerOptions extends Partial<EnginePollerOptions> {
  /** Default `http://localhost:11434`. */
  baseUrl?: string;
  /** The VRAM a model's share is taken of. When absent, `detectVram` is asked once. */
  maxVramGb?: number;
  /** How to find the host's VRAM in GB. Absent in runtimes that cannot. */
  detectVram?: () => Promise<number | undefined>;
}

/**
 * Polls an Ollama server's `/api/ps` for the models it has loaded.
 *
 * As in the reference, what is reported under `gen_ai.server.kv_cache.usage`
 * is each model's VRAM as a share of the GPU's - an approximation of pressure,
 * not the KV cache itself - and `gen_ai.server.requests.max` is the number of
 * loaded models. Unlike the reference, every poll replaces the previous figures:
 * a model that unloaded is no longer reported.
 *
 * The share needs the GPU's VRAM. The reference assumes 8 GB when it cannot
 * find out; here the share is not reported at all in that case.
 */
export class OllamaServerMetricsPoller extends EnginePoller {
  private maxVramBytes: number | undefined;
  private vramResolved: boolean;
  private readonly detectVram: (() => Promise<number | undefined>) | undefined;

  constructor(options: OllamaPollerOptions = {}) {
    super('ollama', { ...options, baseUrl: options.baseUrl ?? 'http://localhost:11434' });
    this.detectVram = options.detectVram;
    if (typeof options.maxVramGb === 'number' && options.maxVramGb > 0) {
      this.maxVramBytes = options.maxVramGb * GIB;
      this.vramResolved = true;
    } else {
      this.vramResolved = options.detectVram === undefined;
    }
  }

  protected async read(): Promise<EngineReading> {
    const data: unknown = await (await this.get('/api/ps')).json();
    const models = typeof data === 'object' && data !== null && Array.isArray((data as { models?: unknown }).models) ? (data as { models: unknown[] }).models : [];
    if (models.length === 0) return {};
    const reading: EngineReading = { max: models.length };

    if (!this.vramResolved) {
      this.vramResolved = true;
      try {
        const detected = await this.detectVram?.();
        if (typeof detected === 'number' && detected > 0) this.maxVramBytes = detected * GIB;
      } catch (error) {
        logger.debug(`Could not detect GPU VRAM: ${String(error)}`);
      }
      if (this.maxVramBytes === undefined) {
        logger.info('GPU VRAM is not known (set GENAI_OLLAMA_MAX_VRAM_GB): per-model VRAM share is not reported');
      }
    }
    if (this.maxVramBytes === undefined) return reading;
    reading.kvCacheByModel = new Map();
    for (const model of models) {
      if (typeof model !== 'object' || model === null) continue;
      const info = model as { name?: unknown; size_vram?: unknown };
      const vram = typeof info.size_vram === 'number' ? info.size_vram : 0;
      reading.kvCacheByModel.set(typeof info.name === 'string' ? info.name : 'unknown', Math.min(100.0, (vram / this.maxVramBytes) * 100));
    }
    return reading;
  }
}

// --- vLLM and llama.cpp ------------------------------------------------------------

interface Sample {
  name: string;
  labels: string;
  value: number;
}

/** One line of Prometheus text: `name{label="v",...} value [timestamp]`. */
function parseSample(line: string): Sample | undefined {
  const brace = line.indexOf('{');
  const space = line.indexOf(' ');
  let name: string;
  let labels = '';
  let rest: string;
  if (brace >= 0 && (space < 0 || brace < space)) {
    const close = line.lastIndexOf('}');
    if (close < brace) return undefined;
    name = line.slice(0, brace);
    labels = line.slice(brace + 1, close);
    rest = line.slice(close + 1).trim();
  } else if (space > 0) {
    name = line.slice(0, space);
    rest = line.slice(space + 1).trim();
  } else {
    return undefined;
  }
  const value = Number(rest.split(/\s+/)[0]);
  return rest !== '' && Number.isFinite(value) ? { name, labels, value } : undefined;
}

function label(labels: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|,)\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`).exec(labels);
  return match?.[1] || undefined;
}

const add = (map: Map<string, number>, key: string, value: number): void => {
  map.set(key, (map.get(key) ?? 0) + value);
};

/**
 * vLLM and llama.cpp, which publish Prometheus text at `/metrics`
 * (`GENAI_SERVER_METRICS_ENDPOINTS`; not in the reference). The engine is told
 * by its metric prefix, `vllm:` or `llamacpp:`. The same mapping as the .NET and
 * Java SDKs:
 *
 * - KV cache: `vllm:kv_cache_usage_perc` / `vllm:gpu_cache_usage_perc` per
 *   `model_name`; `llamacpp:kv_cache_usage_ratio`, keyed by the server's host and
 *   port since llama.cpp serves one model. Both are fractions, reported as percentages.
 * - Waiting: `vllm:num_requests_waiting`, `llamacpp:requests_deferred`.
 * - Prefix cache (section 13): `vllm:prefix_cache_queries_total` /
 *   `vllm:prefix_cache_hits_total` (older vLLM: `vllm:gpu_prefix_cache_*`), summed
 *   per `model_name` over the other labels (vLLM's data-parallel `engine`), as the
 *   cumulative value. A server that does not export them reports nothing. No hit
 *   rate is computed here.
 * - The engine's running count is not reported: `requests.running` is the count of
 *   this application's calls in flight.
 */
export class PrometheusServerMetricsPoller extends EnginePoller {
  /** The engine recognised at the last poll: `vllm`, `llamacpp`, or undefined. */
  engine: 'vllm' | 'llamacpp' | undefined;

  constructor(options: EnginePollerOptions) {
    super('prometheus', options);
  }

  protected async read(): Promise<EngineReading> {
    const text = await (await this.get('/metrics')).text();
    const host = new URL(this.baseUrl).host;
    const kvCacheByModel = new Map<string, number>();
    const prefixQueriesByModel = new Map<string, number>();
    const prefixHitsByModel = new Map<string, number>();
    let waiting: number | undefined;
    let found: 'vllm' | 'llamacpp' | undefined;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const sample = parseSample(line);
      if (!sample) continue;
      switch (sample.name) {
        case 'vllm:kv_cache_usage_perc':
        case 'vllm:gpu_cache_usage_perc': {
          found = 'vllm';
          const model = label(sample.labels, 'model_name') ?? host;
          kvCacheByModel.set(model, Math.max(kvCacheByModel.get(model) ?? 0, sample.value * 100));
          break;
        }
        case 'vllm:num_requests_waiting':
          found = 'vllm';
          waiting = (waiting ?? 0) + sample.value;
          break;
        case 'vllm:prefix_cache_queries_total':
        case 'vllm:gpu_prefix_cache_queries_total':
          found = 'vllm';
          add(prefixQueriesByModel, label(sample.labels, 'model_name') ?? '', sample.value);
          break;
        case 'vllm:prefix_cache_hits_total':
        case 'vllm:gpu_prefix_cache_hits_total':
          found = 'vllm';
          add(prefixHitsByModel, label(sample.labels, 'model_name') ?? '', sample.value);
          break;
        case 'llamacpp:kv_cache_usage_ratio':
          found = 'llamacpp';
          kvCacheByModel.set(host, sample.value * 100);
          break;
        case 'llamacpp:requests_deferred':
          found = 'llamacpp';
          waiting = (waiting ?? 0) + sample.value;
          break;
        default:
          if (sample.name.startsWith('vllm:')) found = 'vllm';
          else if (sample.name.startsWith('llamacpp:')) found = 'llamacpp';
      }
    }
    this.engine = found;
    return { kvCacheByModel, waiting, prefixQueriesByModel, prefixHitsByModel };
  }
}

/** Start a poller for every URL in `GENAI_SERVER_METRICS_ENDPOINTS` (comma-separated). */
export function startEndpointPollers(endpoints: string | undefined): PrometheusServerMetricsPoller[] {
  const pollers: PrometheusServerMetricsPoller[] = [];
  for (const endpoint of (endpoints ?? '').split(',')) {
    if (!endpoint.trim()) continue;
    const poller = new PrometheusServerMetricsPoller({ baseUrl: endpoint });
    poller.start();
    if (poller.running) pollers.push(poller);
  }
  return pollers;
}
