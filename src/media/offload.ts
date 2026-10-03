/**
 * Redact, upload, and replace a part's bytes by a URI. Port of
 * `genai_otel/media/offload.py`.
 *
 * Gated by `mediaCaptureMode`: `off` leaves the part alone; `reference_only`
 * records modality, type and size and keeps no bytes; `full` redacts, uploads
 * and records where the bytes went.
 *
 * Redaction. The reference resolves `GENAI_OTEL_MEDIA_REDACTOR` as a Python
 * dotted path. There is nothing to resolve such a path to here: a redactor is a
 * function the application registers (`setMediaRedactor`). A redactor named in
 * the configuration with none registered fails closed - the bytes are dropped,
 * never uploaded unredacted - as the reference does for a redactor it cannot
 * load. The reference's built-in redactors (EXIF stripping, face blurring, PDF
 * scanning) need imaging libraries and are not ported.
 */
import { logger } from '../logger';
import { stateSlot } from '../state';
import type { ContentPart } from './detector';

export interface MediaStore {
  /** Store `data` under `key`; the URI it can be read back from. */
  put(data: Uint8Array, options: { key: string; mimeType: string }): string | Promise<string>;
}

export interface MediaConfig {
  mediaCaptureMode: string;
  contentMaxLength: number;
  mediaAllowedModalities: string;
  mediaMaxBytes: number;
  mediaRedactor?: string;
  mediaStorePrefix: string;
  profile?: string;
  allowExternalEgress?: boolean;
}

export type MediaRedactor = (modality: string, mimeType: string, data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const redactorSlot = (): { redactor?: MediaRedactor } => stateSlot('media.redactor', () => ({}));

/** Register the function that redacts media bytes before upload. `undefined` removes it. */
export function setMediaRedactor(redactor: MediaRedactor | undefined): void {
  redactorSlot().redactor = redactor;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'application/pdf': '.pdf',
};

const extensionFor = (mime: string | undefined): string => (mime ? (EXTENSIONS[mime.toLowerCase()] ?? '.bin') : '.bin');

function hex32(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keyFor(prefixTemplate: string, traceId: string, part: ContentPart): string {
  const today = new Date().toISOString().slice(0, 10);
  let prefix = prefixTemplate.replace(/\{date\}/g, today).replace(/\{trace_id\}/g, traceId || 'untraced');
  if (!prefix.endsWith('/')) prefix += '/';
  return `${prefix}${hex32()}${extensionFor(part.mediaMimeType)}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const drop = (part: ContentPart, reason: string): ContentPart => {
  part.mediaSource = 'reference_only';
  part.extra.stripped_reason = reason;
  part.data = undefined;
  return part;
};

/** Apply the capture mode to one part, uploading its bytes in `full` mode. The part is changed and returned. */
export async function offloadPart(part: ContentPart, options: { config: MediaConfig; store: MediaStore | undefined; traceId?: string }): Promise<ContentPart> {
  const { config, store } = options;
  const mode = config.mediaCaptureMode;
  if (mode === 'off') return part;
  if (part.type === 'text') {
    const maxLength = config.contentMaxLength || 0;
    if (maxLength > 0 && part.text) {
      const points = Array.from(part.text);
      if (points.length > maxLength) part.text = points.slice(0, maxLength).join('');
    }
    return part;
  }
  const allowed = new Set(
    (config.mediaAllowedModalities || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry),
  );
  if (!allowed.has(part.type)) return drop(part, 'modality_not_allowed');
  if (part.data === undefined && part.externalUrl) {
    part.mediaUri = part.externalUrl;
    part.mediaSource = 'external_url';
    return part;
  }
  if (mode === 'reference_only') {
    part.mediaSource = 'reference_only';
    part.data = undefined;
    return part;
  }
  if (part.data === undefined || !store) {
    part.mediaSource = 'reference_only';
    part.extra.stripped_reason = 'no_data_or_store';
    return part;
  }
  if (part.data.length > config.mediaMaxBytes) {
    part.mediaByteSize = part.data.length;
    return drop(part, 'size_exceeded');
  }

  let payload = part.data;
  if (config.mediaRedactor) {
    const redactor = redactorSlot().redactor;
    if (!redactor) {
      logger.warn(`Media redactor '${config.mediaRedactor}' is configured but none is registered (setMediaRedactor); dropping media bytes`);
      return drop(part, 'redactor_not_allowed');
    }
  }
  const redactor = redactorSlot().redactor;
  if (redactor) {
    try {
      payload = await redactor(part.type, part.mediaMimeType ?? '', payload);
    } catch (error) {
      logger.warn(`Redactor failed; dropping bytes: ${String(error)}`);
      return drop(part, 'redactor_error');
    }
  }
  try {
    const key = keyFor(config.mediaStorePrefix, options.traceId ?? '', part);
    const uri = await store.put(payload, { key, mimeType: part.mediaMimeType ?? 'application/octet-stream' });
    part.mediaUri = uri;
    part.mediaSource = 'inline_offloaded';
    part.mediaByteSize = payload.length;
    part.extra.sha256 = await sha256Hex(payload);
    part.data = undefined;
  } catch (error) {
    logger.warn(`Media upload failed; dropping bytes: ${String(error)}`);
    drop(part, 'upload_error');
  }
  return part;
}
