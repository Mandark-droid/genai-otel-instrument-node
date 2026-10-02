/**
 * AWS event-stream framing, for standing in for streamed AWS responses
 * (Bedrock ConverseStream, InvokeAgent): prelude, headers, payload, two CRCs.
 */
import { crc32 } from 'node:zlib';

export const EVENT_STREAM_HEADERS = { 'content-type': 'application/vnd.amazon.eventstream' };

function header(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name);
  const valueBytes = Buffer.from(value);
  const out = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  out.writeUInt8(nameBytes.length, 0);
  nameBytes.copy(out, 1);
  out.writeUInt8(7, 1 + nameBytes.length); // a string value
  out.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
  valueBytes.copy(out, 4 + nameBytes.length);
  return out;
}

/** One event frame carrying a JSON payload. */
export function eventFrame(eventType: string, payload: unknown): Buffer {
  const headers = Buffer.concat([header(':event-type', eventType), header(':content-type', 'application/json'), header(':message-type', 'event')]);
  const body = Buffer.from(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude), 0);
  const withoutCrc = Buffer.concat([prelude, preludeCrc, headers, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(withoutCrc), 0);
  return Buffer.concat([withoutCrc, messageCrc]);
}
