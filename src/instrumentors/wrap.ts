/**
 * Wrapping methods on class prototypes. No Node built-in is used here: the
 * browser and React Native entries patch libraries the application hands them
 * through the same code.
 */
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
  // A class is a valid holder too: its static methods are patched on it.
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return false;
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
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return;
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

/**
 * The prototype in a class's chain that defines `method` itself. Generated
 * clients often put their methods on a base class, not on the exported one.
 */
export function prototypeDefining(classOrInstance: unknown, method: string): object | undefined {
  let prototype: unknown =
    typeof classOrInstance === 'function' ? (classOrInstance as { prototype?: unknown }).prototype : Object.getPrototypeOf(classOrInstance);
  while (typeof prototype === 'object' && prototype !== null && prototype !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(prototype, method)) return prototype;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}
