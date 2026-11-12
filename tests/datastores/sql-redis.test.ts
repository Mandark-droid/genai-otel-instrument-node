/**
 * PostgreSQL (`pg`), MySQL (`mysql2`), Redis (`redis`, `ioredis`) and FalkorDB.
 *
 * `pg`, `redis` and `ioredis` run for real against wire-protocol stand-ins.
 * `mysql2` and `falkordb` have their network layer replaced in the test: the
 * real classes are patched and called, nothing is sent.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { Graph } from 'falkordb';
import IORedis from 'ioredis';
import mysql from 'mysql2';
import pg from 'pg';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { estimatePayloadSize } from '../../src/datastores/payload';
import { startHarness, type Harness } from '../helpers/harness';

// tests/setup.ts switches datastore instrumentation off for the other tests.
process.env.GENAI_ENABLE_MCP_INSTRUMENTATION = 'true';
import { startPgServer, startRedisServer, type WireServer } from '../helpers/wire-servers';

let harness: Harness;
/** spyOn for a method chosen by name at run time. */
type Spy = (target: object, method: string) => { mockImplementation(implementation: (...args: never[]) => unknown): unknown };

afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
    vi.restoreAllMocks();
  }
});

async function mcp(name: string): Promise<{ attributes: Record<string, unknown>; value: unknown }[]> {
  return ((await harness.metric(name))?.points ?? []) as { attributes: Record<string, unknown>; value: unknown }[];
}

describe('estimatePayloadSize', () => {
  it('counts as the reference does: characters, 8 per number, sampled containers', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    expect(estimatePayloadSize(null)).toBe(0);
    expect(estimatePayloadSize('SELECT 1')).toBe(8);
    expect(estimatePayloadSize(42)).toBe(8);
    expect(estimatePayloadSize(true)).toBe(1);
    expect(estimatePayloadSize(Buffer.from('abcd'))).toBe(4);
    expect(estimatePayloadSize([])).toBe(2);
    expect(estimatePayloadSize([1, 2, 3])).toBe(26);
    expect(estimatePayloadSize({ a: 1 })).toBe(11);
    // A thousand rows cost ten samples, not a thousand.
    expect(estimatePayloadSize(Array.from({ length: 1000 }, () => 'abcd'))).toBe(4002);
  });
});

describe('PostgreSQL', () => {
  let server: WireServer;
  beforeAll(async () => {
    server = await startPgServer();
  });
  afterAll(async () => {
    await server.close();
  });
  const connect = async (): Promise<pg.Client> => {
    const client = new pg.Client({ host: '127.0.0.1', port: server.port, user: 'app', database: 'orders', password: 'not-a-real-password' });
    await client.connect();
    return client;
  };

  it('a query is a client span named for its verb, with the database and the peer; the statement is not recorded', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = await connect();
    const result = await client.query('SELECT answer FROM replies WHERE id = $1', [7]);
    await client.end();
    expect(result.rows).toEqual([{ answer: 'pong' }]);

    const span = harness.span('SELECT');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'db.system': 'postgresql',
      'db.operation': 'SELECT',
      'db.name': 'orders',
      'db.user': 'app',
      'net.peer.name': '127.0.0.1',
      'net.peer.port': server.port,
    });
    expect('db.statement' in span.attributes).toBe(false);

    const labels = { 'db.system': 'postgresql', 'mcp.operation': 'execute' };
    expect((await mcp('mcp.requests')).map((point) => point.attributes)).toEqual([labels]);
    expect((await mcp('mcp.client.operation.duration'))[0]?.attributes).toEqual(labels);
    expect((await mcp('mcp.request.size'))[0]?.attributes).toEqual({ 'db.system': 'postgresql' });
    // SDK_ADDITIONS.md section 10: the reference guesses 100 bytes a row; no measurement, no point.
    expect(await mcp('mcp.response.size')).toEqual([]);
  });

  it('with content capture on the statement text is recorded, bounded; parameter values never are', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableContentCapture: true, contentMaxLength: 20 });
    const client = await connect();
    await client.query('SELECT answer FROM replies WHERE secret = $1', ['hunter2']);
    await client.end();
    const attributes = harness.span('SELECT').attributes;
    expect(attributes['db.statement']).toBe('SELECT answer FROM r');
    expect(JSON.stringify(attributes)).not.toContain('hunter2');
  });

  it('a pool query is one span, not two', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const pool = new pg.Pool({ host: '127.0.0.1', port: server.port, user: 'app', database: 'orders', max: 1 });
    await pool.query('select 1');
    await pool.end();
    expect(harness.spans().map((span) => span.name)).toEqual(['SELECT']);
  });

  it('a callback-style query is closed when its callback runs', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = await connect();
    const rows = await new Promise((resolve, reject) => {
      client.query('SELECT 1', (error, result) => (error ? reject(error) : resolve(result.rows)));
    });
    await client.end();
    expect(rows).toEqual([{ answer: 'pong' }]);
    expect(harness.span('SELECT').status.code).toBe(SpanStatusCode.OK);
  });

  it('a failing statement ends the span with ERROR status and still counts as a request', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = await connect();
    await expect(client.query('SELECT fail')).rejects.toThrow(/syntax error/);
    await client.end();
    const span = harness.span('SELECT');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(await mcp('mcp.requests')).toHaveLength(1);
  });

  it('a TimescaleDB operation is named as one', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = await connect();
    await client.query("SELECT time_bucket('1 hour', ts), avg(value) FROM metrics GROUP BY 1");
    await client.query("SELECT create_hypertable('metrics', 'ts')");
    await client.end();
    expect(harness.span('timescaledb.time_bucket_query').attributes).toMatchObject({ 'db.system': 'timescaledb', 'db.operation': 'time_bucket_query' });
    expect(harness.span('timescaledb.create_hypertable').attributes['db.operation']).toBe('create_hypertable');
  });

  it('with GENAI_ENABLE_MCP_INSTRUMENTATION off, nothing is traced', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableMcpInstrumentation: false });
    const client = await connect();
    await client.query('SELECT 1');
    await client.end();
    expect(harness.spans()).toEqual([]);
  });
});

describe('MySQL', () => {
  /** A connection object of the real class with nothing behind it. */
  const connection = (): mysql.Connection => {
    const fake = Object.create(mysql.Connection.prototype) as mysql.Connection;
    Object.assign(fake, { config: { host: 'db.internal', port: 3306, database: 'orders', user: 'app' } });
    return fake;
  };
  const stubDriver = (outcome: { error?: Error; rows?: unknown[] }): void => {
    const base = Object.getPrototypeOf(mysql.Connection.prototype) as Record<string, unknown>;
    for (const method of ['query', 'execute']) {
      (vi.spyOn as unknown as Spy)(base, method).mockImplementation(((...args: unknown[]) => {
        const callback = args[args.length - 1] as (error: Error | null, rows?: unknown, fields?: unknown) => void;
        setTimeout(() => callback(outcome.error ?? null, outcome.rows ?? [], []), 2);
        return {};
      }) as never);
    }
  };

  it('query and execute are client spans named for the verb', async () => {
    stubDriver({ rows: [{ id: 1 }, { id: 2 }] });
    harness = await startHarness({ enabledInstrumentors: [] });
    const rows = await new Promise((resolve, reject) => {
      connection().query('UPDATE orders SET state = ? WHERE id = ?', ['paid', 7], (error, result) => (error ? reject(error) : resolve(result)));
    });
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    await new Promise<void>((resolve) => connection().execute('SELECT * FROM orders', () => resolve()));

    const span = harness.span('UPDATE');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({
      'db.system': 'mysql',
      'db.operation': 'UPDATE',
      'db.name': 'orders',
      'db.user': 'app',
      'net.peer.name': 'db.internal',
      'net.peer.port': 3306,
    });
    expect(harness.span('SELECT').attributes['db.system']).toBe('mysql');
    expect((await mcp('mcp.requests'))[0]?.attributes).toEqual({ 'db.system': 'mysql', 'mcp.operation': 'execute' });
  });

  it('a failing statement ends the span with ERROR status', async () => {
    stubDriver({ error: new Error("Table 'orders.nope' doesn't exist") });
    harness = await startHarness({ enabledInstrumentors: [] });
    await new Promise<void>((resolve) => connection().query('SELECT * FROM nope', () => resolve()));
    expect(harness.span('SELECT').status).toMatchObject({ code: SpanStatusCode.ERROR, message: "Table 'orders.nope' doesn't exist" });
  });
});

describe('Redis', () => {
  let server: WireServer;
  beforeAll(async () => {
    server = await startRedisServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('node-redis: each command is a client span named for the command', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = createClient({ url: `redis://127.0.0.1:${server.port}`, RESP: 2 });
    client.on('error', () => {});
    await client.connect();
    harness.reset();
    await client.set('greeting', 'hello');
    expect(await client.get('greeting')).toBe('hello');
    await client.close();

    expect(harness.spans().map((span) => span.name)).toEqual(['SET', 'GET']);
    const span = harness.span('GET');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({ 'db.system': 'redis', 'db.operation': 'GET', 'net.peer.name': '127.0.0.1', 'net.peer.port': server.port });
    // Keys and values are not recorded without content capture.
    expect(JSON.stringify(span.attributes)).not.toContain('greeting');
    expect((await mcp('mcp.requests')).map((point) => point.attributes['mcp.operation']).sort()).toEqual(expect.arrayContaining(['GET', 'SET']));
  });

  it('ioredis: each command is a client span; a failing one ends with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const client = new IORedis({ host: '127.0.0.1', port: server.port, lazyConnect: true, enableReadyCheck: false, maxRetriesPerRequest: 0 });
    client.on('error', () => {});
    await client.connect();
    harness.reset();
    await client.set('greeting', 'hello');
    expect(await client.get('greeting')).toBe('hello');
    await expect(client.call('FAIL')).rejects.toThrow(/always fails/);
    client.disconnect();

    const names = harness.spans().map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(['set', 'get', 'FAIL']));
    expect(harness.span('get').attributes).toMatchObject({ 'db.system': 'redis', 'db.operation': 'get', 'net.peer.name': '127.0.0.1', 'net.peer.port': server.port });
    expect(harness.span('FAIL').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('with content capture on, the command and its key are recorded - never the value', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableContentCapture: true });
    const client = new IORedis({ host: '127.0.0.1', port: server.port, lazyConnect: true, enableReadyCheck: false });
    client.on('error', () => {});
    await client.connect();
    await client.set('session:42', 'a-secret-value');
    client.disconnect();
    const attributes = harness.span('set').attributes;
    expect(attributes['db.statement']).toBe('set session:42');
    expect(JSON.stringify(attributes)).not.toContain('a-secret-value');
  });
});

describe('FalkorDB', () => {
  /** A Graph of the real class whose commands go nowhere. */
  const graph = (outcome: { error?: Error } = {}): Graph => {
    const fake = Object.create(Graph.prototype) as Graph;
    Object.defineProperty(fake, 'name', { value: 'example_kg', configurable: true });
    for (const method of ['query', 'roQuery', 'delete', 'copy']) {
      (vi.spyOn as unknown as Spy)(Graph.prototype, method).mockImplementation((async () => {
        if (outcome.error) throw outcome.error;
        return { data: [{ n: 1 }], metadata: [] };
      }) as never);
    }
    return fake;
  };

  it('query, roQuery, delete and copy are spans under the reference names', async () => {
    const target = graph();
    harness = await startHarness({ enabledInstrumentors: [] });
    await target.query('MATCH (n) RETURN n LIMIT 1');
    await target.roQuery('MATCH (n) RETURN count(n)');
    await target.copy('backup');
    expect(harness.span('falkordb.query').attributes).toMatchObject({ 'db.system': 'falkordb', 'db.operation': 'query', 'db.name': 'example_kg' });
    expect(harness.span('falkordb.ro_query').attributes['db.operation']).toBe('ro_query');
    expect(harness.span('falkordb.copy').attributes['falkordb.destination_graph']).toBe('backup');
    expect(harness.span('falkordb.query').kind).toBe(SpanKind.CLIENT);
    expect('db.statement' in harness.span('falkordb.query').attributes).toBe(false);
  });

  it('a failing query ends the span with ERROR status', async () => {
    const target = graph({ error: new Error('Invalid input') });
    harness = await startHarness({ enabledInstrumentors: [] });
    await expect(target.query('MATCH (n RETURN n')).rejects.toThrow('Invalid input');
    expect(harness.span('falkordb.query').status.code).toBe(SpanStatusCode.ERROR);
  });
});
