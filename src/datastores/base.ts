/**
 * What every datastore instrumentor shares: one client span per operation,
 * and the four `mcp.*` metrics around it.
 *
 * The reference library takes its datastore spans from the OpenTelemetry
 * contrib instrumentations and adds the metrics itself. Here the span is made
 * by this SDK too, to the same database conventions (`db.system`,
 * `db.operation`, `db.name`, `net.peer.name`, `net.peer.port`) - see
 * docs/plans/phase-3.md for why.
 *
 * A datastore call is not a model request: no token, cost or `gen_ai.requests`
 * accounting happens here.
 */
import { context, SpanKind, SpanStatusCode, trace, type Attributes, type AttributeValue, type Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import type { UsageDict } from '../instrumentors/base';
import { PatchingInstrumentor } from '../instrumentors/patching';
import { logger } from '../logger';
import { pyTruncate } from '../pycompat';
import { getMcpMetrics } from './mcp-metrics';

type AnyFunction = (...args: never[]) => unknown;

export interface DatastoreCall {
  spanName: string;
  /** `db.system` on the span, and the `db.system` label of the metrics. */
  system: string;
  /** `db.operation` on the span, and the `mcp.operation` label of the metrics. */
  operation: string;
  attributes?: Record<string, AttributeValue | undefined>;
  /** Estimated request size in bytes; recorded when positive. */
  requestSize?: number;
  /** Statement or command text. Recorded as `db.statement` only with content capture on. */
  statement?: string;
}

export interface DatastoreWrapperOptions {
  /** Estimated response size in bytes; recorded when positive. */
  responseSize?: (result: unknown) => number | undefined;
  /** More span attributes once the result is in. */
  onResult?: (span: Span, result: unknown) => void;
  /** Size histograms carry `mcp.operation` as well as `db.system`. The SQL drivers of the reference do not. */
  sizeLabelsIncludeOperation?: boolean;
}

const now = (): number => (typeof performance === 'object' ? performance.now() : Date.now());

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

interface EmitterLike {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}
function isEmitter(value: unknown): value is EmitterLike {
  return typeof value === 'object' && value !== null && typeof (value as { once?: unknown }).once === 'function';
}

export abstract class DatastoreInstrumentor extends PatchingInstrumentor {
  /** Datastore calls carry no tokens. */
  protected extractUsage(): UsageDict | null {
    return null;
  }

  /** Statement text for a span: only with content capture on, and bounded. */
  protected statementAttribute(config: OTelConfig | undefined, statement: string | undefined): string | undefined {
    if (!statement || !config?.enableContentCapture) return undefined;
    const maxLength = config.contentMaxLength > 0 ? config.contentMaxLength : 2000;
    return pyTruncate(statement, maxLength);
  }

  /**
   * Wrap a driver method. `describe` says what the call is - or returns
   * `undefined` to let it through untraced. The call may complete by returning
   * a value, a promise, by invoking a trailing callback, or by an emitter's
   * `end` / `error` event; each is handled, and the caller gets exactly what
   * the driver returned.
   */
  protected datastoreWrapper(
    describe: (instance: unknown, args: unknown[]) => DatastoreCall | undefined,
    options: DatastoreWrapperOptions = {},
  ): (original: AnyFunction) => AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return (original) => {
      const invoke = (self: unknown, args: unknown[]): unknown => (original as unknown as (...a: unknown[]) => unknown).apply(self, args);

      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        if (!instrumentor.instrumented) return invoke(this, args);

        let call: DatastoreCall | undefined;
        let span: Span;
        try {
          call = describe(this, args);
          if (!call) return invoke(this, args);
          const attributes: Attributes = { 'db.system': call.system, 'db.operation': call.operation };
          for (const [key, value] of Object.entries(call.attributes ?? {})) if (value !== undefined) attributes[key] = value;
          const statement = instrumentor.statementAttribute(instrumentor.config, call.statement);
          if (statement !== undefined) attributes['db.statement'] = statement;
          span = instrumentor.tracer.startSpan(call.spanName, { kind: SpanKind.CLIENT, attributes });
        } catch (error) {
          logger.debug(`Could not start a datastore span: ${String(error)}`);
          return invoke(this, args);
        }

        const described = call;
        const started = now();
        let finished = false;
        const finish = (error: unknown, result: unknown): void => {
          if (finished) return;
          finished = true;
          try {
            const labels = { 'db.system': described.system, 'mcp.operation': described.operation };
            const sizeLabels = options.sizeLabelsIncludeOperation === false ? { 'db.system': described.system } : labels;
            const mcp = getMcpMetrics();
            mcp.duration.record((now() - started) / 1000, labels);
            mcp.requests.add(1, labels);
            if (described.requestSize && described.requestSize > 0) mcp.requestSize.record(described.requestSize, sizeLabels);
            if (error === undefined || error === null) {
              const responseSize = options.responseSize?.(result);
              if (responseSize && responseSize > 0) mcp.responseSize.record(responseSize, sizeLabels);
              options.onResult?.(span, result);
            }
          } catch (failure) {
            logger.debug(`Failed to record datastore metrics: ${String(failure)}`);
          }
          if (error !== undefined && error !== null) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
            if (error instanceof Error) span.recordException(error);
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          span.end();
        };

        // A trailing callback: node-style (error, result).
        const last = args.length - 1;
        const callback = args[last];
        const callArgs = args.slice();
        if (typeof callback === 'function') {
          callArgs[last] = function (this: unknown, error: unknown, ...rest: unknown[]): unknown {
            finish(error, rest[0]);
            return (callback as (...a: unknown[]) => unknown).call(this, error, ...rest);
          };
        }

        let result: unknown;
        try {
          result = context.with(trace.setSpan(context.active(), span), () => invoke(this, callArgs));
        } catch (error) {
          finish(error, undefined);
          throw error;
        }
        if (typeof callback === 'function') return result;
        if (isThenable(result)) {
          void result.then(
            (value) => finish(undefined, value),
            (error: unknown) => finish(error ?? new Error('rejected'), undefined),
          );
        } else if (isEmitter(result)) {
          result.once('end', () => finish(undefined, undefined));
          result.once('error', (error) => finish(error ?? new Error('error'), undefined));
        } else {
          finish(undefined, result);
        }
        return result;
      };
      Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
      return wrapped as unknown as AnyFunction;
    };
  }
}

/** Host and port attributes, where the client knows them. */
export function peerAttributes(host: unknown, port: unknown): Record<string, AttributeValue | undefined> {
  const attributes: Record<string, AttributeValue | undefined> = {};
  if (typeof host === 'string' && host) attributes['net.peer.name'] = host;
  const numeric = typeof port === 'string' ? Number(port) : port;
  if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0) attributes['net.peer.port'] = numeric;
  return attributes;
}
