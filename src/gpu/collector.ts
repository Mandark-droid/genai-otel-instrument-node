/**
 * GPU metrics, and energy, cost and CO2 from measured GPU power.
 *
 * The reference reads NVML in-process (`gpu_metrics.py`) and delegates energy
 * and CO2 to codecarbon. Here the readings come from a `GpuSource` - on Node,
 * `nvidia-smi` - polled on an interval off the request path, and energy is the
 * measured power integrated over the time between two samples.
 *
 * What is not measured is not reported:
 * - no GPU on the host, or the tool failing: no instrument is created at all;
 * - a field a device does not report (`[N/A]`): that gauge has no point for it;
 * - no energy across a gap in the samples.
 *
 * One limit that is the metrics SDK's and not this collector's: while the
 * source is failing, and after collection has stopped, the collector observes
 * nothing - but under cumulative temporality the SDK goes on exporting the
 * last value a gauge was given. A stopped collector therefore shows as a flat
 * line, not as a gap.
 */
import { metrics, type Counter, type Histogram, type Meter, type ObservableResult } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { createCounter, createHistogram, METRIC_DEFINITIONS, type MetricName } from '../metrics';
import { stateSlot } from '../state';

export const GPU_METER_NAME = 'genai.gpu';

/** One device at one moment. A field that is absent was not reported by the device. */
export interface GpuSample {
  index: number;
  name: string;
  /** Percent. */
  utilization?: number;
  /** Memory controller utilisation, percent. */
  memoryUtilization?: number;
  memoryUsedMiB?: number;
  memoryTotalMiB?: number;
  temperatureC?: number;
  powerW?: number;
  powerLimitW?: number;
  smClockMHz?: number;
  memoryClockMHz?: number;
  /** Percent. */
  fanSpeed?: number;
  /** 0 (P0, highest) to 15. */
  performanceState?: number;
  /** 1 when throttling, 0 when not. */
  throttleThermal?: number;
  throttlePower?: number;
  throttleHwSlowdown?: number;
  eccCorrected?: number;
  eccUncorrected?: number;
  /** KB/s. No source in this SDK reports these yet. */
  pcieTxKBs?: number;
  pcieRxKBs?: number;
}

export interface GpuSource {
  /** The devices now. `undefined`: this host has nothing to ask. A failure rejects. */
  sample(): Promise<GpuSample[] | undefined>;
}

const PER_DEVICE: readonly [MetricName, keyof GpuSample][] = [
  ['gen_ai.gpu.utilization', 'utilization'],
  ['gen_ai.gpu.memory.used', 'memoryUsedMiB'],
  ['gen_ai.gpu.memory.total', 'memoryTotalMiB'],
  ['gen_ai.gpu.temperature', 'temperatureC'],
  ['gen_ai.gpu.power', 'powerW'],
  ['gen_ai.gpu.memory.utilization', 'memoryUtilization'],
  ['gen_ai.gpu.power.limit', 'powerLimitW'],
  ['gen_ai.gpu.clock.sm', 'smClockMHz'],
  ['gen_ai.gpu.clock.memory', 'memoryClockMHz'],
  ['gen_ai.gpu.fan.speed', 'fanSpeed'],
  ['gen_ai.gpu.performance.state', 'performanceState'],
  ['gen_ai.gpu.pcie.tx', 'pcieTxKBs'],
  ['gen_ai.gpu.pcie.rx', 'pcieRxKBs'],
  ['gen_ai.gpu.throttle.thermal', 'throttleThermal'],
  ['gen_ai.gpu.throttle.power', 'throttlePower'],
  ['gen_ai.gpu.throttle.hw_slowdown', 'throttleHwSlowdown'],
  ['gen_ai.gpu.ecc.errors.corrected', 'eccCorrected'],
  ['gen_ai.gpu.ecc.errors.uncorrected', 'eccUncorrected'],
];

const JOULES_PER_KWH = 3_600_000;

export interface GpuCollectorOptions {
  /** Seconds between samples. Default: `GENAI_GPU_COLLECTION_INTERVAL`. */
  intervalSeconds?: number;
  /** Consecutive failed samples after which collection stops. Default 5. */
  maxConsecutiveFailures?: number;
  /** Seconds since any fixed point; for tests. */
  now?: () => number;
}

interface Timed {
  at: number;
  devices: GpuSample[];
}

export class GpuMetricsCollector {
  private readonly intervalMs: number;
  private readonly maxFailures: number;
  private readonly now: () => number;
  private latest: GpuSample[] | undefined;
  private previous: Timed | undefined;
  private failures = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private energy: Counter | undefined;
  private energyTotal: Counter | undefined;
  private cost: Counter | undefined;
  private co2: Counter | undefined;
  private co2Rate: Histogram | undefined;
  private power: Histogram | undefined;

  constructor(
    private readonly config: OTelConfig,
    private readonly source: GpuSource,
    options: GpuCollectorOptions = {},
  ) {
    this.intervalMs = Math.max(1, (options.intervalSeconds ?? config.gpuCollectionInterval) * 1000);
    this.maxFailures = options.maxConsecutiveFailures ?? 5;
    this.now = options.now ?? ((): number => Date.now() / 1000);
  }

  get running(): boolean {
    return this.started;
  }

  /** Whether the gauges have a current sample to observe. */
  get observing(): boolean {
    return this.latest !== undefined;
  }

  /**
   * Take the first sample and, if there is a GPU, create the instruments and
   * start polling. Resolves to whether collection started. Never rejects.
   */
  async start(): Promise<boolean> {
    if (this.started) return true;
    let devices: GpuSample[] | undefined;
    try {
      devices = await this.source.sample();
    } catch (error) {
      logger.warn(`GPU metrics are not collected: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!devices || devices.length === 0) {
      logger.info('No GPU found on this host: GPU, energy and CO2 metrics are not collected');
      return false;
    }
    this.createInstruments(metrics.getMeter(GPU_METER_NAME));
    this.latest = devices;
    this.previous = { at: this.now(), devices };
    this.started = true;
    this.timer = setInterval(() => void this.collect(), this.intervalMs);
    // Collection must not keep a finished application alive.
    (this.timer as { unref?: () => void }).unref?.();
    logger.info(`GPU metrics collection started: ${devices.length} device(s), interval ${this.intervalMs / 1000}s`);
    return true;
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    this.latest = undefined;
    this.previous = undefined;
  }

  /** One sample. Never rejects. */
  async collect(): Promise<void> {
    if (!this.started) return;
    let devices: GpuSample[] | undefined;
    try {
      devices = await this.source.sample();
      if (!devices || devices.length === 0) throw new Error('no device reported');
    } catch (error) {
      // Nothing is known about now: the gauges go quiet and the next interval is not integrated.
      this.latest = undefined;
      this.previous = undefined;
      this.failures += 1;
      logger.debug(`GPU sample failed (${this.failures}): ${String(error)}`);
      if (this.failures >= this.maxFailures) {
        logger.warn(`GPU metrics collection stopped after ${this.failures} consecutive failures: ${error instanceof Error ? error.message : String(error)}`);
        this.stop();
      }
      return;
    }
    if (!this.started) return;
    this.failures = 0;
    const at = this.now();
    try {
      if (this.previous) this.integrate(this.previous, { at, devices });
    } catch (error) {
      logger.debug(`Could not record GPU energy: ${String(error)}`);
    }
    this.latest = devices;
    this.previous = { at, devices };
  }

  /** Energy over one interval: for each device with a power reading at both ends, mean power times elapsed time. */
  private integrate(before: Timed, after: Timed): void {
    const seconds = after.at - before.at;
    if (!(seconds > 0)) return;
    let total = 0;
    for (const device of after.devices) {
      const earlier = before.devices.find((candidate) => candidate.index === device.index);
      if (device.powerW === undefined || earlier?.powerW === undefined) continue;
      const kwh = (((device.powerW + earlier.powerW) / 2) * seconds) / JOULES_PER_KWH;
      const identity = { gpu_id: String(device.index), gpu_name: device.name };
      this.power?.record(device.powerW, { component: 'gpu', ...identity });
      if (!(kwh > 0)) continue;
      total += kwh;
      this.energy?.add(kwh, { component: 'gpu', ...identity });
      this.cost?.add(kwh * this.config.powerCostPerKwh, identity);
      if (this.config.enableCo2Tracking) {
        // Energy times the configured intensity: a factor, not a reading of the grid.
        const grams = kwh * this.config.carbonIntensity;
        this.co2?.add(grams, { gpu_id: identity.gpu_id });
        this.co2Rate?.record(grams / seconds, { gpu_id: identity.gpu_id });
      }
    }
    if (total > 0) this.energyTotal?.add(total);
  }

  private createInstruments(meter: Meter): void {
    const gauge = (name: MetricName, observe: (result: ObservableResult, devices: GpuSample[]) => void): void => {
      const definition = METRIC_DEFINITIONS[name];
      meter.createObservableGauge(definition.name, { description: definition.description, ...(definition.unit ? { unit: definition.unit } : {}) }).addCallback((result) => {
        if (this.latest) observe(result, this.latest);
      });
    };
    for (const [name, field] of PER_DEVICE) {
      gauge(name, (result, devices) => {
        for (const device of devices) {
          const value = device[field];
          if (typeof value === 'number') result.observe(value, { gpu_id: String(device.index), gpu_name: device.name });
        }
      });
    }
    const aggregate = (name: MetricName, field: keyof GpuSample, combine: (values: number[]) => number): void => {
      gauge(name, (result, devices) => {
        const values = devices.map((device) => device[field]).filter((value): value is number => typeof value === 'number');
        if (values.length > 0) result.observe(combine(values), { gpu_count: String(values.length) });
      });
    };
    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
    aggregate('gen_ai.gpu.aggregate.mean_utilization', 'utilization', (values) => sum(values) / values.length);
    aggregate('gen_ai.gpu.aggregate.total_memory_used', 'memoryUsedMiB', (values) => sum(values) / 1024);
    aggregate('gen_ai.gpu.aggregate.total_power', 'powerW', sum);
    aggregate('gen_ai.gpu.aggregate.max_temperature', 'temperatureC', (values) => Math.max(...values));

    this.energy = createCounter(meter, 'gen_ai.energy.consumed');
    this.energyTotal = createCounter(meter, 'gen_ai.energy.total');
    this.cost = createCounter(meter, 'gen_ai.power.cost');
    this.power = createHistogram(meter, 'gen_ai.power.consumption');
    if (this.config.enableCo2Tracking) {
      this.co2 = createCounter(meter, 'gen_ai.co2.emissions');
      this.co2Rate = createHistogram(meter, 'gen_ai.co2.emissions_rate');
    }
  }
}

// --- where the readings come from, per runtime ----------------------------------------

export type GpuSourceFactory = () => GpuSource | undefined;

/**
 * Replace where GPU readings come from. `undefined` restores the runtime's
 * own (on Node, `nvidia-smi`); a factory returning `undefined` means "none".
 */
export function setGpuSource(factory: GpuSourceFactory | undefined): void {
  stateSlot<{ factory?: GpuSourceFactory }>('gpu.source', () => ({})).factory = factory;
}

export function gpuSourceFactory(): GpuSourceFactory | undefined {
  return stateSlot<{ factory?: GpuSourceFactory }>('gpu.source', () => ({})).factory;
}
