/**
 * WebGPU: what the browser will say about the adapter a model runs on.
 *
 * Vendor, architecture, whether it is the software fallback adapter, features
 * and a few limits that decide which models fit. That is all a browser
 * exposes: there is no utilisation, temperature, power or energy reading, so
 * none is reported - those attributes are absent here, never zero.
 */
import { metrics, type AttributeValue } from '@opentelemetry/api';
import { logger } from './logger';
import { clearStateSlot, globalState } from './state';

export type WebGpuFacts = Record<string, AttributeValue>;

/** The part of `navigator.gpu` that is used. */
export interface GpuLike {
  requestAdapter(options?: unknown): Promise<unknown>;
}

const FACTS_SLOT = 'webgpu.facts';
const METER_NAME = 'genai_otel.webgpu';
/** JS-only: the Python library has no browser to lose a device in. */
export const WEBGPU_DEVICE_LOST_METRIC = 'webgpu.device.lost';

const LIMITS: readonly (readonly [string, string])[] = [
  ['maxBufferSize', 'webgpu.limits.max_buffer_size'],
  ['maxStorageBufferBindingSize', 'webgpu.limits.max_storage_buffer_binding_size'],
  ['maxTextureDimension2D', 'webgpu.limits.max_texture_dimension_2d'],
  ['maxComputeWorkgroupStorageSize', 'webgpu.limits.max_compute_workgroup_storage_size'],
];

function unavailable(reason: string): WebGpuFacts {
  return { 'webgpu.available': false, 'webgpu.unavailable_reason': reason };
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/**
 * Ask the browser for its WebGPU adapter and describe it. Never throws; when
 * there is no WebGPU it says so and why. `gpu` defaults to `navigator.gpu`.
 */
export async function collectWebGpuFacts(gpu?: GpuLike): Promise<WebGpuFacts> {
  const source = arguments.length > 0 ? gpu : (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu;
  if (!source || typeof source.requestAdapter !== 'function') return unavailable('navigator.gpu is not present');

  let adapter: unknown;
  try {
    adapter = await source.requestAdapter();
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  if (!isObject(adapter)) return unavailable('no adapter was returned');

  const facts: WebGpuFacts = { 'webgpu.available': true };
  let info: unknown = adapter.info;
  if (!isObject(info) && typeof adapter.requestAdapterInfo === 'function') {
    try {
      // Older browsers expose the adapter description through this call.
      info = await (adapter.requestAdapterInfo as () => Promise<unknown>)();
    } catch {
      info = undefined;
    }
  }
  if (isObject(info)) {
    for (const key of ['vendor', 'architecture', 'device', 'description']) {
      // A browser may blank these for privacy: an empty string is "not told", and is left off.
      if (typeof info[key] === 'string' && info[key]) facts[`webgpu.adapter.${key}`] = info[key];
    }
  }
  const fallback = adapter.isFallbackAdapter ?? (isObject(info) ? info.isFallbackAdapter : undefined);
  if (typeof fallback === 'boolean') facts['webgpu.adapter.is_fallback'] = fallback;

  const features = adapter.features as Iterable<unknown> | undefined;
  if (features && typeof features[Symbol.iterator] === 'function') {
    const names = [...features].map(String).sort();
    if (names.length > 0) facts['webgpu.features'] = names;
  }
  if (isObject(adapter.limits)) {
    for (const [limit, attribute] of LIMITS) {
      const value = adapter.limits[limit];
      if (typeof value === 'number') facts[attribute] = value;
    }
  }
  return facts;
}

/**
 * Collect the facts once and keep them: model-load spans carry them from then
 * on. Resolves to what was collected.
 */
export async function enableWebGpuFacts(gpu?: GpuLike): Promise<WebGpuFacts> {
  const facts = arguments.length > 0 ? await collectWebGpuFacts(gpu) : await collectWebGpuFacts();
  globalState()[FACTS_SLOT] = facts;
  return facts;
}

/** The facts last collected by `enableWebGpuFacts()`, or none. */
export function webGpuFacts(): WebGpuFacts {
  return { ...(globalState()[FACTS_SLOT] as WebGpuFacts | undefined) };
}

export function clearWebGpuFacts(): void {
  clearStateSlot(FACTS_SLOT);
}

export interface GpuDeviceLostInfo {
  reason?: string;
  message?: string;
}

/**
 * Watch a `GPUDevice` for loss - a driver reset, the tab being backgrounded on
 * a phone, memory pressure. When it happens the loss is counted
 * (`webgpu.device.lost`, by reason) and logged. Resolves with what the browser
 * said when the device is lost; never rejects.
 */
export function watchWebGpuDevice(device: { lost: PromiseLike<GpuDeviceLostInfo> }, labels: { model?: string } = {}): Promise<GpuDeviceLostInfo> {
  return Promise.resolve(device.lost).then(
    (info) => {
      const reason = info?.reason || 'unknown';
      try {
        metrics
          .getMeter(METER_NAME)
          .createCounter(WEBGPU_DEVICE_LOST_METRIC, { description: 'WebGPU devices lost while in use' })
          .add(1, labels.model ? { reason, model: labels.model } : { reason });
      } catch {
        // metrics must never break the page
      }
      logger.warn(`WebGPU device lost (${reason})${info?.message ? `: ${info.message}` : ''}`);
      return info ?? {};
    },
    (error: unknown) => {
      logger.debug(`Could not watch the WebGPU device: ${String(error)}`);
      return {};
    },
  );
}
