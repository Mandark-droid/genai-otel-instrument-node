/**
 * Provider message content -> normalised content parts. Port of
 * `genai_otel/media/detector.py`.
 *
 * Shapes: OpenAI (and Groq) `messages[].content` arrays (text, image_url,
 * input_audio, input_video / video, file / input_file); Anthropic (text,
 * image, document with a base64 or url source); Google Gemini parts (text,
 * inline_data, file_data). An unknown provider is read as OpenAI.
 */
import { logger } from '../logger';

export type PartType = 'text' | 'image' | 'audio' | 'video' | 'document';
export type MediaSource = 'inline_offloaded' | 'external_url' | 'reference_only';

export interface ContentPart {
  type: PartType;
  text?: string;
  data?: Uint8Array;
  externalUrl?: string;
  mediaMimeType?: string;
  mediaByteSize?: number;
  mediaUri?: string;
  mediaSource?: MediaSource;
  extra: Record<string, unknown>;
}

const DEFAULT_MAX_DECODE_BYTES = 64 * 1024 * 1024;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
const or = <T>(...values: T[]): T | undefined => values.find((value) => truthy(value));

/** Python's `base64.b64decode(validate=False)`: characters outside the alphabet are dropped. */
function decodeBase64(text: string): Uint8Array | undefined {
  const cleaned = text.replace(/[^A-Za-z0-9+/]/g, '');
  const BufferClass = (globalThis as { Buffer?: { from(input: string, encoding: string): Uint8Array } }).Buffer;
  if (BufferClass) return new Uint8Array(BufferClass.from(cleaned, 'base64'));
  if (cleaned.length % 4 === 1) return undefined;
  const binary = atob(cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Decode inline media; refuse a payload over the cap BEFORE decoding it. */
function decodeData(data: unknown, maxBytes: number | undefined): Uint8Array | undefined {
  if (data === undefined || data === null) return undefined;
  const cap = maxBytes ?? DEFAULT_MAX_DECODE_BYTES;
  if (data instanceof Uint8Array) {
    if (cap > 0 && data.length > cap) {
      logger.warn(`Inline media (${data.length} bytes) exceeds decode cap (${cap}); dropping bytes`);
      return undefined;
    }
    return data;
  }
  if (typeof data === 'string') {
    const estimated = Math.floor((data.length * 3) / 4);
    if (cap > 0 && estimated > cap) {
      logger.warn(`Inline media (~${estimated} decoded bytes) exceeds decode cap (${cap}); dropping bytes before base64 decode`);
      return undefined;
    }
    try {
      return decodeBase64(data);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const part = (type: PartType, fields: Partial<ContentPart> = {}): ContentPart => ({ type, extra: {}, ...fields });

/** `data:<mime>;base64,<payload>` -> mime and payload; undefined when there is no comma. */
function splitDataUrl(url: string, fallbackMime: string): { mime: string; payload: string } | undefined {
  const comma = url.indexOf(',');
  if (comma < 0) return undefined;
  const header = url.slice(0, comma);
  const mime = header.split(';', 1)[0]?.replace(/^data:/, '') || fallbackMime;
  return { mime, payload: url.slice(comma + 1) };
}

function openaiPart(item: unknown, maxBytes: number | undefined): ContentPart | undefined {
  if (typeof item === 'string') return part('text', { text: item });
  if (!isObject(item)) return undefined;
  const type = item.type;
  if (type === 'text') return part('text', { text: item.text as string | undefined });
  if (type === 'image_url') {
    const holder = item.image_url ?? {};
    const url = isObject(holder) ? holder.url : holder;
    if (typeof url === 'string' && url.startsWith('data:')) {
      const split = splitDataUrl(url, 'image/png');
      if (!split) {
        logger.debug('Failed to decode data: URL');
        return part('image', { externalUrl: url });
      }
      return part('image', { data: decodeData(split.payload, maxBytes), mediaMimeType: split.mime });
    }
    return part('image', { externalUrl: url as string | undefined, mediaMimeType: 'image/*' });
  }
  if (type === 'input_audio') {
    const audio = isObject(item.input_audio) ? item.input_audio : {};
    const format = or(audio.format) ?? 'wav';
    return part('audio', { data: decodeData(audio.data, maxBytes), mediaMimeType: `audio/${String(format)}` });
  }
  if (type === 'input_video' || type === 'video') {
    const video = or(item.input_video, item.video) ?? item;
    const url = isObject(video) ? video.url : undefined;
    if (typeof url === 'string' && url.startsWith('data:')) {
      const split = splitDataUrl(url, 'video/mp4');
      if (!split) return part('video', { externalUrl: url, mediaMimeType: 'video/*' });
      return part('video', { data: decodeData(split.payload, maxBytes), mediaMimeType: split.mime });
    }
    return part('video', {
      data: isObject(video) ? decodeData(video.data, maxBytes) : undefined,
      externalUrl: url as string | undefined,
      mediaMimeType: ((isObject(video) ? or(video.mime_type) : undefined) as string | undefined) ?? 'video/mp4',
    });
  }
  if (type === 'file' || type === 'input_file') {
    const file = (or(item.file) ?? item) as Obj;
    return part('document', {
      data: decodeData(or(file.file_data, file.data), maxBytes),
      externalUrl: or(file.file_url, file.url) as string | undefined,
      mediaMimeType: 'application/pdf',
    });
  }
  return undefined;
}

function anthropicPart(item: unknown, maxBytes: number | undefined): ContentPart | undefined {
  if (typeof item === 'string') return part('text', { text: item });
  if (!isObject(item)) return undefined;
  const type = item.type;
  if (type === 'text') return part('text', { text: item.text as string | undefined });
  if (type === 'image' || type === 'document') {
    const source = isObject(item.source) ? item.source : {};
    const mime = ((or(source.media_type) as string | undefined) ?? (type === 'image' ? 'image/png' : 'application/pdf')) as string;
    if (source.type === 'base64') return part(type, { data: decodeData(source.data, maxBytes), mediaMimeType: mime });
    if (source.type === 'url') return part(type, { externalUrl: source.url as string | undefined, mediaMimeType: mime });
  }
  return undefined;
}

function classifyGoogle(mime: string, fields: Partial<ContentPart>): ContentPart {
  let type: PartType = 'document';
  if (mime.startsWith('image/')) type = 'image';
  else if (mime.startsWith('audio/')) type = 'audio';
  else if (mime.startsWith('video/')) type = 'video';
  return part(type, { ...fields, mediaMimeType: mime });
}

function googlePart(item: unknown, maxBytes: number | undefined): ContentPart | undefined {
  if (typeof item === 'string') return part('text', { text: item });
  if (!isObject(item)) return undefined;
  if ('text' in item && truthy(item.text)) return part('text', { text: item.text as string });
  const inline = or(item.inline_data, item.inlineData);
  if (isObject(inline)) {
    const mime = ((or(inline.mime_type, inline.mimeType) as string | undefined) ?? 'application/octet-stream') as string;
    return classifyGoogle(mime, { data: decodeData(inline.data, maxBytes) });
  }
  const file = or(item.file_data, item.fileData);
  if (isObject(file)) {
    const mime = ((or(file.mime_type, file.mimeType) as string | undefined) ?? 'application/octet-stream') as string;
    return classifyGoogle(mime, { externalUrl: or(file.file_uri, file.fileUri) as string | undefined });
  }
  return undefined;
}

const DETECTORS: Record<string, (item: unknown, maxBytes: number | undefined) => ContentPart | undefined> = {
  openai: openaiPart,
  anthropic: anthropicPart,
  google: googlePart,
  groq: openaiPart,
};

/** The content parts of one message's `content` (or Gemini `parts`). */
export function detectParts(provider: string, content: unknown, options: { maxDecodedBytes?: number } = {}): ContentPart[] {
  const detector = DETECTORS[provider] ?? openaiPart;
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [part('text', { text: content })];
  if (Array.isArray(content)) {
    const parts: ContentPart[] = [];
    for (const item of content) {
      const found = detector(item, options.maxDecodedBytes);
      if (!found) continue;
      if (found.data !== undefined && found.mediaByteSize === undefined) found.mediaByteSize = found.data.length;
      parts.push(found);
    }
    return parts;
  }
  if (isObject(content)) {
    const found = detector(content, options.maxDecodedBytes);
    return found ? [found] : [];
  }
  return [part('text', { text: pyNumberStr(content) })];
}

/** Python's `str()` of a scalar. */
function pyNumberStr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) === false) return String(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}
