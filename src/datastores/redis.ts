/**
 * Redis (`redis`, `ioredis`) and FalkorDB (`falkordb`).
 *
 * The counterparts of `RedisInstrumentor` and `FalkorDBInstrumentor` in
 * `genai_otel/mcp_instrumentors/`. A Redis span is named for its command, as
 * the OpenTelemetry Redis instrumentation the reference delegates to names it.
 * FalkorDB spans carry the reference's own names (`falkordb.query`, ...).
 *
 * Keys and values are data. Without content capture only the command name is
 * recorded; with it, the command and its first argument (the key) - never a
 * value.
 */
import { exportedClass, prototypeDefining } from '../instrumentors/wrap';
import type { PatchTarget } from '../instrumentors/patching';
import { DatastoreInstrumentor, peerAttributes, type DatastoreCall } from './base';
import { estimatePayloadSize } from './payload';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

/** Commands that carry credentials: never recorded, whatever the capture setting. */
const SENSITIVE = new Set(['AUTH', 'HELLO']);

function describeCommand(name: string, firstArgument: unknown, argumentsSize: number, host: unknown, port: unknown): DatastoreCall {
  const sensitive = SENSITIVE.has(name.toUpperCase());
  return {
    spanName: name,
    system: 'redis',
    operation: name,
    attributes: peerAttributes(host, port),
    requestSize: name.length + argumentsSize,
    statement: sensitive || firstArgument === undefined ? name : `${name} ${text(firstArgument)}`,
  };
}

export class RedisInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'Redis';
  protected readonly packages = ['redis', '@redis/client', 'ioredis'];
  protected override get owner(): string {
    return 'redis';
  }

  protected targets(module: unknown, packageName: string): PatchTarget[] {
    if (packageName === 'ioredis') return this.ioredisTargets(module);
    return this.nodeRedisTargets(module);
  }

  /** node-redis: every command goes through `RedisClient.prototype.sendCommand(args)`. */
  private nodeRedisTargets(module: unknown): PatchTarget[] {
    let holder: object | undefined;
    const exported: unknown = isObject(module) || typeof module === 'function' ? (module as Obj).RedisClient : undefined;
    if (typeof exported === 'function') holder = prototypeDefining(exported, 'sendCommand');
    if (!holder) {
      // The `redis` package exports a factory; the class is reached through an
      // instance. Creating a client opens no connection.
      const create = isObject(module) || typeof module === 'function' ? (module as Obj).createClient : undefined;
      if (typeof create !== 'function') return [];
      try {
        holder = prototypeDefining((create as () => unknown)(), 'sendCommand');
      } catch {
        return [];
      }
    }
    return [
      {
        holder,
        method: 'sendCommand',
        wrap: this.datastoreWrapper((instance, args) => {
          const command = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
          if (command.length === 0) return undefined;
          const socket = isObject(instance) && isObject(instance.options) && isObject(instance.options.socket) ? instance.options.socket : {};
          return describeCommand(text(command[0]).toUpperCase(), command[1], estimatePayloadSize(command.slice(1)), socket.host, socket.port);
        }),
      },
    ];
  }

  /** ioredis: `Redis.prototype.sendCommand(command)`, where the command carries its name and arguments. */
  private ioredisTargets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'Redis');
    if (typeof client !== 'function') return [];
    return [
      {
        holder: prototypeDefining(client, 'sendCommand'),
        method: 'sendCommand',
        wrap: this.datastoreWrapper((instance, args) => {
          const command = args[0];
          if (!isObject(command) || typeof command.name !== 'string') return undefined;
          const commandArguments = Array.isArray(command.args) ? (command.args as unknown[]) : [];
          const options = isObject(instance) && isObject(instance.options) ? instance.options : {};
          return describeCommand(command.name, commandArguments[0], estimatePayloadSize(commandArguments), options.host, options.port);
        }),
      },
    ];
  }
}

export class FalkorDBInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'FalkorDB';
  protected readonly packages = ['falkordb'];
  protected override get owner(): string {
    return 'falkordb';
  }

  protected targets(module: unknown): PatchTarget[] {
    const graph: unknown = exportedClass(module, 'Graph');
    if (typeof graph !== 'function') return [];
    const prototype = (graph as { prototype: object }).prototype;
    const graphName = (instance: unknown): string | undefined => {
      const name = isObject(instance) ? (instance.name ?? instance._name) : undefined;
      return typeof name === 'string' ? name : undefined;
    };
    const target = (method: string, operation: string): PatchTarget => ({
      holder: prototype,
      method,
      wrap: this.datastoreWrapper((instance, args) => ({
        spanName: `falkordb.${operation}`,
        system: 'falkordb',
        operation,
        attributes: {
          'db.name': graphName(instance),
          'falkordb.destination_graph': operation === 'copy' && args[0] !== undefined ? String(args[0]) : undefined,
        },
        requestSize: typeof args[0] === 'string' ? args[0].length : undefined,
        statement: operation === 'query' || operation === 'ro_query' ? (typeof args[0] === 'string' ? args[0] : undefined) : undefined,
      })),
    });
    return [target('query', 'query'), target('roQuery', 'ro_query'), target('delete', 'delete'), target('copy', 'copy')];
  }
}
