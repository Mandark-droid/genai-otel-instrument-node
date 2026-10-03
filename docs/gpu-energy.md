# GPU, energy and CO2 metrics

Node only. The browser and React Native entries report no GPU, energy or CO2 metric:
WebGPU exposes no utilisation or power, and the device's own counters are not reachable.

## What is measured, and how

`nvidia-smi --query-gpu=... --format=csv,noheader,nounits` is run every
`GENAI_GPU_COLLECTION_INTERVAL` seconds (default 5), off the request path, with a
10-second timeout. One line per device. The gauges report the latest sample.
`flushTelemetry()` waits for the first sample, so a run shorter than one `nvidia-smi` call
still exports a GPU reading.

The timeout is the SDK's own, not `execFile`'s. `execFile`'s timeout is a timer: when the
application blocks the event loop past it while `nvidia-smi` runs - an ES-module application
evaluating its modules right after `instrument()` - the timer fires before the child's exit
and output are read, the finished child is "killed", and its output is lost with no error.
Up to 0.1.0-dev that read as "no GPU on this host", logged at info level, and the process
reported no GPU telemetry at all. Here a timer that fires defers to after pending I/O, and
a child that has exited is never killed.

| Metric | Unit | From |
|---|---|---|
| `gen_ai.gpu.utilization`, `gen_ai.gpu.memory.utilization` | % | `utilization.gpu`, `utilization.memory` |
| `gen_ai.gpu.memory.used`, `gen_ai.gpu.memory.total` | MiB | `memory.used`, `memory.total` |
| `gen_ai.gpu.temperature` | Cel | `temperature.gpu` |
| `gen_ai.gpu.power`, `gen_ai.gpu.power.limit` | W | `power.draw`, `power.limit` |
| `gen_ai.gpu.clock.sm`, `gen_ai.gpu.clock.memory` | MHz | `clocks.current.sm`, `clocks.current.memory` |
| `gen_ai.gpu.fan.speed` | % | `fan.speed` |
| `gen_ai.gpu.performance.state` | 0 to 15 | `pstate` |
| `gen_ai.gpu.throttle.thermal`, `.power`, `.hw_slowdown` | 1 or 0 | `clocks_throttle_reasons.*` |
| `gen_ai.gpu.ecc.errors.corrected`, `.uncorrected` | count | `ecc.errors.*.volatile.total` |
| `gen_ai.gpu.aggregate.mean_utilization`, `.total_memory_used` (GiB), `.total_power`, `.max_temperature` | | over the devices that reported the value; `gpu_count` says how many |

Per-device points carry `gpu_id` and `gpu_name`.

From power, between two samples:

| Metric | |
|---|---|
| `gen_ai.energy.consumed` (`component = gpu`), `gen_ai.energy.total` | kWh: mean power of the interval's two ends, times its length |
| `gen_ai.power.consumption` | W, a histogram of the readings |
| `gen_ai.power.cost` | USD: that energy times `GENAI_POWER_COST_PER_KWH` |
| `gen_ai.co2.emissions`, `gen_ai.co2.emissions_rate` | gCO2e, gCO2e/s: that energy times `GENAI_CARBON_INTENSITY`. Only with `GENAI_ENABLE_CO2_TRACKING=true` |

## What is not measured is not reported

| Situation | What happens |
|---|---|
| No `nvidia-smi` on the host | No GPU instrument is created. One line at info level. Not asked again |
| `nvidia-smi` answers "No devices were found" | As a host with no GPU: no instrument, one line at info level |
| `nvidia-smi` present and failing at start (no driver, a timeout, no output at all) | No instrument yet. One warning with what the tool said; the first sample is tried again every interval, and after 5 failures in a row one more warning and no further attempt. An empty answer is a failure, never "no GPU" |
| A field the device reports as `[N/A]` (on a laptop GPU: power limit, fan speed, ECC) | That gauge has no point for that device. The others do |
| An older driver that does not know one of the fields | The core set (utilisation, memory, temperature, power) is used from then on |
| The tool starts failing later | Nothing is observed for that sample, and the energy of the gap is not integrated. After 5 failed samples in a row collection stops, with one warning |
| A device with no power reading | No energy, cost or CO2 for it |
| CPU and RAM energy | Not measured, so not reported. `gen_ai.energy.total` is GPU energy only, and says nothing else |

A collector that stopped shows as a gap, not as a flat line: the exporter asks the
metrics SDK for delta temporality for gauges (`src/gauge-temporality.ts`), so a gauge
nobody observes any more is not exported. Under the SDK's default cumulative temporality
it would go on exporting its last value. A gauge has no temporality on the wire, so nothing
else changes.

## CO2 is a factor, not a reading of the grid

`gen_ai.co2.emissions` is measured energy multiplied by one number,
`GENAI_CARBON_INTENSITY`, in gCO2e per kWh. Its default, 475, is a world average and is
the reference implementation's default. It is not the intensity of the grid the host is
on. Set it to that grid's figure, or treat the metric as an order of magnitude.

The reference uses codecarbon, which carries regional grid data and also measures CPU and
RAM. None of that exists here. The `GENAI_CO2_*` location and mode variables are accepted
and have no effect; setting one says so in the log at start-up.

## Differences from the reference

- The reference's own formula for energy from power is 3.6 times too high (it multiplies
  kilowatts by seconds and treats the result as watt-hours); it affects its
  `gen_ai.power.cost` always, and its CO2 when codecarbon is not installed. Here the
  energy is watts times seconds over 3 600 000. Confirmed, SDK_ADDITIONS.md section 9.
- `gen_ai.gpu.pcie.tx` / `.rx` and `gen_ai.codecarbon.task.duration` are never reported.
- AMD GPUs are not read. The reference reads them through the `amdsmi` Python binding;
  the command-line tool's output could not be checked on any machine available here.

## What was run

The parser and the collector are tested against the real output of `nvidia-smi` on one
machine (RTX 5090 Laptop GPU, driver 592.02, Windows), and the real tool was run through
`NvidiaSmiSource` there. A two-device case uses a hand-written fixture in the same
format. Not run: a multi-GPU host, a data-centre GPU, Linux, an older driver.

## Another source of readings

`setGpuSource(() => source)` replaces `nvidia-smi` with anything that implements
`sample(): Promise<GpuSample[] | undefined>` - a vendor tool, an exporter already running
on the host. A factory that returns `undefined` switches GPU reading off.
