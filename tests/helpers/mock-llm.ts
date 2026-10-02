import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

const FIXTURES = resolve(__dirname, '../fixtures');

export function fixtureText(path: string): string {
  return readFileSync(resolve(FIXTURES, path), 'utf8');
}

export function fixtureJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(fixtureText(path)) as T;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  /** A JSON body. */
  json?: unknown;
  /** A fixture file; `.sse` files are streamed event by event, `.ndjson` files line by line. */
  fixture?: string;
  /** Milliseconds between streamed events. */
  eventDelayMs?: number;
  /** Stop after this many events and hold the connection open (until the client aborts or the server closes). */
  stallAfterEvents?: number;
  /** Drop the connection after this many events. */
  dropAfterEvents?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export interface MockLlm {
  /** Base URL without a trailing path, e.g. http://127.0.0.1:1234 */
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Queue the reply for the next request. */
  reply(reply: MockReply): void;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function streamEvents(response: ServerResponse, text: string, reply: MockReply, ndjson = false): Promise<void> {
  response.writeHead(reply.status ?? 200, {
    'content-type': ndjson ? 'application/x-ndjson' : 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...reply.headers,
  });
  const separator = ndjson ? '\n' : '\n\n';
  const events = text.split(separator).filter((event) => event.trim() !== '');
  for (let index = 0; index < events.length; index += 1) {
    if (reply.dropAfterEvents !== undefined && index >= reply.dropAfterEvents) {
      response.destroy();
      return;
    }
    if (reply.stallAfterEvents !== undefined && index >= reply.stallAfterEvents) return; // hold open
    if (response.destroyed) return;
    response.write(`${events[index]}${separator}`);
    await sleep(reply.eventDelayMs ?? 2);
  }
  response.end();
}

/**
 * A throwaway HTTP server standing in for a model provider. Replies are queued
 * by the test; requests are recorded.
 */
export async function startMockLlm(): Promise<MockLlm> {
  const queue: MockReply[] = [];
  const requests: RecordedRequest[] = [];
  const open = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    open.add(response);
    response.on('close', () => open.delete(response));
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = { raw };
      }
      requests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body });

      const reply = queue.shift();
      if (!reply) {
        response.writeHead(599, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `mock: no reply queued for ${request.url}` } }));
        return;
      }
      if (reply.fixture?.endsWith('.sse') || reply.fixture?.endsWith('.ndjson')) {
        void streamEvents(response, fixtureText(reply.fixture), reply, reply.fixture.endsWith('.ndjson'));
        return;
      }
      const payload = reply.fixture ? fixtureText(reply.fixture) : JSON.stringify(reply.json ?? {});
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', 'x-request-id': 'req_fixture', ...reply.headers });
      response.end(payload);
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    reply: (reply) => {
      queue.push(reply);
    },
    close: () =>
      new Promise<void>((done) => {
        for (const response of open) response.destroy();
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
