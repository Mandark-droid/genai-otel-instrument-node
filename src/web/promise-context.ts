/**
 * A context manager for runtimes with no async context (React Native's Hermes,
 * browsers without Zone.js).
 *
 * Without one, `context.active()` is always the root context, so every span an
 * instrumentor starts - a Cactus completion inside an agent run, a transcription
 * inside a meeting pipeline - begins its own trace. Here `context.with(ctx, fn)`
 * keeps `ctx` active until `fn` returns, or, when `fn` returns a promise, until
 * that promise settles. Code after an `await` inside `fn` therefore still sees
 * `ctx`, and spans started there become its children.
 *
 * The active context is the most recently entered scope that has not finished.
 * With two pipelines running at once, a span started in the older one while the
 * newer one is still open is parented to the newer one; pass the parent
 * explicitly (`tracer.startSpan(name, options, parentContext)`) where that matters.
 */
import { type Context, type ContextManager, ROOT_CONTEXT } from '@opentelemetry/api';

interface Scope {
  readonly context: Context;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

export class PromiseScopeContextManager implements ContextManager {
  private scopes: Scope[] = [];
  private enabled = false;

  active(): Context {
    return this.scopes[this.scopes.length - 1]?.context ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    if (!this.enabled) return fn.call(thisArg, ...args);
    const scope: Scope = { context };
    this.scopes.push(scope);
    let result: ReturnType<F>;
    try {
      result = fn.call(thisArg, ...args);
    } catch (error) {
      this.leave(scope);
      throw error;
    }
    if (isThenable(result)) {
      const leave = () => this.leave(scope);
      result.then(leave, leave);
    } else {
      this.leave(scope);
    }
    return result;
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target !== 'function') return target;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    const bound = function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => (target as (...a: unknown[]) => unknown).apply(this, args));
    };
    return bound as unknown as T;
  }

  enable(): this {
    this.enabled = true;
    this.scopes = [];
    return this;
  }

  disable(): this {
    this.enabled = false;
    this.scopes = [];
    return this;
  }

  /** Scopes can finish out of order (two concurrent pipelines): remove this one wherever it is. */
  private leave(scope: Scope): void {
    const index = this.scopes.lastIndexOf(scope);
    if (index >= 0) this.scopes.splice(index, 1);
  }
}
