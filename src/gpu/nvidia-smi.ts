/**
 * GPU readings from `nvidia-smi`. Node only.
 *
 * There is no NVML binding to depend on, so the tool is run for each sample:
 * `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits`, one line per
 * device. It takes tens of milliseconds and runs off the request path.
 *
 * Not available this way: PCIe throughput, which `--query-gpu` does not offer.
 */
import { spawn } from 'node:child_process';
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

const MAX_OUTPUT = 1024 * 1024;

/**
 * Run a vendor tool with a timeout that cannot fire on a child that has
 * already finished.
 *
 * `execFile`'s own timeout is a timer. When the event loop is blocked past it -
 * an application evaluating its modules right after `instrument()` - the timers
 * phase runs before the child's exit and output are read: the finished child is
 * "killed" and its output lost, with no error. That read as a host without a
 * GPU. Here the timer only defers to the end of the loop's turn, after pending
 * I/O, and a child that has exited is left alone.
 */
export const runCommand: RunCommand = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    const timer = setTimeout(() => {
      setImmediate(() => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        settle(() => reject(Object.assign(new Error(`${command} did not finish within ${timeoutMs} ms`), { code: 'ETIMEDOUT', stdout, stderr })));
      });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    child.on('error', (error) => settle(() => reject(Object.assign(error, { stdout, stderr }))));
    child.on('close', (code, signal) => {
      settle(() => {
        if (code === 0) resolve(stdout);
        else reject(Object.assign(new Error(`${command} exited with ${code ?? signal}`), { code: code ?? signal, stdout, stderr }));
      });
    });
  });

export class NvidiaSmiSource implements GpuSource {
  private fields: readonly QueryField[] = FULL_FIELDS;
  /** `nvidia-smi` is not on this host. Found out once; not asked again. */
  unavailable = false;

  constructor(
    private readonly run: RunCommand = runCommand,
    // As the Java SDK: a busy driver can take seconds to answer.
    private readonly timeoutMs = 10_000,
  ) {}

  async sample(): Promise<GpuSample[] | undefined> {
    if (this.unavailable) return undefined;
    let output: string;
    try {
      output = await this.query(this.fields);
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
      // What nvidia-smi says, with a non-zero exit, on a host whose driver sees no GPU.
      if (/no devices were found/i.test(said)) return [];
      throw new Error(`nvidia-smi failed: ${said || String(failure.message ?? error)}`);
    }
    // Success with nothing to read is not "no GPU": nvidia-smi always prints a line per device.
    if (!output.trim()) throw new Error('nvidia-smi exited with no output');
    return parseNvidiaSmi(output, this.fields);
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
