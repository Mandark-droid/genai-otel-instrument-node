/**
 * The part every module-patching instrumentor shares: find both copies of the
 * client library, patch methods on its class prototypes, undo it.
 */
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { BaseInstrumentor, type AttributeExtractor, type SpanWrapperOptions } from './base';
import { loadModuleCopies, unwrapMethod, wrapMethod } from './patch';

type AnyFunction = (...args: never[]) => unknown;

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

  /** What to patch in one loaded copy of `packageName`. */
  protected abstract targets(module: unknown, packageName: string): PatchTarget[];

  /** Called once something was patched, e.g. to claim a base URL. */
  protected onEnabled(): void {}

  /**
   * Patch every copy of the library that can be loaded. The CommonJS build is
   * patched before this returns; the promise settles once the ES-module build
   * is patched too. A library that is not installed is skipped.
   */
  instrument(config: OTelConfig): Promise<void> {
    this.setupConfig(config);
    const pending: Promise<void>[] = [];
    for (const packageName of this.packages) {
      const copies = loadModuleCopies(packageName);
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
  instrumentModule(module: unknown, config: OTelConfig, packageName: string = this.packages[0] ?? ''): void {
    this.setupConfig(config);
    this.patchModule(module, packageName);
  }

  uninstrument(): void {
    for (const [holder, method] of this.patched) unwrapMethod(holder, method, this.owner);
    this.patched = [];
    // A wrapper buried under another instrumentor's cannot be removed; with
    // this off it calls straight through.
    this.instrumented = false;
  }

  private patchModule(module: unknown, packageName: string): void {
    try {
      let found = false;
      for (const target of this.targets(module, packageName)) {
        if (!target.holder || typeof (target.holder as Record<string, unknown>)[target.method] !== 'function') continue;
        found = true;
        const wrap =
          target.wrap ?? this.createSpanWrapper(target.spanName ?? `${this.owner}.${target.method}`, target.attributes, target.options);
        if (wrapMethod(target.holder, target.method, wrap, this.owner)) this.patched.push([target.holder, target.method]);
      }
      if (!found) return;
      const first = !this.instrumented;
      this.instrumented = true;
      this.onEnabled();
      if (first) logger.info(`${this.label} instrumentation enabled`);
    } catch (error) {
      logger.error(`Failed to instrument ${this.label}: ${String(error)}`);
      if (this.config?.failOnError) throw error;
    }
  }
}
