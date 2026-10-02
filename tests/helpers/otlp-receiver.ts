import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeMetricsRequest, decodeTraceRequest, type DecodedMetric, type DecodedSpan } from './otlp-decode';

export interface OtlpReceiver {
  url: string;
  spans: DecodedSpan[];
  metrics: DecodedMetric[];
  requests: { path: string; contentType: string }[];
  close(): Promise<void>;
}

/** A throwaway OTLP/HTTP receiver that decodes protobuf export requests. */
export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const spans: DecodedSpan[] = [];
  const metrics: DecodedMetric[] = [];
  const requests: { path: string; contentType: string }[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const path = request.url ?? '';
      requests.push({ path, contentType: String(request.headers['content-type'] ?? '') });
      try {
        if (path === '/v1/traces') spans.push(...decodeTraceRequest(body));
        else if (path === '/v1/metrics') metrics.push(...decodeMetricsRequest(body));
      } catch (error) {
        response.writeHead(400);
        response.end(String(error));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    spans,
    metrics,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A TCP port that nothing is listening on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
