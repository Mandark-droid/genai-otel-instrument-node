/**
 * PostgreSQL (`pg`), TimescaleDB and MySQL (`mysql2`).
 *
 * The counterpart of `DatabaseInstrumentor` and `TimescaleDBInstrumentor` in
 * `genai_otel/mcp_instrumentors/`. Spans follow the conventions of the
 * OpenTelemetry database instrumentations the reference delegates to: the span
 * is named for the statement's verb, with `db.system`, `db.name`, `db.user` and
 * the peer. A statement that uses a TimescaleDB function is named for it
 * (`timescaledb.create_hypertable`), as the reference's TimescaleDB
 * instrumentor does.
 */
import { exportedClass, prototypeDefining } from '../instrumentors/wrap';
import type { PatchTarget } from '../instrumentors/patching';
import { DatastoreInstrumentor, peerAttributes, type DatastoreCall } from './base';
import { estimatePayloadSize } from './payload';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/** Only this much of a statement is looked at to name it; statements can be megabytes. */
const SCAN_LIMIT = 1024;

/** In the reference's order: the first pattern found in the statement wins. */
const TIMESCALE_OPERATIONS: readonly (readonly [string, string])[] = [
  ['CREATE_DISTRIBUTED_HYPERTABLE', 'create_distributed_hypertable'],
  ['CREATE_HYPERTABLE', 'create_hypertable'],
  ['REMOVE_COMPRESSION_POLICY', 'remove_compression_policy'],
  ['ADD_COMPRESSION_POLICY', 'add_compression_policy'],
  ['REMOVE_RETENTION_POLICY', 'remove_retention_policy'],
  ['ADD_RETENTION_POLICY', 'add_retention_policy'],
  ['REMOVE_CONTINUOUS_AGGREGATE_POLICY', 'remove_continuous_aggregate_policy'],
  ['ADD_CONTINUOUS_AGGREGATE_POLICY', 'add_continuous_aggregate_policy'],
  ['CREATE MATERIALIZED VIEW', 'create_continuous_aggregate'],
  ['TIME_BUCKET', 'time_bucket_query'],
  ['DECOMPRESS_CHUNK', 'decompress_chunk'],
  ['COMPRESS_CHUNK', 'compress_chunk'],
  ['CHUNKS_DETAILED_SIZE', 'chunks_detailed_size'],
  ['HYPERTABLE_SIZE', 'hypertable_size'],
  ['DROP_CHUNKS', 'drop_chunks'],
  ['SHOW_CHUNKS', 'show_chunks'],
];

export function timescaleOperation(statement: string): string {
  const prefix = statement.slice(0, SCAN_LIMIT).toUpperCase();
  for (const [pattern, operation] of TIMESCALE_OPERATIONS) if (prefix.includes(pattern)) return operation;
  return '';
}

/** The first word of a statement, upper-cased: `SELECT`, `INSERT`, `WITH`. */
export function sqlVerb(statement: string): string {
  const match = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(statement.slice(0, SCAN_LIMIT));
  return match?.[1]?.toUpperCase() ?? 'QUERY';
}

/** `query(text, values?)`, `query({ text, values })` (pg) or `{ sql, values }` (mysql2). */
function statementOf(args: unknown[]): { text: string; values: unknown } {
  const first = args[0];
  if (typeof first === 'string') return { text: first, values: Array.isArray(args[1]) ? args[1] : undefined };
  if (isObject(first)) {
    const text = first.text ?? first.sql;
    return { text: typeof text === 'string' ? text : '', values: first.values ?? (Array.isArray(args[1]) ? args[1] : undefined) };
  }
  return { text: '', values: undefined };
}

function describeSql(system: string, args: unknown[], connection: Obj): DatastoreCall | undefined {
  const { text, values } = statementOf(args);
  if (!text) return undefined;
  const timescale = system === 'postgresql' ? timescaleOperation(text) : '';
  const verb = sqlVerb(text);
  return {
    spanName: timescale ? `timescaledb.${timescale}` : verb,
    system: timescale ? 'timescaledb' : system,
    // The metric label is `execute` for every statement, as in the reference.
    operation: 'execute',
    attributes: {
      'db.operation': timescale || verb,
      'db.name': typeof connection.database === 'string' ? connection.database : undefined,
      'db.user': typeof connection.user === 'string' ? connection.user : undefined,
      ...peerAttributes(connection.host, connection.port),
    },
    requestSize: estimatePayloadSize(text) + (values !== undefined ? estimatePayloadSize(values) : 0),
    statement: text,
  };
}

/** A hundred bytes a row: the reference's estimate. */
function rowsSize(count: unknown): number | undefined {
  return typeof count === 'number' && count > 0 ? count * 100 : undefined;
}

export class PostgresInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'PostgreSQL';
  protected readonly packages = ['pg'];
  protected override get owner(): string {
    return 'pg';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'Client');
    if (typeof client !== 'function') return [];
    return [
      {
        // Pool.query runs on a client, so this one method sees every statement once.
        holder: (client as { prototype: object }).prototype,
        method: 'query',
        wrap: this.datastoreWrapper(
          (instance, args) => {
            const call = describeSql('postgresql', args, isObject(instance) ? instance : {});
            if (!call) return undefined;
            // The metrics keep the driver family; only the span says TimescaleDB.
            return call;
          },
          {
            responseSize: (result) => rowsSize(isObject(result) ? result.rowCount : undefined),
            sizeLabelsIncludeOperation: false,
          },
        ),
      },
    ];
  }
}

export class MySQLInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'MySQL';
  protected readonly packages = ['mysql2'];
  protected override get owner(): string {
    return 'mysql2';
  }

  protected targets(module: unknown): PatchTarget[] {
    const connection: unknown = exportedClass(module, 'Connection');
    if (typeof connection !== 'function') return [];
    // `query` and `execute` live on a base class shared with pool connections;
    // the promise wrapper calls these too.
    return ['query', 'execute'].map((method) => ({
      holder: prototypeDefining(connection, method),
      method,
      wrap: this.datastoreWrapper(
        (instance, args) => describeSql('mysql', args, isObject(instance) && isObject(instance.config) ? instance.config : {}),
        {
          responseSize: (result) => (Array.isArray(result) ? rowsSize(result.length) : rowsSize(isObject(result) ? result.affectedRows : undefined)),
          sizeLabelsIncludeOperation: false,
        },
      ),
    }));
  }
}
