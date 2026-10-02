/**
 * Locating and patching the client libraries.
 *
 * The provider SDKs ship as CommonJS and as ES modules, and the two builds
 * define separate class objects: `require('openai').OpenAI` is not the class
 * `import('openai')` gives. Patching one silently leaves an application that
 * uses the other untraced, so both are located and both are patched.
 *
 * Methods are patched on the resource class prototype, which has two useful
 * consequences: a client constructed before `instrument()` ran is traced too,
 * and nothing depends on intercepting the module while it loads.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger';

/** On a wrapper function: the original it replaced. Shared across copies of this package. */
const ORIGINAL = Symbol.for('traceverse.genai-otel-instrument.original');
/** On a wrapper function: which instrumentor put it there. */
const OWNER = Symbol.for('traceverse.genai-otel-instrument.owner');

type AnyFunction = (...args: never[]) => unknown;
/** On a wrapper that could not be removed: its instrumentor is gone and it only passes through. */
const RETIRED = Symbol.for('traceverse.genai-otel-instrument.retired');

type Wrapped = AnyFunction & { [ORIGINAL]?: AnyFunction; [OWNER]?: string; [RETIRED]?: boolean };

function ownerOf(wrapper: Wrapped): string {
  return wrapper[OWNER] ?? 'default';
}

/**
 * Replace `target[name]` with `makeWrapper(original)`. Idempotent per owner: a
 * method already wrapped by `owner` (by this or another copy of the package)
 * is left alone and false is returned, so one instrumentor's wrappers never
 * stack. A different owner wraps on top: that is how an aggregator's
 * instrumentor and the generic one share a method.
 */
export function wrapMethod(
  target: unknown,
  name: string,
  makeWrapper: (original: AnyFunction) => AnyFunction,
  owner = 'default',
): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const holder = target as Record<string, unknown>;
  const current = holder[name] as Wrapped | undefined;
  if (typeof current !== 'function') return false;
  for (let link: Wrapped | undefined = current; link?.[ORIGINAL] !== undefined; link = link[ORIGINAL] as Wrapped) {
    if (ownerOf(link) === owner && !link[RETIRED]) return false;
  }
  const wrapper = makeWrapper(current) as Wrapped;
  wrapper[ORIGINAL] = current;
  wrapper[OWNER] = owner;
  holder[name] = wrapper;
  return true;
}

/**
 * Put the wrapped method back, if `target[name]` is `owner`'s wrapper. A
 * wrapper buried under another owner's cannot be cut out of the chain: it is
 * marked retired - its instrumentor makes it a pass-through - and no longer
 * counts as `owner`'s, so a later instrument() wraps afresh.
 */
export function unwrapMethod(target: unknown, name: string, owner = 'default'): void {
  if (typeof target !== 'object' || target === null) return;
  const holder = target as Record<string, unknown>;
  const current = holder[name] as Wrapped | undefined;
  if (typeof current !== 'function' || current[ORIGINAL] === undefined) return;
  if (ownerOf(current) === owner && !current[RETIRED]) {
    // Skip past any retired wrappers directly beneath: nothing else refers to them.
    let next = current[ORIGINAL] as Wrapped;
    while (next[RETIRED] && next[ORIGINAL] !== undefined) next = next[ORIGINAL] as Wrapped;
    holder[name] = next;
    return;
  }
  for (let link = current[ORIGINAL] as Wrapped | undefined; link?.[ORIGINAL] !== undefined; link = link[ORIGINAL] as Wrapped) {
    if (ownerOf(link) === owner && !link[RETIRED]) {
      link[RETIRED] = true;
      return;
    }
  }
}

function resolvers(): NodeRequire[] {
  const out: NodeRequire[] = [];
  // The application's own dependency tree first - from its working directory
  // and from its entry script, which differ when it is started from elsewhere -
  // then this package's.
  const bases = [join(process.cwd(), 'noop.js'), process.argv[1], import.meta.url];
  for (const base of bases) {
    if (!base) continue;
    try {
      out.push(createRequire(base));
    } catch {
      // an unusable base is not an error
    }
  }
  return out;
}

/**
 * The client class of an SDK module.
 *
 * The CommonJS builds export a FUNCTION carrying the named exports as
 * properties, the ES-module builds a namespace object; a caller may also hand
 * over the class itself. All three are accepted.
 */
export function exportedClass(module: unknown, name: string): Record<string, unknown> | undefined {
  if ((typeof module !== 'object' && typeof module !== 'function') || module === null) return undefined;
  const holder = module as Record<string, unknown>;
  const candidate = holder[name] ?? holder.default ?? holder;
  return typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

export interface ModuleCopies {
  /** CommonJS copies, available now. */
  commonjs: unknown[];
  /** ES-module copies; resolves to [] when there are none. Never rejects. */
  esm: Promise<unknown[]>;
}

/**
 * Every loadable copy of a package: the CommonJS build synchronously, the
 * ES-module build asynchronously (a dynamic `import()` is the only way to reach
 * it). A package that is not installed yields nothing and logs at debug level.
 */
export function loadModuleCopies(name: string): ModuleCopies {
  const commonjs: unknown[] = [];
  const esmUrls = new Set<string>();

  for (const resolver of resolvers()) {
    let resolved: string;
    try {
      resolved = resolver.resolve(name);
    } catch {
      continue;
    }
    try {
      const loaded: unknown = resolver(name);
      if (!commonjs.includes(loaded)) commonjs.push(loaded);
    } catch (error) {
      logger.debug(`Could not load the CommonJS build of ${name}: ${String(error)}`);
    }
    // The SDKs ship `index.mjs` next to `index.js`.
    const sibling = join(dirname(resolved), 'index.mjs');
    if (existsSync(sibling)) esmUrls.add(pathToFileURL(sibling).href);
  }
  if (commonjs.length === 0) logger.debug(`${name} is not installed, instrumentation will be skipped`);

  const esm = (async (): Promise<unknown[]> => {
    const loaded: unknown[] = [];
    for (const url of esmUrls) {
      try {
        const module: unknown = await import(url);
        if (!loaded.includes(module)) loaded.push(module);
      } catch (error) {
        logger.debug(`Could not load the ES-module build of ${name}: ${String(error)}`);
      }
    }
    return loaded;
  })();

  return { commonjs, esm };
}
