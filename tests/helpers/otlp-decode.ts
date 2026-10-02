/**
 * A minimal protobuf reader for OTLP trace and metric export requests.
 *
 * Tests decode what the real OTLP http/protobuf exporter put on the wire,
 * instead of trusting an in-memory exporter, so a wire-format problem shows up
 * here. Only the fields the tests assert on are understood.
 */
type Field = { number: number; wire: number; value: bigint | Uint8Array | number };

function readFields(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[offset];
      if (byte === undefined) throw new Error('truncated varint');
      offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (offset < bytes.length) {
    const tag = Number(varint());
    const number = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) fields.push({ number, wire, value: varint() });
    else if (wire === 1) {
      fields.push({ number, wire, value: view.getFloat64(offset, true) });
      offset += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      fields.push({ number, wire, value: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      fields.push({ number, wire, value: view.getFloat32(offset, true) });
      offset += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const text = (value: Field['value']): string => new TextDecoder().decode(value as Uint8Array);
const sub = (fields: Field[], number: number): Uint8Array[] =>
  fields.filter((field) => field.number === number && field.wire === 2).map((field) => field.value as Uint8Array);

export type AttributeValue = string | number | boolean | AttributeValue[];

function anyValue(bytes: Uint8Array): AttributeValue {
  const [field] = readFields(bytes);
  if (!field) return '';
  switch (field.number) {
    case 1:
      return text(field.value);
    case 2:
      return field.value !== 0n;
    case 3:
      return Number(BigInt.asIntN(64, field.value as bigint));
    case 4:
      return field.value as number;
    case 5:
      return sub(readFields(field.value as Uint8Array), 1).map(anyValue);
    default:
      return `<unsupported any-value field ${field.number}>`;
  }
}

function attributes(list: Uint8Array[]): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const entry of list) {
    const fields = readFields(entry);
    const key = fields.find((field) => field.number === 1);
    const value = fields.find((field) => field.number === 2);
    if (key) out[text(key.value)] = value ? anyValue(value.value as Uint8Array) : '';
  }
  return out;
}

export interface DecodedSpan {
  name: string;
  /** Hex. `parentSpanId` is empty for a root span. */
  spanId: string;
  parentSpanId: string;
  /** 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
  kind: number;
  attributes: Record<string, AttributeValue>;
  /** 0 unset, 1 ok, 2 error. */
  statusCode: number;
  statusMessage: string;
  resource: Record<string, AttributeValue>;
  events: { name: string; attributes: Record<string, AttributeValue> }[];
}

/** Decode an ExportTraceServiceRequest. */
export function decodeTraceRequest(body: Uint8Array): DecodedSpan[] {
  const spans: DecodedSpan[] = [];
  for (const resourceSpans of sub(readFields(body), 1)) {
    const rsFields = readFields(resourceSpans);
    const resourceBytes = sub(rsFields, 1)[0];
    const resource = resourceBytes ? attributes(sub(readFields(resourceBytes), 1)) : {};
    for (const scopeSpans of sub(rsFields, 2)) {
      for (const spanBytes of sub(readFields(scopeSpans), 2)) {
        const fields = readFields(spanBytes);
        const name = fields.find((field) => field.number === 5);
        const kind = fields.find((field) => field.number === 6);
        const statusBytes = sub(fields, 15)[0];
        const status = statusBytes ? readFields(statusBytes) : [];
        const code = status.find((field) => field.number === 3);
        const message = status.find((field) => field.number === 2);
        spans.push({
          name: name ? text(name.value) : '',
          spanId: Buffer.from(sub(fields, 2)[0] ?? new Uint8Array()).toString('hex'),
          parentSpanId: Buffer.from(sub(fields, 4)[0] ?? new Uint8Array()).toString('hex'),
          kind: kind ? Number(kind.value) : 0,
          attributes: attributes(sub(fields, 9)),
          statusCode: code ? Number(code.value) : 0,
          statusMessage: message ? text(message.value) : '',
          resource,
          events: sub(fields, 11).map((eventBytes) => {
            const eventFields = readFields(eventBytes);
            const eventName = eventFields.find((field) => field.number === 2);
            return { name: eventName ? text(eventName.value) : '', attributes: attributes(sub(eventFields, 3)) };
          }),
        });
      }
    }
  }
  return spans;
}

export interface DecodedMetric {
  name: string;
  unit: string;
  description: string;
  kind: 'gauge' | 'sum' | 'histogram' | 'exponential_histogram' | 'summary' | 'unknown';
}

const METRIC_KINDS: Record<number, DecodedMetric['kind']> = {
  5: 'gauge',
  7: 'sum',
  9: 'histogram',
  10: 'exponential_histogram',
  11: 'summary',
};

/** Decode the metric descriptors of an ExportMetricsServiceRequest. */
export function decodeMetricsRequest(body: Uint8Array): DecodedMetric[] {
  const metrics: DecodedMetric[] = [];
  for (const resourceMetrics of sub(readFields(body), 1)) {
    for (const scopeMetrics of sub(readFields(resourceMetrics), 2)) {
      for (const metricBytes of sub(readFields(scopeMetrics), 2)) {
        const fields = readFields(metricBytes);
        const pick = (number: number): string => {
          const field = fields.find((candidate) => candidate.number === number);
          return field ? text(field.value) : '';
        };
        const data = fields.find((field) => METRIC_KINDS[field.number] !== undefined);
        metrics.push({
          name: pick(1),
          description: pick(2),
          unit: pick(3),
          kind: data ? (METRIC_KINDS[data.number] ?? 'unknown') : 'unknown',
        });
      }
    }
  }
  return metrics;
}
