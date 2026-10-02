/**
 * Process-wide state shared by every copy of this package.
 *
 * The package ships as CommonJS and as ES modules, and the `register` entry is
 * bundled separately from the main one, so several copies of this code can be
 * loaded into one process (`--require` hook plus an ESM `import`, for example).
 * Module-level variables would give each copy its own "already initialised"
 * flag and its own metric instruments, and the second copy would set up the
 * providers again. Keeping the state on a global symbol makes them one.
 */
const STATE_KEY = Symbol.for('traceverse.genai-otel-instrument.state');

export interface GlobalState {
  [key: string]: unknown;
}

export function globalState(): GlobalState {
  const holder = globalThis as unknown as Record<symbol, GlobalState | undefined>;
  let state = holder[STATE_KEY];
  if (state === undefined) {
    state = {};
    holder[STATE_KEY] = state;
  }
  return state;
}

/** Get-or-create one named slot of the shared state. */
export function stateSlot<T>(name: string, create: () => T): T {
  const state = globalState();
  if (!(name in state)) state[name] = create();
  return state[name] as T;
}

/** Drop a slot. Used by uninstrument() and by tests. */
export function clearStateSlot(name: string): void {
  delete globalState()[name];
}
