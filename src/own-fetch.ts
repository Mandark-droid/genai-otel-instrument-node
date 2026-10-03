/**
 * HTTP requests this SDK makes for itself - the engine pollers, the toxicity
 * judge. They run with tracing suppressed, so they never become spans of the
 * application (the HTTP instrumentation honours the suppression) and never
 * count as its traffic.
 */
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

/** `fetch`, untraced, abandoned after `timeoutMs`. */
export async function ownFetch(url: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const controller = new AbortController();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await context.with(suppressTracing(context.active()), () => fetch(url, { ...init, signal: controller.signal }));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
