/**
 * Where offloaded media goes. Port of `genai_otel/media/stores`.
 *
 * `GENAI_OTEL_MEDIA_STORE`: `none` (default), `http` (PUT to a gateway, every
 * runtime), `filesystem` and `s3` / `minio` (Node: registered by its entry).
 * Under a strict profile, or with external egress off, a network store must use
 * https - as in the reference.
 */
import { logger } from '../logger';
import { stateSlot } from '../state';
import type { MediaStore } from './offload';

export interface StoreConfig {
  mediaStore: string;
  mediaStoreEndpoint?: string;
  mediaStoreBucket: string;
  mediaStoreAccessKey?: string;
  mediaStoreSecretKey?: string;
  profile?: string;
  allowExternalEgress?: boolean;
}

type StoreFactory = (config: StoreConfig, requireHttps: boolean) => MediaStore;

const factories = (): Map<string, StoreFactory> => stateSlot('media.store-factories', () => new Map<string, StoreFactory>());

/** Make a store kind available; the Node entry registers `filesystem`, `s3` and `minio`. */
export function registerMediaStore(kind: string, factory: StoreFactory): void {
  factories().set(kind, factory);
}

/** A URL without `user:password@`: the URI goes onto spans. */
export function stripUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href.replace(/\/$/, url.endsWith('/') ? '/' : '');
  } catch {
    return url;
  }
}

/** PUT to a gateway the operator runs. */
export class HttpStore implements MediaStore {
  private readonly endpoint: string;
  private readonly publicEndpoint: string;

  constructor(endpoint: string | undefined, requireHttps = false) {
    if (!endpoint) throw new Error('HttpStore requires GENAI_OTEL_MEDIA_STORE_ENDPOINT');
    if (requireHttps && endpoint.toLowerCase().startsWith('http://')) {
      throw new Error('Plaintext http:// media store endpoint is not allowed under a strict profile or when external egress is disabled; use https://');
    }
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.publicEndpoint = stripUserinfo(this.endpoint);
  }

  async put(data: Uint8Array, options: { key: string; mimeType: string }): Promise<string> {
    const key = options.key || crypto.randomUUID().replace(/-/g, '');
    const headers: Record<string, string> = { 'Content-Type': options.mimeType || 'application/octet-stream' };
    // Credentials in the endpoint go in the Authorization header: fetch refuses them in the URL.
    const target = new URL(`${this.endpoint}/${key}`);
    if (target.username || target.password) {
      headers.Authorization = `Basic ${btoa(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`)}`;
      target.username = '';
      target.password = '';
    }
    const response = await fetch(target, { method: 'PUT', headers, body: data });
    if (!response.ok) throw new Error(`HttpStore PUT failed: HTTP ${response.status}`);
    return `${this.publicEndpoint}/${key}`;
  }
}

registerMediaStore('http', (config, requireHttps) => new HttpStore(config.mediaStoreEndpoint, requireHttps));

const requiresHttps = (config: StoreConfig): boolean =>
  ['strict', 'bfsi', 'bank'].includes((config.profile ?? '').toLowerCase()) || config.allowExternalEgress === false;

const cache = (): Map<string, MediaStore | undefined> => stateSlot('media.store-cache', () => new Map<string, MediaStore | undefined>());

/** The store the configuration names, or undefined (none, unknown, or failing to start: logged). */
export function getStore(config: StoreConfig): MediaStore | undefined {
  const kind = (config.mediaStore || 'none').toLowerCase();
  if (kind === 'none' || kind === '') return undefined;
  const key = JSON.stringify([kind, config.mediaStoreEndpoint, config.mediaStoreBucket, config.profile, config.allowExternalEgress]);
  const memo = cache();
  if (memo.has(key)) return memo.get(key);
  const factory = factories().get(kind === 'minio' ? 's3' : kind);
  let store: MediaStore | undefined;
  if (!factory) {
    logger.warn(`Unknown media store backend '${kind}' in this runtime; disabling capture`);
  } else {
    try {
      store = factory(config, requiresHttps(config));
    } catch (error) {
      logger.warn(`Failed to initialize media store: ${String(error)}`);
    }
  }
  memo.set(key, store);
  return store;
}

/** Forget stores built so far (configuration changed, tests). */
export function resetMediaStores(): void {
  cache().clear();
}
