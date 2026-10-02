/**
 * The part every module-patching instrumentor shares: find both copies of the
 * client library, patch methods on its class prototypes, undo it.
 */
import { context, SpanStatusCode, trace, type Attributes, type AttributeValue, type Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { contextWithSessionId } from '../session';
import { BaseInstrumentor, type AttributeExtractor, type SpanWrapperOptions } from './base';
import { unwrapMethod, wrapMethod } from './wrap';

type AnyFunction = (...args: never[]) => unknown;

/** Both loadable copies of a package: CommonJS now, ES module later. */
export interface LoadedCopies {
  commonjs: unknown[];
  esm: Promise<unknown[]>;
}

/**
 * Finds a package by name. Only Node can; its entry installs one. In a browser
 * or React Native there is none, and the application hands the library over
 * (`instrumentModule`).
 */
let moduleLoader: ((packageName: string) => LoadedCopies) | undefined;

export function setModuleLoader(loader: ((packageName: string) => LoadedCopies) | undefined): void {
  moduleLoader = loader;
}

export interface PatchTarget {
  /** The class prototype (or object) holding the method. `undefined` is skipped: the library version lacks it. */
  holder: object | undefined;
  method: string;
  /** Span name for the common wrapper. */
  spanName?: string;
  attributes?: AttributeExtractor;
  /** Options for the common wrapper. */
  options?: SpanWrapperOptions;
  /** A wrapper of the instrumentor's own, instead of the common one. */
  wrap?: (original: AnyFunction) => AnyFunction;
}

export abstract class PatchingInstrumentor extends BaseInstrumentor {
  /** For log lines: `Groq instrumentation enabled`. */
  protected abstract readonly label: string;
  /** npm package names to look for; each is optional. */
  protected abstract readonly packages: readonly string[];
  /**
   * Who owns the wrappers. Two instrumentors may wrap the same method (the
   * OpenAI one and an aggregator's): each wraps once, under its own name.
   */
  protected get owner(): string {
    return 'default';
  }

  private patched: [object, string][] = [];
  /** instrument() has run (and uninstrument() has not): wrappers act. */
  private enabled = false;

  /** What to patch in one loaded copy of `packageName`. */
  protected abstract targets(module: unknown, packageName: string): PatchTarget[];

  /** Called once something was patched, e.g. to claim a base URL. */
  protected onEnabled(): void {}

  /**
   * Patch every copy of the library that can be loaded. The CommonJS build is
   * patched before this returns; the promise settles once the ES-module build
   * is patched too. A library that is not installed is skipped. Where packages
   * cannot be located by name (browser, React Native) this only attaches the
   * configuration, and `instrumentModule` does the patching.
   */
  instrument(config: OTelConfig): Promise<void> {
    this.setupConfig(config);
    this.enabled = true;
    // Modules handed over before instrument() ran were patched then.
    if (this.patched.length > 0) this.instrumented = true;
    const pending: Promise<void>[] = [];
    const load = moduleLoader;
    for (const packageName of load ? this.packages : []) {
      const copies = (load as NonNullable<typeof load>)(packageName);
      for (const module of copies.commonjs) this.patchModule(module, packageName);
      pending.push(
        copies.esm.then((modules) => {
          for (const module of modules) this.patchModule(module, packageName);
        }),
      );
    }
    return Promise.all(pending).then(() => undefined);
  }

  /**
   * Instrument a module the application hands over - for bundled applications
   * and for runtimes where a package cannot be resolved at run time.
   */
  instrumentModule(module: unknown, config?: OTelConfig, packageName: string = this.packages[0] ?? ''): boolean {
    if (config) {
      this.setupConfig(config);
      this.enabled = true;
    }
    return this.patchModule(module, packageName);
  }

  uninstrument(): void {
    for (const [holder, method] of this.patched) unwrapMethod(holder, method, this.owner);
    this.patched = [];
    // A wrapper buried under another instrumentor's cannot be removed; with
    // this off it calls straight through.
    this.instrumented = false;
    this.enabled = false;
  }

  /**
   * Patch a method on an object that was not reachable when the module was
   * first looked at - a class only seen through an instance the library hands
   * back later. Undone with the rest by `uninstrument()`.
   */
  protected patchLater(holder: object, method: string, wrap: (original: AnyFunction) => AnyFunction): boolean {
    if (typeof (holder as Record<string, unknown>)[method] !== 'function') return false;
    if (!wrapMethod(holder, method, wrap, this.owner)) return false;
    this.patched.push([holder, method]);
    return true;
  }

  private patchModule(module: unknown, packageName: string): boolean {
    try {
      let found = false;
      for (const target of this.targets(module, packageName)) {
        if (!target.holder || typeof (target.holder as Record<string, unknown>)[target.method] !== 'function') continue;
        found = true;
        const wrap =
          target.wrap ?? this.createSpanWrapper(target.spanName ?? `${this.owner}.${target.method}`, target.attributes, target.options);
        if (wrapMethod(target.holder, target.method, wrap, this.owner)) this.patched.push([target.holder, target.method]);
      }
      if (!found) return false;
      // A library handed over before instrument() is patched now and switched on then.
      if (!this.enabled) return true;
      const first = !this.instrumented;
      this.instrumented = true;
      this.onEnabled();
      if (first) logger.info(`${this.label} instrumentation enabled`);
      return true;
    } catch (error) {
      logger.error(`Failed to instrument ${this.label}: ${String(error)}`);
      if (this.config?.failOnError) throw error;
      return false;
    }
  }

  /**
   * A wrapper for an operation that is not a model request - loading or
   * downloading a model: a span with its duration and outcome, and no request,
   * token or cost accounting. `attributes` may add more once the result is in.
   */
  protected operationWrapper(
    spanName: string,
    attributes: (instance: unknown, args: unknown[]) => Record<string, AttributeValue | undefined>,
    onResult?: (span: Span, result: unknown, instance: unknown, args: unknown[]) => void,
  ): (original: AnyFunction) => AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return (original) => {
      const invoke = (self: unknown, args: unknown[]): unknown => (original as unknown as (...a: unknown[]) => unknown).apply(self, args);
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        if (!instrumentor.instrumented) return invoke(this, args);
        let span: Span;
        try {
          const initial: Attributes = {};
          for (const [key, value] of Object.entries(attributes(this, args))) if (value !== undefined) initial[key] = value;
          span = instrumentor.tracer.startSpan(spanName, { attributes: initial });
        } catch (error) {
          logger.error(`Span creation failed for '${spanName}': ${String(error)}`);
          return invoke(this, args);
        }
        const fail = (error: unknown): void => {
          span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
          if (error instanceof Error) span.recordException(error);
          span.end();
        };
        const succeed = (result: unknown): void => {
          try {
            onResult?.(span, result, this, args);
          } catch (error) {
            logger.debug(`Failed to record the result of '${spanName}': ${String(error)}`);
          }
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        };
        let result: unknown;
        try {
          // The active span while it runs, so what it calls is its child; and
          // if it carries a session id, that session is in force inside it.
          const active = span;
          const ctx = contextWithSessionId(trace.setSpan(context.active(), active), (active as unknown as { attributes?: Attributes }).attributes?.['session.id']);
          result = context.with(ctx, () => invoke(this, args));
        } catch (error) {
          fail(error);
          throw error;
        }
        if (typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
          void (result as PromiseLike<unknown>).then(succeed, fail);
        } else {
          succeed(result);
        }
        return result;
      };
      Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
      return wrapped as unknown as AnyFunction;
    };
  }
}
