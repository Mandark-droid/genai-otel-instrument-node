/**
 * GPU readings from `nvidia-smi`. Node only.
 *
 * There is no NVML binding to depend on, so the tool is run for each sample:
 * `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits`, one line per
 * device. It takes tens of milliseconds and runs off the request path.
 *
 * Not available this way: PCIe throughput, which `--query-gpu` does not offer.
 */
import { execFile } from 'node:child_process';
import type { GpuSample, GpuSource } from './collector';

type NumericField = Exclude<keyof GpuSample, 'index' | 'name'>;

export interface QueryField {
  /** The `--query-gpu` field name. */
  query: string;
  key: keyof GpuSample;
  parse?: (raw: string) => number | undefined;
}

const number = (raw: string): number | undefined => {
  if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) return undefined;
  return Number(raw);
};
/** `Active` / `Not Active`. */
const active = (raw: string): number | undefined => (raw === 'Active' ? 1 : raw === 'Not Active' ? 0 : undefined);
/** `P0` .. `P15`. */
const pstate = (raw: string): number | undefined => {
  const match = /^P(\d+)$/.exec(raw);
  return match ? Number(match[1]) : undefined;
};

/** What every driver that has `nvidia-smi --query-gpu` answers. */
export const CORE_FIELDS: readonly QueryField[] = [
  { query: 'index', key: 'index' },
  { query: 'name', key: 'name' },
  { query: 'utilization.gpu', key: 'utilization' },
  { query: 'memory.used', key: 'memoryUsedMiB' },
  { query: 'memory.total', key: 'memoryTotalMiB' },
  { query: 'temperature.gpu', key: 'temperatureC' },
  { query: 'power.draw', key: 'powerW' },
];

/** Everything this SDK has a metric for. An older driver may not know all of them. */
export const FULL_FIELDS: readonly QueryField[] = [
  { query: 'index', key: 'index' },
  { query: 'name', key: 'name' },
  { query: 'utilization.gpu', key: 'utilization' },
  { query: 'utilization.memory', key: 'memoryUtilization' },
  { query: 'memory.used', key: 'memoryUsedMiB' },
  { query: 'memory.total', key: 'memoryTotalMiB' },
  { query: 'temperature.gpu', key: 'temperatureC' },
  { query: 'power.draw', key: 'powerW' },
  { query: 'power.limit', key: 'powerLimitW' },
  { query: 'clocks.current.sm', key: 'smClockMHz' },
  { query: 'clocks.current.memory', key: 'memoryClockMHz' },
  { query: 'fan.speed', key: 'fanSpeed' },
  { query: 'pstate', key: 'performanceState', parse: pstate },
  { query: 'clocks_throttle_reasons.sw_thermal_slowdown', key: 'throttleThermal', parse: active },
  { query: 'clocks_throttle_reasons.sw_power_cap', key: 'throttlePower', parse: active },
  { query: 'clocks_throttle_reasons.hw_slowdown', key: 'throttleHwSlowdown', parse: active },
  { query: 'ecc.errors.corrected.volatile.total', key: 'eccCorrected' },
  { query: 'ecc.errors.uncorrected.volatile.total', key: 'eccUncorrected' },
];

/**
 * Parse the CSV output for `fields`. A value the device does not report
 * (`[N/A]`, `[Not Supported]`, anything that is not a number) is left out. A
 * line that does not start with a device index is not a device.
 */
export function parseNvidiaSmi(output: string, fields: readonly QueryField[]): GpuSample[] {
  const samples: GpuSample[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < fields.length) continue;
    const indexAt = fields.findIndex((field) => field.key === 'index');
    const nameAt = fields.findIndex((field) => field.key === 'name');
    const index = number(cells[indexAt] ?? '');
    if (index === undefined) continue;
    const sample: GpuSample = { index, name: cells[nameAt] ?? '' };
    fields.forEach((field, at) => {
      if (field.key === 'index' || field.key === 'name') return;
      const value = (field.parse ?? number)(cells[at] ?? '');
      if (value !== undefined) sample[field.key as NumericField] = value;
    });
    samples.push(sample);
  }
  return samples;
}

/** Run a command and resolve to its standard output; reject on a non-zero exit, with `stdout` on the error. */
export type RunCommand = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const runWithExecFile: RunCommand = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });

export class NvidiaSmiSource implements GpuSource {
  private fields: readonly QueryField[] = FULL_FIELDS;
  /** `nvidia-smi` is not on this host. Found out once; not asked again. */
  unavailable = false;

  constructor(
    private readonly run: RunCommand = runWithExecFile,
    private readonly timeoutMs = 5000,
  ) {}

  async sample(): Promise<GpuSample[] | undefined> {
    if (this.unavailable) return undefined;
    try {
      return parseNvidiaSmi(await this.query(this.fields), this.fields);
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
      if (failure.code === 'ENOENT') {
        this.unavailable = true;
        return undefined;
      }
      const said = `${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`.trim();
      // An older driver that does not know one of the fields: the core set from now on.
      if (this.fields !== CORE_FIELDS && /not a valid field/i.test(said)) {
        this.fields = CORE_FIELDS;
        return this.sample();
      }
      throw new Error(`nvidia-smi failed: ${said || String(failure.message ?? error)}`);
    }
  }

  /** VRAM of the first device in GB, or undefined when it cannot be found out. Never rejects. */
  async firstDeviceVramGb(): Promise<number | undefined> {
    try {
      const total = (await this.sample())?.[0]?.memoryTotalMiB;
      return typeof total === 'number' && total > 0 ? total / 1024 : undefined;
    } catch {
      return undefined;
    }
  }

  private query(fields: readonly QueryField[]): Promise<string> {
    return this.run('nvidia-smi', [`--query-gpu=${fields.map((field) => field.query).join(',')}`, '--format=csv,noheader,nounits'], this.timeoutMs);
  }
}
