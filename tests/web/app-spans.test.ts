/**
 * Spans for an application's own components (agent loop, tool dispatcher, retrieval, pipelines),
 * through the React Native entry, where context crosses `await` only through the SDK's context
 * manager.
 */
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import * as native from '../../src/index.react-native';
import { setLogger } from '../../src/logger';

const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

function start(options: Record<string, unknown> = {}): InMemorySpanExporter {
  setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  const exporter = new InMemorySpanExporter();
  native.instrument({
    serviceName: 'app-spans-test',
    endpoint: 'https://collector.example',
    fetch: okFetch,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    ...options,
  });
  return exporter;
}

const named = (exporter: InMemorySpanExporter, name: string): ReadableSpan => {
  const found = exporter.getFinishedSpans().find((span) => span.name === name);
  if (!found) throw new Error(`no ${name} among ${exporter.getFinishedSpans().map((s) => s.name).join(', ')}`);
  return found;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

afterEach(async () => {
  await native.uninstrument(0.2);
  trace.disable();
  metrics.disable();
  setLogger(undefined);
});

describe('application spans', () => {
  it('an agent run is the parent of its tool calls and searches, across await', async () => {
    const exporter = start();
    const reply = await native.traceAgent('assistant', { id: 'run-1', input: 'weather in Paris?', output: (r: string) => r }, async () => {
      await tick();
      const docs = await native.traceRetrieval(
        'notes',
        { query: 'Paris', system: 'sqlite', topK: 3, documents: (hits: { id: string; score: number; text: string }[]) => hits.map((h) => ({ id: h.id, score: h.score, content: h.text })) },
        async () => [
          { id: 'n1', score: 4.2, text: 'Paris is sunny' },
          { id: 'n2', score: 1.1, text: 'Lyon is rainy' },
        ],
      );
      await tick();
      const weather = await native.traceTool('get_weather', { callId: 'c1', description: 'Gets the weather for a city.', arguments: { city: 'Paris' } }, async () => ({ ok: true, temp: 21 }));
      return `${docs.length} notes, ${weather.temp} degrees`;
    });
    expect(reply).toBe('2 notes, 21 degrees');

    const run = named(exporter, 'invoke_agent assistant');
    const search = named(exporter, 'retrieve notes');
    const tool = named(exporter, 'execute_tool get_weather');
    for (const child of [search, tool]) {
      expect(child.spanContext().traceId).toBe(run.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    }
    expect(run.attributes).toMatchObject({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'assistant', 'gen_ai.agent.id': 'run-1', 'openinference.span.kind': 'AGENT' });
    expect(tool.attributes).toMatchObject({ 'gen_ai.tool.name': 'get_weather', 'gen_ai.tool.call.id': 'c1', 'gen_ai.tool.description': 'Gets the weather for a city.', 'gen_ai.tool.type': 'function', 'openinference.span.kind': 'TOOL' });
    expect(search.attributes).toMatchObject({
      'openinference.span.kind': 'RETRIEVER',
      'db.collection.name': 'notes',
      'db.system.name': 'sqlite',
      'db.vector.query.top_k': 3,
      'db.response.returned_rows': 2,
      'rag.result.score_max': 4.2,
      'retrieval.documents.0.document.id': 'n1',
      'retrieval.documents.0.document.score': 4.2,
      'retrieval.documents.1.document.id': 'n2',
    });
  });

  it('content only with enableContentCapture: ids, scores and names are always there', async () => {
    let exporter = start();
    await native.traceTool('get_weather', { arguments: { city: 'Paris' } }, async () => ({ temp: 21 }));
    await native.traceRetrieval('notes', { query: 'Paris', documents: () => [{ id: 'n1', score: 1, content: 'Paris is sunny' }] }, async () => null);
    const bare = [named(exporter, 'execute_tool get_weather'), named(exporter, 'retrieve notes')].flatMap((s) => Object.keys(s.attributes));
    const content = ['gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'retrieval.query', 'retrieval.documents.0.document.content'];
    expect(bare.filter((k) => content.includes(k))).toEqual([]);
    expect(bare).toContain('retrieval.documents.0.document.id');
    await native.uninstrument(0.2);
    trace.disable();

    exporter = start({ enableContentCapture: true, contentMaxLength: 1000 });
    await native.traceTool('get_weather', { arguments: { city: 'Paris' }, result: (r: { temp: number }) => r.temp }, async () => ({ temp: 21 }));
    await native.traceRetrieval('notes', { query: 'Paris', documents: () => [{ id: 'n1', score: 1, content: 'Paris is sunny' }] }, async () => null);
    expect(named(exporter, 'execute_tool get_weather').attributes).toMatchObject({ 'gen_ai.tool.call.arguments': '{"city":"Paris"}', 'gen_ai.tool.call.result': '21' });
    expect(named(exporter, 'retrieve notes').attributes).toMatchObject({ 'retrieval.query': 'Paris', 'retrieval.documents.0.document.content': 'Paris is sunny' });
  });

  it('MCP tools are tagged; failures reported in the result or thrown end the span in error', async () => {
    const exporter = start();
    await native.traceTool('search_repos', { mcpServer: 'hub', failure: (r: { ok: boolean }) => (r.ok ? undefined : 'rate_limited') }, async () => ({ ok: false }));
    await expect(native.traceWorkflow('ingest', {}, async () => { throw new TypeError('bad file'); })).rejects.toThrow('bad file');
    const mcp = named(exporter, 'execute_tool search_repos');
    expect(mcp.attributes).toMatchObject({ 'gen_ai.tool.type': 'extension', 'mcp.server.name': 'hub', 'mcp.method.name': 'tools/call', 'error.type': 'rate_limited' });
    expect(mcp.status.code).toBe(SpanStatusCode.ERROR);
    const ingest = named(exporter, 'ingest');
    expect(ingest.attributes).toMatchObject({ 'openinference.span.kind': 'CHAIN', 'error.type': 'TypeError' });
    // Without content capture the message (which may quote content) stays out.
    expect(ingest.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'TypeError' });
  });

  it('a finished trace is exported at once, without waiting for the batch timer', async () => {
    const posted: string[] = [];
    const capture = (async (url: unknown) => {
      posted.push(String(url));
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    start({ fetch: capture, spanProcessors: [] });
    await native.traceAgent('assistant', {}, async () => {
      await native.traceTool('get_weather', {}, async () => 1);
      await tick();
      // Child ended: nothing sent yet.
      expect(posted.filter((u) => u.endsWith('/v1/traces'))).toHaveLength(0);
      return 'ok';
    });
    await tick();
    expect(posted.filter((u) => u.endsWith('/v1/traces')).length).toBeGreaterThanOrEqual(1);
  });

  it('additional destinations get the same telemetry with their own headers', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const warnings: string[] = [];
    const capture = (async (url: unknown, init: { headers: Record<string, string>; body: string | Uint8Array }) => {
      calls.push({ url: String(url), headers: init.headers, body: typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body) });
      return { ok: !String(url).startsWith('https://second.example'), status: String(url).startsWith('https://second.example') ? 401 : 200 };
    }) as unknown as typeof fetch;
    start({
      fetch: capture,
      spanProcessors: [],
      headers: { authorization: 'Bearer main' },
      additionalDestinations: [{ endpoint: 'https://second.example/', headers: { api_key: 'k2' } }],
    });
    setLogger({ debug: () => {}, info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} });
    await native.traceWorkflow('ingest', {}, async () => 1);
    await tick();
    await tick();
    const traces = calls.filter((c) => c.url.endsWith('/v1/traces'));
    expect(traces.map((c) => c.url).sort()).toEqual(['https://collector.example/v1/traces', 'https://second.example/v1/traces']);
    const second = traces.find((c) => c.url.startsWith('https://second.example'))!;
    const main = traces.find((c) => c.url.startsWith('https://collector.example'))!;
    expect(second.body).toBe(main.body);
    expect(second.headers.api_key).toBe('k2');
    expect(Object.keys(second.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(warnings.some((w) => w.includes('second.example') && w.includes('401'))).toBe(true);
  });

  it('starts without react-native or cactus-react-native installed', () => {
    expect(() => start()).not.toThrow();
    expect(native.isInstrumented()).toBe(true);
  });
});
