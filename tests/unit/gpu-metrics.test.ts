/**
 * GPU metrics from `nvidia-smi`, and energy, cost and CO2 from measured power.
 *
 * `tests/fixtures/nvidia-smi/rtx5090-laptop.*.csv` is the real output of
 * `nvidia-smi` on the machine this was written on (driver 592.02), `[N/A]`
 * fields included. `two-gpus.synthetic.csv` is hand-written in the same
 * format, to have more than one device.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuMetricsCollector, type GpuSample, type GpuSource } from '../../src/gpu/collector';
import { FULL_FIELDS, CORE_FIELDS, NvidiaSmiSource, parseNvidiaSmi, type RunCommand } from '../../src/gpu/nvidia-smi';
import { setGpuSource } from '../../src/gpu/collector';
import { loadConfig } from '../../src/config';
import { setLogger } from '../../src/logger';
import { startHarness, type Harness } from '../helpers/harness';

const fixture = (name: string): string => readFileSync(resolve(__dirname, '../fixtures/nvidia-smi', name), 'utf8');

let harness: Harness | undefined;
const collectors: GpuMetricsCollector[] = [];

afterEach(async () => {
  for (const collector of collectors.splice(0)) collector.stop();
  setGpuSource(() => undefined);
  await harness?.stop();
  harness = undefined;
  setLogger(undefined);
});

function quietLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; lines: () => string } {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  setLogger(log);
  return { info: log.info, warn: log.warn, lines: () => [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(([m]) => String(m)).join('\n') };
}

const points = async (name: string): Promise<{ attributes: Record<string, unknown>; value: number }[] | undefined> =>
  (await harness?.metric(name))?.points.map((point) => ({ attributes: point.attributes, value: point.value }));

/** A source that plays back the given samples, one per poll; the last one repeats. */
function playback(...samples: (GpuSample[] | undefined | Error)[]): GpuSource & { polls: number } {
  const source = {
    polls: 0,
    async sample(): Promise<GpuSample[] | undefined> {
      const next = samples[Math.min(source.polls, samples.length - 1)];
      source.polls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return source;
}

const gpu = (overrides: Partial<GpuSample> = {}): GpuSample => ({ index: 0, name: 'Test GPU', ...overrides });

describe('parseNvidiaSmi', () => {
  it('the real output of this machine: values as reported, [N/A] as absent', () => {
    expect(parseNvidiaSmi(fixture('rtx5090-laptop.full.csv'), FULL_FIELDS)).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 5090 Laptop GPU',
        utilization: 0,
        memoryUtilization: 0,
        memoryUsedMiB: 15075,
        memoryTotalMiB: 24463,
        temperatureC: 59,
        powerW: 10.43,
        smClockMHz: 180,
        memoryClockMHz: 405,
        performanceState: 8,
        throttleThermal: 0,
        throttlePower: 0,
        throttleHwSlowdown: 0,
      },
    ]);
    expect(parseNvidiaSmi(fixture('rtx5090-laptop.core.csv'), CORE_FIELDS)).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 5090 Laptop GPU', utilization: 0, memoryUsedMiB: 15075, memoryTotalMiB: 24463, temperatureC: 59, powerW: 10.43 },
    ]);
  });

  it('two devices; throttle flags, P-states and ECC counts', () => {
    const [first, second] = parseNvidiaSmi(fixture('two-gpus.synthetic.csv'), FULL_FIELDS);
    expect(first).toMatchObject({ index: 0, utilization: 87, powerW: 289.5, powerLimitW: 400, performanceState: 0, throttlePower: 1, throttleThermal: 0, eccCorrected: 0, eccUncorrected: 0 });
    expect(second).toMatchObject({ index: 1, name: 'NVIDIA A100-SXM4-80GB', throttleThermal: 1, performanceState: 8, eccCorrected: 3 });
    expect(second && 'eccUncorrected' in second).toBe(false);
    expect(second && 'fanSpeed' in second).toBe(false);
  });

  it('lines that are not device rows are ignored', () => {
    expect(parseNvidiaSmi('\r\n\nNo devices were found\n', CORE_FIELDS)).toEqual([]);
    expect(parseNvidiaSmi('x, GPU, 1, 2, 3, 4, 5\n', CORE_FIELDS)).toEqual([]);
    expect(parseNvidiaSmi('0, GPU, [Not Supported], abc, , 4, 5\n', CORE_FIELDS)).toEqual([{ index: 0, name: 'GPU', temperatureC: 4, powerW: 5 }]);
  });
});

describe('NvidiaSmiSource', () => {
  it('asks for every field; a driver that does not know one is asked for the core set from then on', async () => {
    const commands: string[][] = [];
    const run: RunCommand = async (command, args) => {
      commands.push([command, ...args]);
      if (args[0]?.includes('pstate')) throw Object.assign(new Error('exit code 2'), { stdout: 'Field "pstate" is not a valid field to query.\n' });
      return fixture('rtx5090-laptop.core.csv');
    };
    const source = new NvidiaSmiSource(run);
    expect(await source.sample()).toHaveLength(1);
    expect(await source.sample()).toHaveLength(1);
    expect(commands.map(([command]) => command)).toEqual(['nvidia-smi', 'nvidia-smi', 'nvidia-smi']);
    expect(commands[0]?.[1]).toBe(`--query-gpu=${FULL_FIELDS.map((field) => field.query).join(',')}`);
    expect(commands[0]?.[2]).toBe('--format=csv,noheader,nounits');
    expect(commands[1]?.[1]).toBe(`--query-gpu=${CORE_FIELDS.map((field) => field.query).join(',')}`);
    // The third call did not try the full set again.
    expect(commands[2]?.[1]).toBe(commands[1]?.[1]);
  });

  it('no nvidia-smi on the host: unavailable, and not asked again', async () => {
    let calls = 0;
    const source = new NvidiaSmiSource(async () => {
      calls += 1;
      throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    });
    expect(await source.sample()).toBeUndefined();
    expect(await source.sample()).toBeUndefined();
    expect(calls).toBe(1);
    expect(source.unavailable).toBe(true);
  });

  it('nvidia-smi present but failing: the failure reaches the collector', async () => {
    const source = new NvidiaSmiSource(async () => {
      throw Object.assign(new Error('exit code 9'), { stdout: 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.' });
    });
    await expect(source.sample()).rejects.toThrow('could not communicate');
    expect(source.unavailable).toBe(false);
  });

  it('VRAM of the first device, in GB', async () => {
    const source = new NvidiaSmiSource(async () => fixture('rtx5090-laptop.full.csv'));
    expect(await source.firstDeviceVramGb()).toBeCloseTo(24463 / 1024, 6);
    expect(await new NvidiaSmiSource(async () => '').firstDeviceVramGb()).toBeUndefined();
  });
});

describe('GpuMetricsCollector', () => {
  const config = (overrides: Record<string, unknown> = {}): ReturnType<typeof loadConfig> => loadConfig({ gpuCollectionInterval: 1, ...overrides } as never, {});

  it('a host with no GPU: no instrument is created, and one line says so', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const log = quietLogger();
    const source = playback(undefined);
    const collector = new GpuMetricsCollector(config(), source);
    collectors.push(collector);
    expect(await collector.start()).toBe(false);
    expect(collector.running).toBe(false);
    for (const name of ['gen_ai.gpu.utilization', 'gen_ai.gpu.power', 'gen_ai.gpu.aggregate.total_power', 'gen_ai.power.cost']) expect(await points(name), name).toBeUndefined();
    expect(log.lines().match(/No GPU/g)).toHaveLength(1);

    const empty = new GpuMetricsCollector(config(), playback([]));
    collectors.push(empty);
    expect(await empty.start()).toBe(false);
  });

  it('nvidia-smi failing at start: no instrument, one warning, no retry loop', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const log = quietLogger();
    const source = playback(new Error('could not communicate with the NVIDIA driver'));
    const collector = new GpuMetricsCollector(config(), source);
    collectors.push(collector);
    expect(await collector.start()).toBe(false);
    await new Promise((done) => setTimeout(done, 80));
    expect(source.polls).toBe(1);
    expect(log.warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain('could not communicate');
    expect(await points('gen_ai.gpu.utilization')).toBeUndefined();
  });

  it('per-device gauges carry what was measured; a field the device does not report is absent, not zero', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const collector = new GpuMetricsCollector(config(), playback(parseNvidiaSmi(fixture('rtx5090-laptop.full.csv'), FULL_FIELDS)));
    collectors.push(collector);
    expect(await collector.start()).toBe(true);
    const attributes = { gpu_id: '0', gpu_name: 'NVIDIA GeForce RTX 5090 Laptop GPU' };
    expect(await points('gen_ai.gpu.utilization')).toEqual([{ attributes, value: 0 }]);
    expect(await points('gen_ai.gpu.memory.used')).toEqual([{ attributes, value: 15075 }]);
    expect(await points('gen_ai.gpu.memory.total')).toEqual([{ attributes, value: 24463 }]);
    expect(await points('gen_ai.gpu.temperature')).toEqual([{ attributes, value: 59 }]);
    expect(await points('gen_ai.gpu.power')).toEqual([{ attributes, value: 10.43 }]);
    expect(await points('gen_ai.gpu.clock.sm')).toEqual([{ attributes, value: 180 }]);
    expect(await points('gen_ai.gpu.performance.state')).toEqual([{ attributes, value: 8 }]);
    expect(await points('gen_ai.gpu.throttle.thermal')).toEqual([{ attributes, value: 0 }]);
    // Reported as [N/A] by this device.
    for (const name of ['gen_ai.gpu.power.limit', 'gen_ai.gpu.fan.speed', 'gen_ai.gpu.ecc.errors.corrected', 'gen_ai.gpu.ecc.errors.uncorrected']) {
      expect(await points(name), name).toBeUndefined();
    }
    // nvidia-smi has no PCIe throughput field.
    expect(await points('gen_ai.gpu.pcie.tx')).toBeUndefined();
    expect((await harness.metric('gen_ai.gpu.memory.used'))?.unit).toBe('MiB');
    expect((await harness.metric('gen_ai.gpu.utilization'))?.scope).toBe('genai.gpu');
  });

  it('aggregates over the devices that reported the value', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const collector = new GpuMetricsCollector(config(), playback(parseNvidiaSmi(fixture('two-gpus.synthetic.csv'), FULL_FIELDS)));
    collectors.push(collector);
    await collector.start();
    expect(await points('gen_ai.gpu.aggregate.mean_utilization')).toEqual([{ attributes: { gpu_count: '2' }, value: 49.5 }]);
    expect(await points('gen_ai.gpu.aggregate.total_memory_used')).toEqual([{ attributes: { gpu_count: '2' }, value: (61234 + 2048) / 1024 }]);
    expect(await points('gen_ai.gpu.aggregate.total_power')).toEqual([{ attributes: { gpu_count: '2' }, value: 289.5 + 71.25 }]);
    expect(await points('gen_ai.gpu.aggregate.max_temperature')).toEqual([{ attributes: { gpu_count: '2' }, value: 71 }]);
    expect((await points('gen_ai.gpu.ecc.errors.uncorrected'))?.map((point) => point.attributes.gpu_id)).toEqual(['0']);
  });

  it('energy is power integrated over the time between samples; cost and CO2 follow from it', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    let clock = 1000;
    const source = playback([gpu({ powerW: 300 })], [gpu({ powerW: 300 })], [gpu({ powerW: 600 })]);
    const collector = new GpuMetricsCollector(config({ enableCo2Tracking: true, carbonIntensity: 400, powerCostPerKwh: 0.2 }), source, { now: () => clock });
    collectors.push(collector);
    await collector.start(); // the first sample: nothing to integrate yet
    expect(await points('gen_ai.energy.total')).toBeUndefined();

    clock += 10; // 300 W for 10 s = 3000 J = 0.000833... kWh
    await collector.collect();
    const kwh = (300 * 10) / 3_600_000;
    const attributes = { gpu_id: '0', gpu_name: 'Test GPU' };
    expect((await points('gen_ai.energy.consumed'))?.[0]).toEqual({ attributes: { component: 'gpu', ...attributes }, value: kwh });
    expect((await points('gen_ai.energy.total'))?.[0]?.value).toBeCloseTo(kwh, 12);
    expect((await points('gen_ai.power.cost'))?.[0]).toEqual({ attributes, value: kwh * 0.2 });
    expect((await points('gen_ai.co2.emissions'))?.[0]).toEqual({ attributes: { gpu_id: '0' }, value: kwh * 400 });

    clock += 20; // the power over the interval is the mean of its two ends: 450 W for 20 s
    await collector.collect();
    const more = (450 * 20) / 3_600_000;
    expect((await points('gen_ai.energy.total'))?.[0]?.value).toBeCloseTo(kwh + more, 12);
    expect((await harness.metric('gen_ai.power.consumption'))?.kind).toBe('histogram');
  });

  it('CO2 is not reported unless CO2 tracking is on; a device with no power reading has no energy', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    let clock = 0;
    const collector = new GpuMetricsCollector(config(), playback([gpu({ powerW: 100 }), gpu({ index: 1 })]), { now: () => clock });
    collectors.push(collector);
    await collector.start();
    clock += 36;
    await collector.collect();
    expect(await points('gen_ai.co2.emissions')).toBeUndefined();
    expect((await points('gen_ai.energy.consumed'))?.map((point) => point.attributes.gpu_id)).toEqual(['0']);
    expect((await points('gen_ai.power.cost'))?.[0]?.value).toBeCloseTo(0.001 * 0.12, 12);
  });

  it('a gap in the samples is not integrated across', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    let clock = 0;
    const source = playback([gpu({ powerW: 100 })], new Error('transient'), [gpu({ powerW: 100 })], [gpu({ powerW: 100 })]);
    const collector = new GpuMetricsCollector(config(), source, { now: () => clock });
    collectors.push(collector);
    await collector.start();
    clock += 3600;
    await collector.collect(); // failed
    clock += 3600;
    await collector.collect(); // back, but nothing is known about the two hours before
    expect(await points('gen_ai.energy.total')).toBeUndefined();
    clock += 36;
    await collector.collect();
    expect((await points('gen_ai.energy.total'))?.[0]?.value).toBeCloseTo(0.001, 12);
  });

  it('repeated failures stop the collection, with one warning', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const log = quietLogger();
    const source = playback([gpu({ utilization: 50 })], new Error('driver gone'));
    const collector = new GpuMetricsCollector(config(), source, { maxConsecutiveFailures: 3 });
    collectors.push(collector);
    await collector.start();
    expect(await points('gen_ai.gpu.utilization')).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) await collector.collect();
    expect(collector.running).toBe(false);
    expect(source.polls).toBe(4);
    expect(log.warn.mock.calls.filter(([m]) => String(m).includes('stopped'))).toHaveLength(1);
    // The collector observes nothing any more. The metrics SDK keeps exporting the
    // last value it was given for a gauge (cumulative temporality); that is the
    // SDK's, and is documented rather than hidden.
    expect(collector.observing).toBe(false);
  });

  it('polls on the configured interval until stopped', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const source = playback([gpu({ utilization: 1 })]);
    const collector = new GpuMetricsCollector(config(), source, { intervalSeconds: 0.03 });
    collectors.push(collector);
    await collector.start();
    await new Promise((done) => setTimeout(done, 150));
    expect(source.polls).toBeGreaterThanOrEqual(3);
    collector.stop();
    const after = source.polls;
    await new Promise((done) => setTimeout(done, 100));
    expect(source.polls).toBeLessThanOrEqual(after + 1);
  });
});

describe('instrument()', () => {
  it('GENAI_ENABLE_GPU_METRICS: collects from the source of the runtime, and stops with uninstrument()', async () => {
    const source = playback(parseNvidiaSmi(fixture('rtx5090-laptop.full.csv'), FULL_FIELDS));
    setGpuSource(() => source);
    harness = await startHarness({ enabledInstrumentors: [], enableGpuMetrics: true, gpuCollectionInterval: 1 });
    await vi.waitFor(async () => expect(await points('gen_ai.gpu.temperature')).toEqual([{ attributes: { gpu_id: '0', gpu_name: 'NVIDIA GeForce RTX 5090 Laptop GPU' }, value: 59 }]));
  });

  it('switched off: the source is never asked', async () => {
    const source = playback([gpu()]);
    setGpuSource(() => source);
    harness = await startHarness({ enabledInstrumentors: [], enableGpuMetrics: false });
    await new Promise((done) => setTimeout(done, 50));
    expect(source.polls).toBe(0);
  });
});
