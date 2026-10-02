/**
 * Server-side serving metrics: KV-cache usage per model, requests running and
 * waiting, and capacity. Port of `server_metrics.py` and of
 * `instrumentors/ollama_server_metrics_poller.py`.
 *
 * Values are set by the instrumented calls (requests in flight), by the Ollama
 * poller, or by the application for an engine it runs itself.
 *
 * Unlike the reference, a gauge reports nothing until its value was set once:
 * a "0 requests waiting" that nobody measured is not reported.
 */
import { metrics, type Meter, type ObservableResult } from '@opentelemetry/api';
import { logger } from './logger';
import { METRIC_DEFINITIONS, type MetricName } from './metrics';
import { clearStateSlot, stateSlot } from './state';

export const SERVER_METER_NAME = 'genai.server';

function gauge(meter: Meter, name: MetricName, observe: (result: ObservableResult) => void): void {
  const definition = METRIC_DEFINITIONS[name];
  meter
    .createObservableGauge(definition.name, { description: definition.description, ...(definition.unit ? { unit: definition.unit } : {}) })
    .addCallback(observe);
}

export class ServerMetricsCollector {
  private readonly kvCacheUsage = new Map<string, number>();
  private running: number | undefined;
  private waiting: number | undefined;
  private max: number | undefined;

  constructor(meter: Meter) {
    gauge(meter, 'gen_ai.server.kv_cache.usage', (result) => {
      for (const [model, usage] of this.kvCacheUsage) result.observe(usage, { model });
    });
    gauge(meter, 'gen_ai.server.requests.running', (result) => {
      if (this.running !== undefined) result.observe(this.running);
    });
    gauge(meter, 'gen_ai.server.requests.waiting', (result) => {
      if (this.waiting !== undefined) result.observe(this.waiting);
    });
    gauge(meter, 'gen_ai.server.requests.max', (result) => {
      if (this.max !== undefined) result.observe(this.max);
    });
    logger.info('Server metrics collector initialized');
  }

  /** KV-cache usage of a model, as a percentage; bounded to 0..100. */
  setKvCacheUsage(modelName: string, usagePercent: number): void {
    this.kvCacheUsage.set(modelName, Math.min(100.0, Math.max(0.0, usagePercent)));
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
}

const SLOT = 'server-metrics';

/** The process-wide collector, or undefined before `instrument()`. */
export function getServerMetrics(): ServerMetricsCollector | undefined {
  return stateSlot<{ collector?: ServerMetricsCollector }>(SLOT, () => ({})).collector;
}

export function initializeServerMetrics(meter: Meter = metrics.getMeter(SERVER_METER_NAME)): ServerMetricsCollector {
  const slot = stateSlot<{ collector?: ServerMetricsCollector }>(SLOT, () => ({}));
  if (!slot.collector) slot.collector = new ServerMetricsCollector(meter);
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

// --- Ollama ------------------------------------------------------------------------

const GIB = 1024 ** 3;

export interface OllamaPollerOptions {
  /** Default `http://localhost:11434`. */
  baseUrl?: string;
  /** Default 5. */
  intervalSeconds?: number;
  /** The VRAM a model's share is taken of. When absent, `detectVram` is asked once. */
  maxVramGb?: number;
  /** How to find the host's VRAM in GB. Absent in runtimes that cannot. */
  detectVram?: () => Promise<number | undefined>;
  /** Seconds before a poll is abandoned. Default 2. */
  timeoutSeconds?: number;
}

/**
 * Polls an Ollama server's `/api/ps` for the models it has loaded.
 *
 * As in the reference, what is reported under `gen_ai.server.kv_cache.usage`
 * is each model's VRAM as a share of the GPU's - an approximation of pressure,
 * not the KV cache itself - and `gen_ai.server.requests.max` is the number of
 * loaded models.
 *
 * The share needs the GPU's VRAM. The reference assumes 8 GB when it cannot
 * find out; here the share is not reported at all in that case.
 */
export class OllamaServerMetricsPoller {
  readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly urlValid: boolean;
  private maxVramBytes: number | undefined;
  private vramResolved: boolean;
  private readonly detectVram: (() => Promise<number | undefined>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: OllamaPollerOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.intervalMs = Math.max(1, (options.intervalSeconds ?? 5.0) * 1000);
    this.timeoutMs = Math.max(1, (options.timeoutSeconds ?? 2.0) * 1000);
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(this.baseUrl)?.[1]?.toLowerCase();
    this.urlValid = scheme === 'http' || scheme === 'https';
    if (!this.urlValid) {
      logger.warn(`Ollama server metrics poller: refusing to poll non-http(s) URL '${this.baseUrl}' (scheme=${scheme ?? 'none'}); polling disabled`);
    }
    this.detectVram = options.detectVram;
    if (typeof options.maxVramGb === 'number' && options.maxVramGb > 0) {
      this.maxVramBytes = options.maxVramGb * GIB;
      this.vramResolved = true;
    } else {
      this.vramResolved = options.detectVram === undefined;
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
    logger.info(`Ollama server metrics poller started (interval=${this.intervalMs / 1000}s, url=${this.baseUrl})`);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    logger.info('Ollama server metrics poller stopped');
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let data: unknown;
      try {
        const response = await fetch(`${this.baseUrl}/api/ps`, { signal: controller.signal });
        if (!response.ok) {
          logger.warn(`Error querying Ollama server: HTTP ${response.status}`);
          return;
        }
        data = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const models = typeof data === 'object' && data !== null && Array.isArray((data as { models?: unknown }).models) ? (data as { models: unknown[] }).models : [];
      if (models.length > 0) collector.setRequestsMax(models.length);
      if (models.length === 0) return;

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
      if (this.maxVramBytes === undefined) return;
      for (const model of models) {
        if (typeof model !== 'object' || model === null) continue;
        const info = model as { name?: unknown; size_vram?: unknown };
        const vram = typeof info.size_vram === 'number' ? info.size_vram : 0;
        collector.setKvCacheUsage(typeof info.name === 'string' ? info.name : 'unknown', Math.min(100.0, (vram / this.maxVramBytes) * 100));
      }
    } catch (error) {
      // Connection refused, timeout, a body that is not JSON.
      logger.debug(`Cannot collect Ollama server metrics from ${this.baseUrl}: ${String(error)}`);
    }
  }
}
