/**
 * The media stores that need Node: the local disk, and S3 / MinIO through
 * `@aws-sdk/client-s3` (installed by the application; not a dependency).
 * Imported by the Node entry only.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { logger } from '../logger';
import { FilesystemStore } from './filesystem-store';
import type { MediaStore } from './offload';
import { registerMediaStore, stripUserinfo, type StoreConfig } from './stores';

registerMediaStore('filesystem', (config) => new FilesystemStore(config.mediaStoreEndpoint || './genai-otel-media', config.mediaStoreBucket || 'genai-otel-media'));

interface S3Module {
  S3Client: new (options: Record<string, unknown>) => { send(command: unknown): Promise<unknown> };
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  CreateBucketCommand: new (input: Record<string, unknown>) => unknown;
}

/** S3 or any S3-compatible store (MinIO, Ceph). Port of `stores/s3_minio.py`. */
export class S3Store implements MediaStore {
  private readonly client: { send(command: unknown): Promise<unknown> };
  private readonly bucket: Promise<void>;

  constructor(
    private readonly s3: S3Module,
    private readonly config: StoreConfig,
  ) {
    this.client = new s3.S3Client({
      region: process.env.AWS_REGION ?? 'us-east-1',
      forcePathStyle: true,
      ...(config.mediaStoreEndpoint ? { endpoint: config.mediaStoreEndpoint } : {}),
      ...(config.mediaStoreAccessKey && config.mediaStoreSecretKey
        ? { credentials: { accessKeyId: config.mediaStoreAccessKey, secretAccessKey: config.mediaStoreSecretKey } }
        : {}),
    });
    // As the reference: try to create the bucket; an existing one is fine.
    this.bucket = this.client.send(new s3.CreateBucketCommand({ Bucket: config.mediaStoreBucket })).then(
      () => undefined,
      (error: unknown) => logger.debug(`create_bucket: ${String(error)}`),
    );
  }

  async put(data: Uint8Array, options: { key: string; mimeType: string }): Promise<string> {
    await this.bucket;
    await this.client.send(new this.s3.PutObjectCommand({ Bucket: this.config.mediaStoreBucket, Key: options.key, Body: data, ContentType: options.mimeType || 'application/octet-stream' }));
    const endpoint = this.config.mediaStoreEndpoint;
    if (endpoint) return `${stripUserinfo(endpoint.replace(/\/+$/, ''))}/${this.config.mediaStoreBucket}/${options.key}`;
    return `s3://${this.config.mediaStoreBucket}/${options.key}`;
  }
}

registerMediaStore('s3', (config, requireHttps) => {
  if (requireHttps && config.mediaStoreEndpoint?.toLowerCase().startsWith('http://')) {
    throw new Error('Plaintext http:// S3/MinIO endpoint is not allowed under a strict profile or when external egress is disabled; use https://');
  }
  let s3: S3Module;
  try {
    s3 = createRequire(join(process.cwd(), 'noop.js'))('@aws-sdk/client-s3') as S3Module;
  } catch {
    throw new Error("The S3/MinIO media store needs '@aws-sdk/client-s3' installed by the application");
  }
  return new S3Store(s3, config);
});
