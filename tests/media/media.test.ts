/**
 * Multimodal content parts: detection, offload and the canonical message
 * form, against vectors made by running the reference's `genai_otel.media`
 * (tests/fixtures/media/python-vectors.json).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCanonicalMessages, detectParts, offloadPart, setMediaRedactor, type ContentPart, type MediaConfig } from '../../src/media';
import { FilesystemStore } from '../../src/media/filesystem-store';

interface PartVector {
  type: string;
  text: string | null;
  data_b64: string | null;
  external_url: string | null;
  media_mime_type: string | null;
  media_byte_size: number | null;
  media_uri: string | null;
  media_source: string | null;
  extra: Record<string, unknown>;
}

const vectors = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/media/python-vectors.json'), 'utf8')) as {
  detect: { provider: string; name: string; content: unknown; parts: PartVector[] }[];
  detect_with_cap: { provider: string; name: string; content: unknown; max_decoded_bytes: number; parts: PartVector[] }[];
  offload: { name: string; config: Record<string, unknown>; use_store: boolean; trace_id: string; parts: PartVector[] }[];
  canonical: { name: string; max_length: number | null; messages: [string, PartVector[]][]; result: unknown }[];
};

/** This SDK's part in the reference's shape. */
function asVector(part: ContentPart): PartVector {
  return {
    type: part.type,
    text: part.text ?? null,
    data_b64: part.data ? Buffer.from(part.data).toString('base64') : null,
    external_url: part.externalUrl ?? null,
    media_mime_type: part.mediaMimeType ?? null,
    media_byte_size: part.mediaByteSize ?? null,
    media_uri: part.mediaUri ?? null,
    media_source: part.mediaSource ?? null,
    extra: { ...part.extra },
  };
}

function fromVector(vector: PartVector): ContentPart {
  return {
    type: vector.type as ContentPart['type'],
    text: vector.text ?? undefined,
    data: vector.data_b64 === null ? undefined : new Uint8Array(Buffer.from(vector.data_b64, 'base64')),
    externalUrl: vector.external_url ?? undefined,
    mediaMimeType: vector.media_mime_type ?? undefined,
    mediaByteSize: vector.media_byte_size ?? undefined,
    mediaUri: vector.media_uri ?? undefined,
    mediaSource: (vector.media_source ?? undefined) as ContentPart['mediaSource'],
    extra: { ...vector.extra },
  };
}

const root = mkdtempSync(join(tmpdir(), 'genai-otel-media-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const store = new FilesystemStore(root, 'b');

describe('detectParts', () => {
  for (const vector of vectors.detect) {
    it(`${vector.provider}: ${vector.name}`, () => {
      expect(detectParts(vector.provider, vector.content).map(asVector)).toEqual(vector.parts);
    });
  }
  for (const vector of vectors.detect_with_cap) {
    it(`${vector.provider}: ${vector.name} (decode cap ${vector.max_decoded_bytes})`, () => {
      expect(detectParts(vector.provider, vector.content, { maxDecodedBytes: vector.max_decoded_bytes }).map(asVector)).toEqual(vector.parts);
    });
  }
});

describe('offloadPart', () => {
  for (const vector of vectors.offload) {
    it(vector.name, async () => {
      // The vector was made from the reference detector over this content.
      const detect = vectors.detect.find((entry) => entry.name === 'text and data image');
      void detect;
      const config: MediaConfig = {
        mediaCaptureMode: String(vector.config.media_capture_mode),
        contentMaxLength: Number(vector.config.content_max_length),
        mediaAllowedModalities: String(vector.config.media_allowed_modalities),
        mediaMaxBytes: Number(vector.config.media_max_bytes),
        mediaRedactor: String(vector.config.media_redactor || '') || undefined,
        mediaStorePrefix: String(vector.config.media_store_prefix),
        profile: String(vector.config.profile || ''),
        allowExternalEgress: Boolean(vector.config.allow_external_egress),
      };
      const parts = inputsFor(vector.name);
      const out: PartVector[] = [];
      for (const part of parts) {
        const result = asVector(await offloadPart(part, { config, store: vector.use_store ? store : undefined, traceId: vector.trace_id }));
        if (result.media_uri?.startsWith('file:')) {
          const relative = fileURLToPath(result.media_uri).replace(/\\/g, '/').split('/b/')[1] as string;
          result.media_uri = `<file-uri:${relative.replace(/[0-9a-f]{32}/g, '<uuid>').replace(/\d{4}-\d{2}-\d{2}/g, '<date>')}>`;
        }
        out.push(result);
      }
      expect(out).toEqual(vector.parts);
    });
  }
});

/** The parts each offload vector started from, rebuilt the way the generator built them. */
function inputsFor(name: string): ContentPart[] {
  const png = Buffer.from('\x89PNG\r\n\x1a\nfake-png-bytes', 'latin1').toString('base64');
  const wav = Buffer.from('RIFF....WAVEfake', 'latin1').toString('base64');
  if (name === 'external url kept') return detectParts('openai', [{ type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }]);
  if (name === 'modality not allowed') return detectParts('openai', [{ type: 'input_audio', input_audio: { data: wav, format: 'wav' } }]);
  return detectParts('openai', [
    { type: 'text', text: 'x'.repeat(300) },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  ]);
}

describe('buildCanonicalMessages', () => {
  for (const vector of vectors.canonical) {
    it(vector.name, () => {
      const messages = vector.messages.map(([role, parts]) => [role, parts.map(fromVector)] as [string, ContentPart[]]);
      expect(buildCanonicalMessages(messages, { maxLength: vector.max_length ?? undefined })).toEqual(vector.result);
    });
  }
});

describe('redactors', () => {
  const config: MediaConfig = {
    mediaCaptureMode: 'full',
    contentMaxLength: 200,
    mediaAllowedModalities: 'image,audio,video,document',
    mediaMaxBytes: 1024,
    mediaRedactor: 'application',
    mediaStorePrefix: 'r/',
    profile: '',
    allowExternalEgress: true,
  };
  const image = (): ContentPart => ({ type: 'image', data: new Uint8Array([1, 2, 3, 4]), mediaMimeType: 'image/png', extra: {} });

  it('a redactor the application registered transforms the bytes before upload', async () => {
    setMediaRedactor((_modality, _mime, data) => data.slice(0, 2));
    try {
      const part = await offloadPart(image(), { config, store, traceId: 't' });
      expect(part.mediaSource).toBe('inline_offloaded');
      expect(part.mediaByteSize).toBe(2);
      expect(readFileSync(fileURLToPath(part.mediaUri as string))).toEqual(Buffer.from([1, 2]));
    } finally {
      setMediaRedactor(undefined);
    }
  });

  it('a redactor that throws: the bytes are dropped, never uploaded unredacted', async () => {
    setMediaRedactor(() => {
      throw new Error('cannot read this format');
    });
    try {
      const part = await offloadPart(image(), { config, store, traceId: 't' });
      expect(part).toMatchObject({ mediaSource: 'reference_only', extra: { stripped_reason: 'redactor_error' } });
      expect(part.data).toBeUndefined();
    } finally {
      setMediaRedactor(undefined);
    }
  });

  it('a redactor named in the configuration but not registered here (a Python dotted path): dropped', async () => {
    const part = await offloadPart(image(), { config: { ...config, mediaRedactor: 'genai_otel.media.redactors.exif_stripper' }, store, traceId: 't' });
    expect(part).toMatchObject({ mediaSource: 'reference_only', extra: { stripped_reason: 'redactor_not_allowed' } });
  });

  it('a store that fails: dropped, with the reason', async () => {
    const failing = { put: (): Promise<string> => Promise.reject(new Error('disk full')) };
    const part = await offloadPart(image(), { config: { ...config, mediaRedactor: undefined }, store: failing, traceId: 't' });
    expect(part).toMatchObject({ mediaSource: 'reference_only', extra: { stripped_reason: 'upload_error' } });
  });
});

describe('FilesystemStore', () => {
  it('refuses a key that leaves the store', () => {
    expect(() => store.put(new Uint8Array([1]), { key: '../escape.bin', mimeType: 'x' })).toThrow('escapes');
    expect(() => store.put(new Uint8Array([1]), { key: '/abs.bin', mimeType: 'x' })).toThrow('absolute');
  });
});

describe('network stores', () => {
  it('http: PUT to the gateway; credentials in the endpoint never reach the URI', async () => {
    const { startMockLlm } = await import('../helpers/mock-llm');
    const { HttpStore } = await import('../../src/media/stores');
    const gateway = await startMockLlm();
    try {
      gateway.reply({ json: {} });
      const uri = await new HttpStore(gateway.url.replace('http://', 'http://user:secret@')).put(new Uint8Array([7, 7]), { key: 'k/a.png', mimeType: 'image/png' });
      expect(uri).toBe(`${gateway.url}/k/a.png`);
      expect(gateway.requests[0]).toMatchObject({ method: 'PUT', path: '/k/a.png' });
      expect(gateway.requests[0]?.headers['content-type']).toBe('image/png');
      expect(gateway.requests[0]?.headers.authorization).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`);
      gateway.reply({ status: 500, json: {} });
      await expect(new HttpStore(gateway.url).put(new Uint8Array([1]), { key: 'x', mimeType: '' })).rejects.toThrow('HTTP 500');
    } finally {
      await gateway.close();
    }
    expect(() => new HttpStore('http://gateway.internal', true)).toThrow('Plaintext http://');
    expect(() => new HttpStore(undefined)).toThrow('GENAI_OTEL_MEDIA_STORE_ENDPOINT');
  });

  it('s3 / minio: PutObject to the endpoint, path style; the URI names endpoint, bucket and key', async () => {
    const { startMockLlm } = await import('../helpers/mock-llm');
    const { getStore, resetMediaStores } = await import('../../src/media/stores');
    await import('../../src/media/node-stores');
    const minio = await startMockLlm();
    try {
      minio.reply({ json: {} }); // CreateBucket
      minio.reply({ json: {} }); // PutObject
      resetMediaStores();
      const store = getStore({ mediaStore: 'minio', mediaStoreEndpoint: minio.url, mediaStoreBucket: 'media', mediaStoreAccessKey: 'AKIAEXAMPLE', mediaStoreSecretKey: 'example-secret' });
      const uri = await store?.put(new Uint8Array([1, 2]), { key: 'traces/x.png', mimeType: 'image/png' });
      expect(uri).toBe(`${minio.url}/media/traces/x.png`);
      expect(minio.requests.map((request) => `${request.method} ${request.path.split('?')[0]}`)).toEqual(['PUT /media/', 'PUT /media/traces/x.png']);
      resetMediaStores();
      expect(getStore({ mediaStore: 's3', mediaStoreEndpoint: 'http://minio.internal:9000', mediaStoreBucket: 'm', profile: 'strict' })).toBeUndefined();
      expect(getStore({ mediaStore: 'nonsense', mediaStoreBucket: 'm' })).toBeUndefined();
      expect(getStore({ mediaStore: 'none', mediaStoreBucket: 'm' })).toBeUndefined();
    } finally {
      resetMediaStores();
      await minio.close();
    }
  });
});
