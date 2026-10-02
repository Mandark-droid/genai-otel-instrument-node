/**
 * A cheap estimate of a payload's size in bytes, for the request / response
 * size histograms.
 *
 * A port of `_estimate_payload_size` in
 * `genai_otel/mcp_instrumentors/database_instrumentor.py`. It runs on the hot
 * path of every datastore call, so it never serialises: it samples at most ten
 * elements of a container, two levels deep, and scales by the length.
 */
const SAMPLE_LIMIT = 10;
const MAX_DEPTH = 2;

function isBytes(value: unknown): value is { byteLength: number } {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

export function estimatePayloadSize(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (isBytes(value)) return value.byteLength;
  // Characters, as Python's len(str) counts them.
  if (typeof value === 'string') return value.length;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;

  const isList = Array.isArray(value) || value instanceof Set;
  const isMapping = value instanceof Map || (typeof value === 'object' && !isList);
  if (!isList && !isMapping) return 16;

  const length = Array.isArray(value)
    ? value.length
    : value instanceof Set || value instanceof Map
      ? value.size
      : Object.keys(value as object).length;
  if (depth >= MAX_DEPTH) return length;
  if (length === 0) return 2;

  let total = 0;
  let sampled = 0;
  if (isList) {
    for (const item of value as Iterable<unknown>) {
      total += estimatePayloadSize(item, depth + 1);
      sampled += 1;
      if (sampled >= SAMPLE_LIMIT) break;
    }
  } else {
    const entries = value instanceof Map ? value.entries() : Object.entries(value as object);
    for (const [key, item] of entries) {
      total += estimatePayloadSize(key, depth + 1) + estimatePayloadSize(item, depth + 1);
      sampled += 1;
      if (sampled >= SAMPLE_LIMIT) break;
    }
  }
  return Math.trunc((total / sampled) * length) + 2;
}
