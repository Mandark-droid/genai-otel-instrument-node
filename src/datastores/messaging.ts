/**
 * Kafka (`kafkajs`) and RabbitMQ (`amqplib`).
 *
 * The counterparts of `KafkaInstrumentor` and `RabbitMQInstrumentor` in
 * `genai_otel/mcp_instrumentors/`. Kafka spans follow the OpenTelemetry
 * messaging instrumentation the reference delegates to (`<topic> send`,
 * `<topic> receive`); RabbitMQ spans carry the reference's own names
 * (`rabbitmq.basic_publish`, `rabbitmq.queue_declare`, ...).
 *
 * Neither library exposes the classes that do the work: kafkajs builds its
 * producers and consumers as closures, and amqplib exports only `connect`. So
 * the factories are wrapped and what they hand back is patched.
 *
 * Message payloads are never recorded.
 */
import { SpanKind } from '@opentelemetry/api';
import { exportedClass } from '../instrumentors/wrap';
import type { PatchTarget } from '../instrumentors/patching';
import { DatastoreInstrumentor, onFirstInstance, type DatastoreCall } from './base';
import { estimatePayloadSize } from './payload';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

export class KafkaInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'Kafka';
  protected readonly packages = ['kafkajs'];
  protected override get owner(): string {
    return 'kafkajs';
  }

  protected targets(module: unknown): PatchTarget[] {
    const kafka: unknown = exportedClass(module, 'Kafka');
    if (typeof kafka !== 'function') return [];
    const prototype = (kafka as { prototype: object }).prototype;
    return [
      { holder: prototype, method: 'producer', wrap: (original) => this.factoryWrapper(original, (producer) => this.patchProducer(producer)) },
      { holder: prototype, method: 'consumer', wrap: (original) => this.factoryWrapper(original, (consumer) => this.patchConsumer(consumer)) },
    ];
  }

  /** Call the factory, then patch the object it returns. Never fails the factory. */
  private factoryWrapper(original: AnyFunction, patch: (made: object) => void): AnyFunction {
    return function (this: unknown, ...args: unknown[]): unknown {
      const made = (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      try {
        if (isObject(made)) patch(made);
      } catch {
        // an object we cannot patch is simply not traced
      }
      return made;
    } as unknown as AnyFunction;
  }

  private send(topic: unknown, messages: unknown): DatastoreCall {
    const name = typeof topic === 'string' && topic ? topic : 'unknown';
    return {
      spanName: `${name} send`,
      system: 'kafka',
      operation: 'send',
      kind: SpanKind.PRODUCER,
      messaging: true,
      attributes: { 'messaging.destination': name, 'messaging.batch.message_count': Array.isArray(messages) ? messages.length : undefined },
      requestSize: estimatePayloadSize(messages),
    };
  }

  private patchProducer(producer: object): void {
    this.patchLater(
      producer,
      'send',
      this.datastoreWrapper((_instance, args) => {
        const record = isObject(args[0]) ? args[0] : {};
        return this.send(record.topic, record.messages);
      }),
    );
    this.patchLater(
      producer,
      'sendBatch',
      this.datastoreWrapper((_instance, args) => {
        const batch = isObject(args[0]) && Array.isArray(args[0].topicMessages) ? (args[0].topicMessages as unknown[]) : [];
        const topics = batch.filter(isObject).map((entry) => String(entry.topic));
        const messages = batch.filter(isObject).flatMap((entry) => (Array.isArray(entry.messages) ? (entry.messages as unknown[]) : []));
        return this.send(topics.length === 1 ? topics[0] : topics.join(','), messages);
      }),
    );
  }

  /** `consumer.run({ eachMessage })`: each handler invocation is a consumer span. */
  private patchConsumer(consumer: object): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    this.patchLater(consumer, 'run', (original) => {
      return function (this: unknown, ...args: unknown[]): unknown {
        const config = isObject(args[0]) ? { ...args[0] } : undefined;
        if (config && typeof config.eachMessage === 'function') {
          config.eachMessage = instrumentor.datastoreWrapper((_instance, handlerArgs) => {
            const payload = isObject(handlerArgs[0]) ? handlerArgs[0] : {};
            const topic = typeof payload.topic === 'string' ? payload.topic : 'unknown';
            return {
              spanName: `${topic} receive`,
              system: 'kafka',
              operation: 'receive',
              kind: SpanKind.CONSUMER,
              messaging: true,
              attributes: {
                'messaging.destination': topic,
                'messaging.kafka.partition': typeof payload.partition === 'number' ? payload.partition : undefined,
              },
            };
          })(config.eachMessage as AnyFunction);
        }
        return (original as unknown as (...a: unknown[]) => unknown).apply(this, config ? [config, ...args.slice(1)] : args);
      } as unknown as AnyFunction;
    });
  }
}

/** amqplib channel method -> the reference's operation name, and which argument names the destination. */
const AMQP_OPERATIONS: readonly (readonly [string, string, SpanKind])[] = [
  // `sendToQueue` publishes to the default exchange through `publish`: one span, from there.
  ['publish', 'basic_publish', SpanKind.PRODUCER],
  ['consume', 'basic_consume', SpanKind.CONSUMER],
  ['get', 'basic_get', SpanKind.CONSUMER],
  ['assertQueue', 'queue_declare', SpanKind.CLIENT],
  ['deleteQueue', 'queue_delete', SpanKind.CLIENT],
  ['assertExchange', 'exchange_declare', SpanKind.CLIENT],
  ['deleteExchange', 'exchange_delete', SpanKind.CLIENT],
];

export class RabbitMQInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'RabbitMQ';
  protected readonly packages = ['amqplib'];
  protected override get owner(): string {
    return 'amqplib';
  }

  protected targets(module: unknown): PatchTarget[] {
    if (!isObject(module) && typeof module !== 'function') return [];
    // amqplib exports `connect` and nothing else that matters: the connection
    // and channel classes are patched when the first of each arrives.
    const patchChannels = onFirstInstance((prototype) => this.patchChannel(prototype));
    const patchConnection = onFirstInstance((prototype) => {
      for (const method of ['createChannel', 'createConfirmChannel']) {
        this.patchLater(prototype, method, (original) => this.thenPatch(original, patchChannels));
      }
    });
    return [{ holder: module as object, method: 'connect', wrap: (original) => this.thenPatch(original, patchConnection) }];
  }

  /** Call through; when the result (or the promise's value) arrives, hand it to `patch`. */
  private thenPatch(original: AnyFunction, patch: (value: unknown) => void): AnyFunction {
    return function (this: unknown, ...args: unknown[]): unknown {
      const result = (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      const observe = (value: unknown): void => {
        try {
          patch(value);
        } catch {
          // never fail the application's connect
        }
      };
      if (isObject(result) && typeof result.then === 'function') void (result as unknown as PromiseLike<unknown>).then(observe, () => {});
      else observe(result);
      return result;
    } as unknown as AnyFunction;
  }

  private patchChannel(prototype: object): void {
    for (const [method, operation, kind] of AMQP_OPERATIONS) {
      // Methods a subclass inherits are patched where they are defined.
      let holder: object | null = prototype;
      while (holder && holder !== Object.prototype && !Object.prototype.hasOwnProperty.call(holder, method)) {
        holder = Object.getPrototypeOf(holder) as object | null;
      }
      if (!holder || holder === Object.prototype) continue;
      this.patchLater(
        holder,
        method,
        this.datastoreWrapper((_instance, args) => {
          const attributes: Record<string, string | undefined> = {};
          if (method === 'publish') {
            if (args[0]) attributes['messaging.destination'] = String(args[0]);
            if (args[1]) attributes['messaging.rabbitmq.routing_key'] = String(args[1]);
          } else if (args[0]) {
            attributes['messaging.destination'] = String(args[0]);
          }
          const body = method === 'publish' ? args[2] : undefined;
          return {
            spanName: `rabbitmq.${operation}`,
            system: 'rabbitmq',
            operation,
            kind,
            messaging: true,
            attributes,
            requestSize: body === undefined ? undefined : estimatePayloadSize(body),
          };
        }),
      );
    }
  }
}
