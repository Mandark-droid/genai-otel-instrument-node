/**
 * Whether an instrumented call makes its span the active one while it runs.
 *
 * With an async context (Node's AsyncLocalStorage) each call has its own, so
 * activating the span is how nested work (an HTTP client span, a tool call)
 * becomes its child. Without one (React Native, a plain browser) there is a
 * single stack of scopes shared by everything in flight: a model call that ran
 * in the background - an embedding for a search index - would capture every span
 * the application started meanwhile. The browser and React Native entry turns
 * this off; model calls there are leaves, and only the application's own
 * `context.with()` scopes are active.
 */
let activate = true;

export function setActivateCallSpans(value: boolean): void {
  activate = value;
}

export function activatesCallSpans(): boolean {
  return activate;
}
