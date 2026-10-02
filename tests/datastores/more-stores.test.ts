/**
 * Kafka, RabbitMQ, OpenSearch, Elasticsearch, MinIO, S3, Qdrant, Pinecone,
 * Chroma, Milvus and outbound HTTP.
 *
 * HTTP-based clients (OpenSearch, Elasticsearch, MinIO, S3, Qdrant, Pinecone,
 * fetch) run for real against the mock HTTP server. Kafka, RabbitMQ, Chroma
 * and Milvus have no server here: the real classes are patched and called with
 * their network layer replaced, or - Kafka - fail to connect, which is itself
 * the error path.
 */
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { GetObjectCommand, ListBucketsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { Pinecone } from '@pinecone-database/pinecone';
import { QdrantClient } from '@qdrant/js-client-rest';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { ChromaClient } from 'chromadb';
import { Kafka, logLevel } from 'kafkajs';
import * as Minio from 'minio';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { KafkaInstrumentor } from '../../src/datastores/messaging';
import { extractScores } from '../../src/datastores/vector';
import { searchOperation } from '../../src/datastores/search';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const require = createRequire(import.meta.url);
type Spy = (target: object, method: string) => { mockImplementation(implementation: (...args: never[]) => unknown): unknown };
const spyOn = vi.spyOn as unknown as Spy;

let server: MockLlm;
let harness: Harness;

beforeAll(async () => {
  server = await startMockLlm();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
    server.requests.length = 0;
    vi.restoreAllMocks();
  }
});

async function requests(): Promise<Record<string, unknown>[]> {
  return ((await harness.metric('mcp.requests'))?.points ?? []).map((point) => point.attributes);
}

describe('Kafka (kafkajs)', () => {
  const kafka = (): Kafka => new Kafka({ clientId: 'test', brokers: ['127.0.0.1:1'], logLevel: logLevel.NOTHING, retry: { retries: 0 } });

  it('a send is a producer span named for the topic; with no broker it ends with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const producer = kafka().producer();
    // Never connected: the real producer refuses, which is the error path.
    await expect(producer.send({ topic: 'orders', messages: [{ value: 'a' }, { value: 'b' }] })).rejects.toThrow();
    const span = harness.span('orders send');
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      'messaging.system': 'kafka',
      'messaging.operation': 'send',
      'messaging.destination': 'orders',
      'messaging.batch.message_count': 2,
    });
    expect('db.system' in span.attributes).toBe(false);
    expect(await requests()).toEqual([{ 'messaging.system': 'kafka', 'mcp.operation': 'send' }]);
    // The message bodies are not recorded.
    expect(JSON.stringify(span.attributes)).not.toContain('"a"');
  });

  it('each consumed message is a consumer span around the application handler', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    // kafkajs builds its consumer as a closure and only calls the handler from
    // its fetch loop, which needs a broker. A module of the same shape stands in
    // for it, and its consumer hands the wrapped handler back.
    const captured: { eachMessage?: (payload: unknown) => Promise<void> } = {};
    const fakeModule = {
      Kafka: class {
        consumer(): { run(config: { eachMessage: (payload: unknown) => Promise<void> }): Promise<void> } {
          return {
            run: async (config) => {
              captured.eachMessage = config.eachMessage;
            },
          };
        }
        producer(): object {
          return {};
        }
      },
    };
    const probe = new KafkaInstrumentor();
    probe.instrumentModule(fakeModule, loadConfig({}, {}));
    const seen: string[] = [];
    await new fakeModule.Kafka().consumer().run({
      eachMessage: async (payload: unknown) => {
        seen.push((payload as { topic: string }).topic);
      },
    });
    await captured.eachMessage?.({ topic: 'orders', partition: 3, message: { value: Buffer.from('x') } });
    probe.uninstrument();

    expect(seen).toEqual(['orders']);
    const span = harness.span('orders receive');
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.attributes).toMatchObject({ 'messaging.system': 'kafka', 'messaging.operation': 'receive', 'messaging.kafka.partition': 3 });
  });

  it('the real consumer has its run method wrapped', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const consumer = kafka().consumer({ groupId: 'g' });
    expect(Object.getOwnPropertySymbols(consumer.run).length).toBeGreaterThan(0);
  });
});

describe('RabbitMQ (amqplib)', () => {
  it('publish, sendToQueue and assertQueue on the real channel class are spans under the reference names', async () => {
    // The real classes, reached by path: the package exports only `connect`.
    const root = dirname(require.resolve('amqplib'));
    const { Channel, ChannelModel } = require(join(root, 'lib', 'channel_model.js')) as {
      Channel: { prototype: object };
      ChannelModel: { prototype: object };
    };
    const amqp = require('amqplib') as { connect: (url: string) => Promise<{ createChannel(): Promise<Record<string, (...a: unknown[]) => unknown>> }> };

    const channel = Object.create(Channel.prototype) as Record<string, unknown>;
    // Below the public methods: frames are not sent anywhere.
    Object.assign(channel, { sendMessage: () => true, rpc: async () => ({ fields: {} }), _rpc: () => undefined });
    const connection = Object.create(ChannelModel.prototype) as object;
    spyOn(ChannelModel.prototype, 'createChannel').mockImplementation((async () => channel) as never);
    spyOn(amqp, 'connect').mockImplementation((async () => connection) as never);

    harness = await startHarness({ enabledInstrumentors: [] });
    const live = await (await amqp.connect('amqp://127.0.0.1:1')).createChannel();
    (live.publish as (...a: unknown[]) => unknown)('events', 'order.created', Buffer.from('payload'));
    (live.sendToQueue as (...a: unknown[]) => unknown)('work', Buffer.from('payload'));

    const publishes = harness.spans().filter((span) => span.name === 'rabbitmq.basic_publish');
    expect(publishes).toHaveLength(2);
    expect(publishes[0]?.kind).toBe(SpanKind.PRODUCER);
    expect(publishes[0]?.attributes).toMatchObject({
      'messaging.system': 'rabbitmq',
      'messaging.operation': 'basic_publish',
      'messaging.destination': 'events',
      'messaging.rabbitmq.routing_key': 'order.created',
    });
    expect(publishes[1]?.attributes['messaging.rabbitmq.routing_key']).toBe('work');
    expect(JSON.stringify(publishes[0]?.attributes)).not.toContain('payload');
  });
});

describe('OpenSearch and Elasticsearch', () => {
  it('searchOperation names the API and the index from the path', () => {
    expect(searchOperation('POST', '/orders/_search')).toEqual({ operation: 'search', index: 'orders' });
    expect(searchOperation('POST', '/_bulk')).toEqual({ operation: 'bulk', index: undefined });
    expect(searchOperation('PUT', '/orders/_doc/7?refresh=true')).toEqual({ operation: 'doc', index: 'orders' });
    expect(searchOperation('GET', '/')).toEqual({ operation: 'get', index: undefined });
  });

  it('OpenSearch: a search is a client span with the index; the query body is not recorded', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ json: { took: 3, timed_out: false, hits: { total: { value: 1 }, hits: [{ _id: '1', _score: 1.2, _source: { name: 'secret-name' } }] } } });
    const client = new OpenSearchClient({ node: server.url });
    const response = await client.search({ index: 'orders', body: { query: { match: { name: 'secret-name' } } } });
    expect(response.body.hits.hits).toHaveLength(1);

    const span = harness.span('opensearch.search');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({
      'db.system': 'opensearch',
      'db.operation': 'search',
      'db.collection.name': 'orders',
      'db.opensearch.index': 'orders',
      'http.method': 'POST',
    });
    expect(JSON.stringify(span.attributes)).not.toContain('secret-name');
    expect(await requests()).toEqual([{ 'db.system': 'opensearch', 'mcp.operation': 'search' }]);
  });

  it('OpenSearch: a failing request ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ status: 404, json: { error: { type: 'index_not_found_exception', reason: 'no such index [nope]' }, status: 404 } });
    await expect(new OpenSearchClient({ node: server.url, maxRetries: 0 }).search({ index: 'nope' })).rejects.toThrow();
    expect(harness.span('opensearch.search').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('Elasticsearch: the client makes its own span; this adds the metrics and no second span', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ headers: { 'x-elastic-product': 'Elasticsearch' }, json: { took: 2, timed_out: false, hits: { hits: [] } } });
    const client = new ElasticsearchClient({ node: server.url, maxRetries: 0 });
    await client.search({ index: 'orders', query: { match_all: {} } });
    await client.close();
    expect(await requests()).toEqual([{ 'db.system': 'elasticsearch', 'mcp.operation': 'search' }]);
    // Whatever span exists is the client's own.
    expect(harness.spans().filter((span) => span.name.startsWith('elasticsearch.'))).toEqual([]);
    expect(harness.spans().length).toBeLessThanOrEqual(1);
  });
});

describe('MinIO and S3', () => {
  it('MinIO: makeBucket and statObject are spans under the reference names, with bucket and object', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const url = new URL(server.url);
    const client = new Minio.Client({ endPoint: url.hostname, port: Number(url.port), useSSL: false, accessKey: 'minio-test', secretKey: 'not-a-real-secret', region: 'us-east-1' });
    server.reply({ status: 200, json: {} });
    await client.makeBucket('reports', 'us-east-1');
    server.reply({ status: 200, headers: { 'content-length': '12', etag: '"abc"', 'last-modified': 'Fri, 02 Oct 2026 10:00:00 GMT' }, json: {} });
    await client.statObject('reports', 'q3.pdf');

    expect(harness.span('minio.make_bucket').attributes).toMatchObject({ 'db.system': 'minio', 'db.operation': 'make_bucket', 'minio.bucket': 'reports' });
    expect(harness.span('minio.stat_object').attributes).toMatchObject({ 'minio.bucket': 'reports', 'minio.object': 'q3.pdf' });
    expect((await requests()).map((labels) => labels['mcp.operation']).sort()).toEqual(['make_bucket', 'stat_object']);
  });

  it('S3: each command is a span; other AWS clients are untouched', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: server.url,
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret-not-a-real-key' },
      maxAttempts: 1,
    });
    server.reply({ status: 200, headers: { etag: '"abc"' }, json: {} });
    await client.send(new PutObjectCommand({ Bucket: 'reports', Key: 'q3.txt', Body: 'quarterly numbers' }));
    const span = harness.span('s3.put_object');
    expect(span.attributes).toMatchObject({ 'db.system': 's3', 'db.operation': 'put_object', 's3.bucket': 'reports', 's3.key': 'q3.txt' });
    expect(JSON.stringify(span.attributes)).not.toContain('quarterly numbers');
    expect(typeof GetObjectCommand).toBe('function');
    expect(typeof ListBucketsCommand).toBe('function');
  });
});

describe('vector databases', () => {
  it('extractScores finds the scores under whatever name a client uses', () => {
    expect(extractScores({ points: [{ score: 0.9 }, { score: 0.7 }] })).toEqual([0.9, 0.7]);
    expect(extractScores({ matches: [{ id: 'a', score: 0.5 }] })).toEqual([0.5]);
    expect(extractScores({ ids: [['a', 'b']], distances: [[0.1, 0.4]] })).toEqual([0.1, 0.4]);
    expect(extractScores({ results: [{ distance: 0.2 }] })).toEqual([0.2]);
    expect(extractScores({ data: { Get: { Doc: [{ _additional: { certainty: 0.8 } }] } } })).toEqual([0.8]);
    expect(extractScores(null)).toEqual([]);
    expect(extractScores({ documents: ['text only'] })).toEqual([]);
  });

  it('Qdrant: a query is `qdrant.query_points` with the collection, top-k and the score summary', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ json: { result: { points: [{ id: 1, version: 1, score: 0.91 }, { id: 2, version: 1, score: 0.72 }, { id: 3, version: 1, score: 0.4 }] }, status: 'ok', time: 0.002 } });
    const client = new QdrantClient({ url: server.url, checkCompatibility: false });
    const result = await client.query('example-embeddings', { query: [0.1, 0.2, 0.3], limit: 3 });
    expect(result.points).toHaveLength(3);

    const span = harness.span('qdrant.query_points');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({
      'db.system': 'qdrant',
      'db.operation': 'query_points',
      'vector.collection': 'example-embeddings',
      'db.collection.name': 'example-embeddings',
      'vector.limit': 3,
      'db.vector.top_k': 3,
      'rag.result.score_max': 0.91,
      'rag.result.score_min': 0.4,
    });
    expect(span.attributes['rag.result.score_mean']).toBeCloseTo((0.91 + 0.72 + 0.4) / 3, 12);
    expect(span.attributes['rag.result.score_margin']).toBeCloseTo(0.19, 12);
    // The vector is not recorded.
    expect(JSON.stringify(span.attributes)).not.toContain('0.1,0.2');
    expect(await requests()).toEqual([{ 'db.system': 'qdrant', 'mcp.operation': 'query_points' }]);
  });

  it('Qdrant: a failing query ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ status: 404, json: { status: { error: 'Not found: Collection `nope` doesn\'t exist!' }, time: 0 } });
    await expect(new QdrantClient({ url: server.url, checkCompatibility: false }).query('nope', { query: [0.1], limit: 1 })).rejects.toThrow();
    expect(harness.span('qdrant.query_points').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('Pinecone: an index query is `pinecone.index.query` with the score summary', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ json: { matches: [{ id: 'a', score: 0.8, values: [] }, { id: 'b', score: 0.6, values: [] }], namespace: '', usage: { readUnits: 5 } } });
    const index = new Pinecone({ apiKey: 'pc-test-not-a-real-key' }).index('docs', server.url);
    await index.query({ vector: [0.1, 0.2], topK: 2 });
    expect(harness.span('pinecone.index.query').attributes).toMatchObject({
      'db.system': 'pinecone',
      'db.operation': 'query',
      'db.collection.name': 'docs',
      'db.vector.top_k': 2,
      'rag.result.score_max': 0.8,
      'rag.result.score_min': 0.6,
    });
  });

  it('Chroma: the collection class is patched when the client first hands one back', async () => {
    const collection = {
      name: 'docs',
      query: async (): Promise<unknown> => ({ ids: [['a', 'b']], distances: [[0.12, 0.35]], documents: [['one', 'two']] }),
    };
    class Collection {
      name = 'docs';
      async query(): Promise<unknown> {
        return collection.query();
      }
    }
    spyOn(ChromaClient.prototype, 'getOrCreateCollection').mockImplementation((async () => new Collection()) as never);
    harness = await startHarness({ enabledInstrumentors: [] });
    const handle = (await new ChromaClient({ host: '127.0.0.1', port: 1 }).getOrCreateCollection({ name: 'docs' })) as unknown as Collection & {
      query(request: { queryTexts: string[]; nResults: number }): Promise<unknown>;
    };
    await handle.query({ queryTexts: ['hello'], nResults: 2 });
    expect(harness.span('chroma.query').attributes).toMatchObject({
      'db.system': 'chromadb',
      'db.operation': 'query',
      'vector.collection': 'docs',
      'vector.n_results': 2,
      'db.vector.top_k': 2,
      'rag.result.score_min': 0.12,
      'rag.result.score_max': 0.35,
    });
  });

  it('Milvus: a search on the real client class is `milvus.search`', async () => {
    // The method the client class inherits; nothing is sent.
    let prototype: object | null = MilvusClient.prototype as object;
    while (prototype && !Object.prototype.hasOwnProperty.call(prototype, 'search')) prototype = Object.getPrototypeOf(prototype) as object | null;
    spyOn(prototype as object, 'search').mockImplementation((async () => ({ status: { error_code: 'Success' }, results: [{ id: '1', score: 0.77 }] })) as never);
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = Object.create(MilvusClient.prototype) as MilvusClient;
    await client.search({ collection_name: 'docs', data: [0.1, 0.2], limit: 4 } as never);
    expect(harness.span('milvus.search').attributes).toMatchObject({
      'db.system': 'milvus',
      'db.operation': 'search',
      'vector.collection': 'docs',
      'db.vector.top_k': 4,
      'rag.result.score_max': 0.77,
    });
  });
});

describe('outbound HTTP (fetch)', () => {
  it('is off by default', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    server.reply({ json: { ok: true } });
    await (await fetch(`${server.url}/v1/status`)).json();
    expect(harness.spans()).toEqual([]);
  });

  it('when enabled, a fetch is `api.call.<method>.<host>`; the query string and the bodies are not recorded', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableHttpInstrumentation: true });
    server.reply({ json: { ok: true } });
    const response = await fetch(`${server.url}/v1/status?api_key=super-secret`, { method: 'POST', body: '{"note":"private"}' });
    expect(await response.json()).toEqual({ ok: true });
    const span = harness.span('api.call.post.127.0.0.1');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({
      'net.peer.name': '127.0.0.1',
      'url.full': `${server.url}/v1/status`,
      'http.method': 'POST',
      'http.status_code': 200,
    });
    expect(JSON.stringify(span.attributes)).not.toContain('super-secret');
    expect(JSON.stringify(span.attributes)).not.toContain('private');
  });

  it('after uninstrument() fetch is the platform one again', async () => {
    const before = globalThis.fetch;
    harness = await startHarness({ enabledInstrumentors: [], enableHttpInstrumentation: true });
    expect(globalThis.fetch).not.toBe(before);
    await harness.stop();
    expect(globalThis.fetch).toBe(before);
    harness = await startHarness({ enabledInstrumentors: [] });
  });
});
