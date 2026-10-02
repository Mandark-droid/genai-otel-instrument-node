/**
 * OpenSearch (`@opensearch-project/opensearch`), Elasticsearch
 * (`@elastic/elasticsearch`), MinIO (`minio`) and S3 (`@aws-sdk/client-s3`).
 *
 * The counterparts of `OpenSearchInstrumentor`, `ElasticsearchInstrumentor` and
 * `MinIOInstrumentor` in `genai_otel/mcp_instrumentors/`.
 *
 * The Elasticsearch client creates an OpenTelemetry span of its own for every
 * request, so for it only the `mcp.*` metrics are added - which is the
 * reference's own arrangement (contrib span, metrics from this library).
 *
 * Request and response bodies are documents: never recorded without content
 * capture, and then only the request body, bounded.
 */
import { pyJsonDumps } from '../pycompat';
import { exportedClass, prototypeDefining } from '../instrumentors/wrap';
import type { PatchTarget } from '../instrumentors/patching';
import { DatastoreInstrumentor, type DatastoreCall } from './base';
import { estimatePayloadSize } from './payload';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/** `/orders/_search` -> index `orders`, operation `search`; `/_bulk` -> `bulk`; `/orders/_doc/7` -> `doc`. */
export function searchOperation(method: string, path: string): { operation: string; index: string | undefined } {
  const segments = path.split('?')[0]?.split('/').filter(Boolean) ?? [];
  const api = segments.find((segment) => segment.startsWith('_'));
  const first = segments[0];
  return {
    operation: api ? api.slice(1) : method.toLowerCase(),
    index: first && !first.startsWith('_') ? first : undefined,
  };
}

function describeTransport(system: string, args: unknown[], metricsOnly: boolean): DatastoreCall | undefined {
  const params = isObject(args[0]) ? args[0] : undefined;
  if (!params || typeof params.path !== 'string') return undefined;
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : 'GET';
  const { operation, index } = searchOperation(method, params.path);
  const body = params.body ?? params.bulkBody;
  let statement: string | undefined;
  if (body !== undefined && body !== null) {
    try {
      statement = typeof body === 'string' ? body : pyJsonDumps(body);
    } catch {
      statement = undefined;
    }
  }
  return {
    spanName: `${system}.${operation}`,
    system,
    operation,
    attributes: { 'http.method': method, 'db.collection.name': index, [`db.${system}.index`]: index },
    requestSize: body === undefined || body === null ? undefined : estimatePayloadSize(body),
    statement,
    metricsOnly,
  };
}

function responseBodySize(result: unknown): number | undefined {
  // With `meta: true` the body is under `body`; otherwise the result is the body.
  const body = isObject(result) && 'body' in result && 'statusCode' in result ? result.body : result;
  return body === undefined || body === null ? undefined : estimatePayloadSize(body);
}

export class OpenSearchInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'OpenSearch';
  protected readonly packages = ['@opensearch-project/opensearch'];
  protected override get owner(): string {
    return 'opensearch';
  }

  protected targets(module: unknown): PatchTarget[] {
    const transport: unknown = exportedClass(module, 'Transport');
    if (typeof transport !== 'function') return [];
    return [
      {
        holder: prototypeDefining(transport, 'request'),
        method: 'request',
        wrap: this.datastoreWrapper((_instance, args) => describeTransport('opensearch', args, false), { responseSize: responseBodySize }),
      },
    ];
  }
}

export class ElasticsearchInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'Elasticsearch';
  protected readonly packages = ['@elastic/elasticsearch'];
  protected override get owner(): string {
    return 'elasticsearch';
  }

  protected targets(module: unknown): PatchTarget[] {
    const transport: unknown = exportedClass(module, 'Transport');
    if (typeof transport !== 'function') return [];
    return [
      {
        holder: prototypeDefining(transport, 'request'),
        method: 'request',
        // The client's own span is the span; see the file header.
        wrap: this.datastoreWrapper((_instance, args) => describeTransport('elasticsearch', args, true), { responseSize: responseBodySize }),
      },
    ];
  }
}

/** minio-js method -> the reference's operation name. */
const MINIO_OPERATIONS: readonly (readonly [string, string])[] = [
  ['putObject', 'put_object'],
  ['getObject', 'get_object'],
  ['removeObject', 'remove_object'],
  ['listObjects', 'list_objects'],
  ['makeBucket', 'make_bucket'],
  ['removeBucket', 'remove_bucket'],
  ['listBuckets', 'list_buckets'],
  ['statObject', 'stat_object'],
  ['fPutObject', 'fput_object'],
  ['fGetObject', 'fget_object'],
];

export class MinIOInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'MinIO';
  protected readonly packages = ['minio'];
  protected override get owner(): string {
    return 'minio';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'Client');
    if (typeof client !== 'function') return [];
    return MINIO_OPERATIONS.map(([method, operation]) => ({
      holder: prototypeDefining(client, method),
      method,
      wrap: this.datastoreWrapper((_instance, args) => ({
        spanName: `minio.${operation}`,
        system: 'minio',
        operation,
        attributes: {
          'minio.bucket': typeof args[0] === 'string' ? args[0] : undefined,
          'minio.object': typeof args[1] === 'string' ? args[1] : undefined,
        },
        // Sized only when the size is known without reading a stream.
        requestSize: operation === 'put_object' && (typeof args[2] === 'string' || args[2] instanceof Uint8Array) ? estimatePayloadSize(args[2]) : undefined,
      })),
    }));
  }
}

/** `PutObjectCommand` -> `put_object`. */
function s3Operation(command: unknown): string | undefined {
  const name = isObject(command) && typeof command.constructor === 'function' ? command.constructor.name : '';
  if (!name.endsWith('Command')) return undefined;
  return name
    .slice(0, -'Command'.length)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * S3 through the AWS SDK. Not in the reference, which covers object storage
 * through the MinIO client only; JavaScript applications reach MinIO and S3
 * through this client at least as often.
 */
export class S3Instrumentor extends DatastoreInstrumentor {
  protected readonly label = 'S3';
  protected readonly packages = ['@aws-sdk/client-s3'];
  protected override get owner(): string {
    return 's3';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'S3Client');
    if (typeof client !== 'function') return [];
    return [
      {
        // Defined on the S3 client's own prototype: `send` is otherwise shared by every AWS client.
        holder: (client as { prototype: object }).prototype,
        method: 'send',
        wrap: this.datastoreWrapper((_instance, args) => {
          const operation = s3Operation(args[0]);
          if (!operation) return undefined;
          const input = isObject(args[0]) && isObject(args[0].input) ? args[0].input : {};
          const body = input.Body;
          return {
            spanName: `s3.${operation}`,
            system: 's3',
            operation,
            attributes: {
              's3.bucket': typeof input.Bucket === 'string' ? input.Bucket : undefined,
              's3.key': typeof input.Key === 'string' ? input.Key : undefined,
            },
            requestSize: typeof body === 'string' || body instanceof Uint8Array ? estimatePayloadSize(body) : undefined,
          };
        }),
      },
    ];
  }
}
