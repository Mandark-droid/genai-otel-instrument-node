/**
 * The OpenTelemetry GenAI message form (`gen_ai.input.messages` /
 * `gen_ai.output.messages`) from content parts. Port of
 * `genai_otel/media/canonical.py`.
 *
 * text -> `{type: text, content}`; uploaded media -> `{type: uri, modality,
 * mime_type, uri, byte_size}`; inline media -> `{type: blob, ..., content}`
 * (base64); media observed but not captured -> the blob shape without
 * `content` and with `stripped_reason`.
 */
import type { ContentPart } from './detector';

function capText(text: string, maxLength: number | undefined): string {
  if (!maxLength || maxLength <= 0) return text;
  const points = Array.from(text);
  return points.length > maxLength ? points.slice(0, maxLength).join('') : text;
}

function base64(data: Uint8Array): string {
  const BufferClass = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (BufferClass) return BufferClass.from(data).toString('base64');
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function partToCanonical(part: ContentPart, maxLength?: number): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', content: capText(part.text ?? '', maxLength) };
  const strippedReason = part.extra.stripped_reason;
  const stripped = part.mediaSource === 'reference_only' || (strippedReason !== undefined && strippedReason !== null);
  if (part.mediaUri && !stripped) {
    const out: Record<string, unknown> = { type: 'uri', modality: part.type, uri: part.mediaUri };
    if (part.mediaMimeType) out.mime_type = part.mediaMimeType;
    if (part.mediaByteSize !== undefined) out.byte_size = Math.trunc(part.mediaByteSize);
    return out;
  }
  if (part.data !== undefined || stripped) {
    const out: Record<string, unknown> = { type: 'blob', modality: part.type };
    if (part.mediaMimeType) out.mime_type = part.mediaMimeType;
    if (part.mediaByteSize !== undefined) out.byte_size = Math.trunc(part.mediaByteSize);
    if (stripped) {
      if (strippedReason) out.stripped_reason = strippedReason;
    } else if (part.data !== undefined) {
      out.content = base64(part.data);
    }
    return out;
  }
  // As the reference: a part with nothing to show (a URL-only document before offload).
  return { type: part.type };
}

/** One message per `[role, parts]`. `maxLength` bounds each text part (unset or 0: unlimited). */
export function buildCanonicalMessages(messages: [string, ContentPart[]][], options: { maxLength?: number } = {}): Record<string, unknown>[] {
  return messages.map(([role, parts]) => ({ role, parts: parts.map((part) => partToCanonical(part, options.maxLength)) }));
}
