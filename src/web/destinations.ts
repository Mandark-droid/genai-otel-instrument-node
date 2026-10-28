/**
 * More than one destination: each OTLP request the exporter makes to the main endpoint is also
 * sent, unchanged, to the same signal path under every additional endpoint, with that
 * destination's own headers (the main endpoint's credentials are never sent elsewhere). The main
 * endpoint's answer is what the SDK sees; an additional destination that fails is logged.
 */
import { logger } from '../logger';
import type { FetchLike } from './otlp-fetch';

export interface Destination {
  /** OTLP/HTTP base URL; /v1/traces and /v1/metrics are added as for the main endpoint. */
  endpoint: string;
  headers?: Record<string, string>;
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

export function fanOutFetch(mainEndpoint: string, destinations: readonly Destination[], base: FetchLike): FetchLike {
  const main = trimSlash(mainEndpoint);
  const others = destinations.filter((d) => d.endpoint?.trim()).map((d) => ({ ...d, endpoint: trimSlash(d.endpoint) }));
  if (!others.length) return base;
  return (url, init) => {
    if (url.startsWith(main)) {
      const path = url.slice(main.length);
      const contentType = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([key]) => key.toLowerCase() === 'content-type'));
      for (const destination of others) {
        base(`${destination.endpoint}${path}`, { ...init, headers: { ...contentType, ...destination.headers } }).then(
          (response) => {
            if (!response.ok) logger.warn(`OTLP export to ${destination.endpoint}${path} failed: HTTP ${response.status}`);
          },
          (error: unknown) => logger.warn(`OTLP export to ${destination.endpoint}${path} failed: ${String(error)}`),
        );
      }
    }
    return base(url, init);
  };
}
