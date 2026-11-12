/**
 * A2A (Agent2Agent) client instrumentation for `@a2a-js/sdk` 1.x. A port of the client half of
 * `genai_otel/a2a_semconv/instrumentor.py` (Python 1.47.0). There is no server half: that is
 * decision A2UI-D6, for later.
 *
 * What it records
 * ---------------
 * One CLIENT span per logical client operation, named `{a2a.method.name} {target}`: `sendMessage`
 * (`SendMessage`), `sendMessageStream` (`SendStreamingMessage` when the Agent Card says the agent
 * streams, else `SendMessage`), `getTask`, `listTasks`, `cancelTask`, the push-notification config
 * calls, `resubscribeTask` (`SubscribeToTask`) and `getAgentCard` (`GetExtendedAgentCard`, only
 * when the card has an extended form to fetch: otherwise the call never leaves the process and has
 * no span). A streaming call's span ends when its stream does.
 *
 * Every span carries `gen_ai.operation.name = invoke_agent` and the target agent's
 * `gen_ai.agent.name`, so a backend can draw an edge from the calling agent to the called one.
 *
 * A2UI parts inside the messages (and the renderer's capabilities, and the A2UI extension header)
 * are read onto the same span (`src/a2ui/extract.ts`) unless `GENAI_A2UI_ENABLED=false`. A renderer
 * `error` message does not by itself make the span ERROR: the call carrying it succeeded.
 *
 * Propagation
 * -----------
 * W3C `traceparent` / `tracestate` (and baggage under the session-baggage policy of
 * `src/session.ts`) are added to the call's `serviceParameters`, which the SDK turns into HTTP
 * headers and gRPC metadata, so one trace runs across the two agents. `GENAI_A2A_PROPAGATE=false`
 * turns this off. See `docs/a2a-a2ui.md` for why this is the options object and not an interceptor.
 *
 * Failed tasks
 * ------------
 * A task that ends `failed` or `rejected` is not an error span: the call worked and the agent's
 * answer was no. `a2a.task.state` carries it. Only a raised error marks the span ERROR; a stream's
 * final state is recorded.
 *
 * Content
 * -------
 * Ids, states, counts, media types and the Agent Card's identity are always recorded; message and
 * artifact text, data parts and skill names only with content capture on; file bytes, URLs and names
 * never.
 */
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  context,
  defaultTextMapSetter,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { PatchingInstrumentor, type PatchTarget } from '../instrumentors/patching';
import { exportedClass } from '../instrumentors/wrap';
import type { UsageDict } from '../instrumentors/base';
import { activatesCallSpans } from '../call-scope';
import { logger } from '../logger';
import { SessionBaggagePropagator } from '../session';
import { stateSlot } from '../state';
import { VERSION } from '../version';
import { SIDE_AGENT, SIDE_RENDERER } from '../a2ui/attributes';
import { A2uiObservation, applyToSpan } from '../a2ui/extract';
import { contentWriter, settingsOf, type A2uiSettings } from '../a2ui/settings';
import { A2AAttributes, OPERATION_INVOKE_AGENT } from './attributes';
import {
  A2aObservation,
  bindingFromTransport,
  buildAttributes,
  cardAttributes,
  CLIENT_METHODS,
  errorType,
  pickInterface,
  serverAddress,
  STREAMING_CLIENT_METHODS,
  STREAMING_SEND_METHOD,
} from './extract';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export const A2A_CLIENT_PACKAGE = '@a2a-js/sdk/client';
const INSTRUMENTATION_SCOPE = 'genai_otel.a2a';

/** Trace context goes out explicitly as W3C; whatever the global propagator is does not matter here. */
const propagator = new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new SessionBaggagePropagator()] });

/** A2A extension URIs a call asked for, from its `serviceParameters` (either header spelling). */
function extensionValues(options: unknown): string[] {
  const values: string[] = [];
  if (!isMapping(options) || !isMapping(options.serviceParameters)) return values;
  for (const [key, value] of Object.entries(options.serviceParameters)) {
    const lower = key.toLowerCase();
    if ((lower === 'a2a-extensions' || lower === 'x-a2a-extensions') && typeof value === 'string') values.push(value);
  }
  return values;
}

/** Cancelling a request is not a failed call. */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** One observed call: its span, what it saw, and how it ends. */
class CallScope {
  error: unknown;
  private finished = false;

  constructor(
    private readonly span: Span,
    readonly ctx: ReturnType<typeof trace.setSpan>,
    readonly request: A2aObservation,
    readonly response: A2aObservation,
    private readonly a2ui: A2uiObservation | undefined,
    private readonly extraAlways: Attributes,
    private readonly extraContent: Attributes,
    private readonly capture: boolean,
    private readonly put: (span: Span, key: string, value: AttributeValue) => void,
  ) {}

  fail(error: unknown): void {
    if (!isAbort(error)) this.error = error;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      const [always, content] = buildAttributes(this.request, this.response);
      for (const [key, value] of Object.entries({ ...always, ...this.extraAlways })) if (value !== undefined) this.span.setAttribute(key, value);
      for (const [key, value] of Object.entries({ ...content, ...this.extraContent })) if (value !== undefined) this.put(this.span, key, value);
      // A2UI inside A2A parts, or an A2UI extension on the call. A renderer error does not make this
      // span ERROR: the call carrying it succeeded.
      if (this.a2ui?.hasData) applyToSpan(this.span, this.a2ui, this.put);
      if (this.error !== undefined) {
        const type = errorType(this.error);
        this.span.setAttribute(A2AAttributes.ERROR_TYPE, type);
        if (this.capture) {
          // A2A error messages can echo message or task content, so the text is kept only with content capture on.
          const message = this.error instanceof Error ? this.error.message : String(this.error);
          this.span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 200) });
          if (this.error instanceof Error) this.span.recordException(this.error);
        } else {
          this.span.setStatus({ code: SpanStatusCode.ERROR, message: type });
          this.span.addEvent('exception', { 'exception.type': type });
        }
      }
    } catch (error) {
      logger.debug(`Could not finish an A2A span: ${String(error)}`);
    } finally {
      try {
        this.span.end();
      } catch {
        // never let telemetry break the call
      }
    }
  }
}

const abandoned: FinalizationRegistry<CallScope> | undefined =
  typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<CallScope>((scope) => scope.finish()) : undefined;

/**
 * The stream a streaming client method returns: the SDK's events, untouched and in order, observed.
 * Its span ends when the stream does (finished, failed, or returned early) and, for a stream the
 * caller walked away from, when the stream is collected. The finalizer's held value is the scope,
 * which reaches nothing of the SDK's (see DEVELOPMENT.md, "Never let a finalizer reach its target").
 */
class ObservedStream implements AsyncIterableIterator<unknown> {
  private inner: AsyncGenerator<unknown, void, undefined> | undefined;
  private done = false;

  constructor(
    private readonly open: () => { scope: CallScope; inner: AsyncGenerator<unknown, void, undefined> } | undefined,
    private readonly passthrough: () => AsyncGenerator<unknown, void, undefined>,
  ) {}

  private scope: CallScope | undefined;
  private started = false;

  private start(): void {
    if (this.started) return;
    this.started = true;
    const opened = this.open();
    if (opened) {
      this.scope = opened.scope;
      this.inner = opened.inner;
      abandoned?.register(this, opened.scope, this);
    } else {
      this.inner = this.passthrough();
    }
  }

  private end(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    if (error !== undefined) this.scope?.fail(error);
    this.scope?.finish();
    if (this.scope) abandoned?.unregister(this);
  }

  private inScope<T>(fn: () => T): T {
    return this.scope && activatesCallSpans() ? context.with(this.scope.ctx, fn) : fn();
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    this.start();
    const inner = this.inner as AsyncGenerator<unknown, void, undefined>;
    if (this.done) return { value: undefined, done: true };
    let result: IteratorResult<unknown, void>;
    try {
      result = await this.inScope(() => inner.next());
    } catch (error) {
      this.end(error);
      throw error;
    }
    if (result.done) {
      this.end();
      return result;
    }
    this.scope?.response.observeResult(result.value);
    return result;
  }

  async return(value?: void): Promise<IteratorResult<unknown, void>> {
    this.start();
    const inner = this.inner as AsyncGenerator<unknown, void, undefined>;
    try {
      return await this.inScope(() => inner.return(value));
    } finally {
      this.end();
    }
  }

  async throw(error?: unknown): Promise<IteratorResult<unknown, void>> {
    this.start();
    const inner = this.inner as AsyncGenerator<unknown, void, undefined>;
    try {
      return await this.inScope(() => inner.throw(error));
    } catch (thrown) {
      this.end(thrown);
      throw thrown;
    }
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

export class A2AClientInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'A2A';
  protected readonly packages = [A2A_CLIENT_PACKAGE];
  protected override get owner(): string {
    return 'a2a';
  }

  protected override get tracer(): Tracer {
    return trace.getTracer(INSTRUMENTATION_SCOPE, VERSION);
  }

  /** A2A calls carry no tokens: those belong to the span of the model behind the agent. */
  protected extractUsage(): UsageDict | null {
    return null;
  }

  private settings(): A2uiSettings {
    return settingsOf(this.config);
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'Client');
    if (typeof client !== 'function') return [];
    const holder = (client as { prototype: object }).prototype;
    const targets: PatchTarget[] = [];
    for (const method of Object.keys(CLIENT_METHODS)) {
      targets.push({
        holder,
        method,
        wrap: (original) => (STREAMING_CLIENT_METHODS.has(method) ? this.streamWrapper(method, original) : this.unaryWrapper(method, original)),
      });
    }
    return targets;
  }

  /** The span, the observations and the options to call the SDK with. `undefined` when there is nothing to observe. */
  private begin(
    client: unknown,
    method: string,
    args: unknown[],
  ): { scope: CallScope; args: unknown[] } | undefined {
    const settings = this.settings();
    const capture = settings.enableContentCapture;
    const isCard = method === 'getAgentCard';
    const optionsIndex = isCard ? 0 : 1;
    const request = isCard ? undefined : args[0];
    const options = args[optionsIndex];
    const holder = isMapping(client) ? client : {};
    const card = holder.agentCard;
    // `getAgentCard` only reaches the wire when the card has an extended form; otherwise it hands back its own.
    if (isCard && !(isMapping(card) && isMapping(card.capabilities) && card.capabilities.extendedAgentCard)) return undefined;

    // The renderer sends (the request), the agent answers (the response).
    const a2ui = settings.a2uiEnabled ? new A2uiObservation(capture) : undefined;
    const req = new A2aObservation(capture, a2ui, SIDE_RENDERER);
    if (!isCard) req.observeRequest(method, request);
    req.observeExtensions(extensionValues(options));

    const binding = bindingFromTransport(holder.transport);
    let wireMethod = CLIENT_METHODS[method] as string;
    if (method === 'sendMessageStream' && isMapping(card) && isMapping(card.capabilities) && card.capabilities.streaming) {
      wireMethod = STREAMING_SEND_METHOD;
    }

    const [cardAlways, cardContent] = cardAttributes(card, capture);
    const interfaceEntry = pickInterface(card, binding);
    const start: Attributes = {
      [A2AAttributes.METHOD_NAME]: wireMethod,
      [A2AAttributes.OPERATION_NAME]: OPERATION_INVOKE_AGENT,
    };
    if (binding) start[A2AAttributes.PROTOCOL_BINDING] = binding;
    if (interfaceEntry) {
      const version = interfaceEntry.protocolVersion;
      if (typeof version === 'string' && version) start[A2AAttributes.PROTOCOL_VERSION] = version;
      Object.assign(start, serverAddress(interfaceEntry.url));
    }
    const agentName = cardAlways[A2AAttributes.AGENT_NAME];
    if (agentName !== undefined) start[A2AAttributes.AGENT_NAME] = agentName;
    const target = agentName ?? start[A2AAttributes.SERVER_ADDRESS];
    const name = target ? `${wireMethod} ${String(target)}` : wireMethod;

    const span = this.tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes: start });
    const ctx = trace.setSpan(context.active(), span);
    const extraAlways: Attributes = {};
    for (const [key, value] of Object.entries(cardAlways)) if (!(key in start) && key !== A2AAttributes.AGENT_NAME) extraAlways[key] = value;

    const callArgs = [...args];
    if (settings.a2aPropagate) {
      try {
        const carrier: Record<string, string> = {};
        propagator.inject(ctx, carrier, defaultTextMapSetter);
        if (Object.keys(carrier).length > 0) {
          const base = isMapping(options) ? options : {};
          const existing = isMapping(base.serviceParameters) ? base.serviceParameters : {};
          // A copy: the caller's own options object is not edited.
          while (callArgs.length <= optionsIndex) callArgs.push(undefined);
          callArgs[optionsIndex] = { ...base, serviceParameters: { ...existing, ...carrier } };
        }
      } catch (error) {
        logger.debug(`Could not add trace context to an A2A call: ${String(error)}`);
      }
    }

    const scope = new CallScope(
      span,
      ctx,
      req,
      new A2aObservation(capture, a2ui, SIDE_AGENT),
      a2ui,
      extraAlways,
      cardContent,
      capture,
      contentWriter(() => this.settings()),
    );
    return { scope, args: callArgs };
  }

  private unaryWrapper(method: string, original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const call = (callArgs: unknown[]): Promise<unknown> => (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, callArgs);
      if (!instrumentor.instrumented) return call(args);
      let begun: ReturnType<A2AClientInstrumentor['begin']>;
      try {
        begun = instrumentor.begin(this, method, args);
      } catch (error) {
        // Instrumentation must never break the call it observes.
        logger.debug(`A2A client span not started: ${String(error)}`);
        begun = undefined;
      }
      if (!begun) return call(args);
      const { scope } = begun;
      try {
        const result = await (activatesCallSpans() ? context.with(scope.ctx, () => call(begun.args)) : call(begun.args));
        scope.response.observeResult(result);
        scope.finish();
        return result;
      } catch (error) {
        scope.fail(error);
        scope.finish();
        throw error;
      }
    } as unknown as AnyFunction;
  }

  private streamWrapper(method: string, original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return function (this: unknown, ...args: unknown[]): unknown {
      const call = (callArgs: unknown[]): AsyncGenerator<unknown, void, undefined> =>
        (original as unknown as (...a: unknown[]) => AsyncGenerator<unknown, void, undefined>).apply(this, callArgs);
      if (!instrumentor.instrumented) return call(args);
      // The span opens when the stream is first read, as the SDK's own generator would start then.
      return new ObservedStream(
        () => {
          let begun: ReturnType<A2AClientInstrumentor['begin']>;
          try {
            begun = instrumentor.begin(this, method, args);
          } catch (error) {
            logger.debug(`A2A client span not started: ${String(error)}`);
            return undefined;
          }
          if (!begun) return undefined;
          const { scope } = begun;
          const inner = activatesCallSpans() ? context.with(scope.ctx, () => call(begun.args)) : call(begun.args);
          return { scope, inner };
        },
        () => call(args),
      );
    };
  }
}

/** The A2A client instrumentor `instrument()` starts, and the one `instrumentA2aClient()` patches a handed-over module with. */
export function a2aClientInstrumentor(): A2AClientInstrumentor {
  return stateSlot('a2a.client.instrumentor', () => new A2AClientInstrumentor());
}

