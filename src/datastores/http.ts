/**
 * Outbound HTTP through the global `fetch`. Opt-in:
 * `GENAI_ENABLE_HTTP_INSTRUMENTATION=true`.
 *
 * A port of `genai_otel/mcp_instrumentors/api_instrumentor.py`, which traces
 * `httpx`: span `api.call.<method>.<host>`, with `net.peer.name`, `url.full`,
 * `http.method`, and `gen_ai.system` where the host is a known model provider.
 *
 * Off by default, as in the reference: every provider client in this SDK
 * already has its own span, and their requests go through `fetch` too.
 *
 * The query string can carry credentials, so `url.full` is recorded without
 * it. Request and response bodies are never read.
 */
import { SpanKind } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { DatastoreInstrumentor } from './base';
import type { PatchTarget } from '../instrumentors/patching';

type AnyFunction = (...args: never[]) => unknown;

function providerOf(host: string): string | undefined {
  if (host.endsWith('openai.com')) return 'openai';
  if (host.endsWith('anthropic.com')) return 'anthropic';
  if (host.endsWith('google.com') || host.endsWith('googleapis.com')) return 'google';
  return undefined;
}

function requestOf(args: unknown[]): { url: URL; method: string } | undefined {
  const [input, init] = args as [unknown, { method?: string } | undefined];
  let raw: string | undefined;
  let method = init?.method;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (typeof input === 'object' && input !== null && typeof (input as { url?: unknown }).url === 'string') {
    raw = (input as { url: string }).url;
    method ??= (input as { method?: string }).method;
  }
  if (!raw) return undefined;
  try {
    return { url: new URL(raw), method: (method ?? 'GET').toUpperCase() };
  } catch {
    return undefined;
  }
}

export class HttpInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'HTTP (fetch)';
  protected readonly packages: readonly string[] = [];
  protected override get owner(): string {
    return 'http';
  }

  /** Where this SDK exports to; calls there are not traced. */
  private exportOrigin: string | undefined;


  override instrument(config: OTelConfig): Promise<void> {
    return super.instrument(config).then(() => {
      try {
        this.exportOrigin = config.endpoint ? new URL(config.endpoint).origin : undefined;
      } catch {
        this.exportOrigin = undefined;
      }
      if (typeof (globalThis as { fetch?: unknown }).fetch !== 'function') return;
      // `fetch` is a global, not a package: handed over like any other module.
      const patched = this.instrumentModule(globalThis, config);
      if (patched) logger.info('fetch instrumented for API calls.');
    });
  }

  protected targets(module: unknown): PatchTarget[] {
    if (module !== globalThis) return [];
    return [
      {
        holder: globalThis,
        method: 'fetch',
        wrap: (original: AnyFunction) =>
          this.datastoreWrapper((_instance, args) => {
            const request = requestOf(args);
            if (!request || request.url.origin === this.exportOrigin) return undefined;
            const host = request.url.hostname;
            const provider = providerOf(host);
            return {
              spanName: `api.call.${request.method.toLowerCase()}.${host}`,
              system: 'http',
              operation: request.method.toLowerCase(),
              kind: SpanKind.CLIENT,
              attributes: {
                'net.peer.name': host,
                'url.full': `${request.url.origin}${request.url.pathname}`,
                'http.method': request.method,
                'gen_ai.system': provider,
              },
            };
          }, {
            onResult: (span, result) => {
              const status = typeof result === 'object' && result !== null ? (result as { status?: unknown }).status : undefined;
              if (typeof status === 'number') span.setAttribute('http.status_code', status);
            },
          })(original),
      },
    ];
  }
}
