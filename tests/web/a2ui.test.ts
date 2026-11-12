/**
 * A2UI through the browser and React Native entries (Node project and browser-like project): the
 * public API, and handing the A2A client, `@a2ui/agent` and `@a2ui/web_core` over to be traced,
 * which is how they are reached where a package cannot be looked up by name.
 */
import { context, metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import * as web from '../../src/index.browser';
import * as native from '../../src/index.react-native';
import { setLogger } from '../../src/logger';

const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

type Sdk = typeof web | typeof native;

function start(sdk: Sdk, options: Record<string, unknown> = {}): InMemorySpanExporter {
  setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  const exporter = new InMemorySpanExporter();
  const handle = sdk.instrument({
    serviceName: 'a2ui-web-test',
    endpoint: 'https://collector.example',
    fetch: okFetch,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    ...options,
  });
  if (!handle) throw new Error('instrument() failed');
  return exporter;
}

const named = (exporter: InMemorySpanExporter, name: string): ReadableSpan => {
  const found = exporter.getFinishedSpans().filter((span) => span.name === name);
  if (found.length !== 1) throw new Error(`expected one ${name}, found ${found.length} among ${exporter.getFinishedSpans().map((s) => s.name).join(', ')}`);
  return found[0] as ReadableSpan;
};

afterEach(async () => {
  await web.uninstrument(0.2);
  await native.uninstrument(0.2);
  trace.disable();
  metrics.disable();
  setLogger(undefined);
});

describe.each([
  ['browser', web],
  ['React Native', native],
] as const)('%s entry: the public API', (_label, sdk) => {
  const surface = [
    { version: '1.0', createSurface: { surfaceId: 'trip', catalogId: CATALOG } },
    { version: '1.0', updateComponents: { surfaceId: 'trip', components: [{ id: 'root', component: 'Image', url: 'https://cdn.example/a.png' }] } },
  ];

  it('exports the three functions and the three hand-over functions', () => {
    for (const name of ['recordA2uiReceived', 'recordA2uiSent', 'recordA2uiRendererError', 'instrumentA2aClient', 'instrumentA2uiAgent', 'instrumentA2uiWebCore'] as const) {
      expect(typeof sdk[name], name).toBe('function');
    }
  });

  it('with no span active: a short INTERNAL span for each call', () => {
    const exporter = start(sdk);
    sdk.recordA2uiReceived(surface);
    sdk.recordA2uiSent({ version: '1.0', action: { name: 'book', surfaceId: 'trip', context: { who: 'Ada' } } });
    sdk.recordA2uiRendererError({ code: 'UNALLOWED_CHILD', surfaceId: 'trip', path: '/components/1', message: 'a Button cannot hold a Text' });

    const received = named(exporter, 'a2ui.receive');
    expect(received.kind).toBe(SpanKind.INTERNAL);
    // (the SDK's OpenInference processor adds `openinference.span.kind` to every span)
    expect(received.attributes).toMatchObject({
      'a2ui.protocol.version': '1.0',
      'a2ui.agent_message.count': 2,
      'a2ui.message.types': ['create_surface', 'update_components'],
      'a2ui.surface.id': 'trip',
      'a2ui.surface.count': 1,
      'a2ui.catalog.id': CATALOG,
      'a2ui.catalog.ids': [CATALOG],
      'a2ui.component.count': 1,
    });
    const sent = named(exporter, 'a2ui.send action');
    expect(sent.attributes).toMatchObject({ 'a2ui.renderer_message.count': 1, 'a2ui.action.name': 'book', 'a2ui.surface.id': 'trip' });
    const failed = named(exporter, 'a2ui.renderer_error');
    expect(failed.status.code).toBe(SpanStatusCode.UNSET);
    expect(failed.attributes).toMatchObject({ 'a2ui.error.codes': ['UNALLOWED_CHILD'], 'a2ui.error.count': 1, 'a2ui.surface.id': 'trip' });
    expect(failed.events.map((event) => [event.name, event.attributes])).toEqual([['a2ui.error', { 'a2ui.error.code': 'UNALLOWED_CHILD', 'a2ui.surface.id': 'trip' }]]);
  });

  it('with a span active the attributes go on it, and calls on one span accumulate', () => {
    const exporter = start(sdk);
    const span = trace.getTracer('app').startSpan('handle agent turn');
    context.with(trace.setSpan(context.active(), span), () => {
      sdk.recordA2uiReceived(surface);
      sdk.recordA2uiSent({ version: '1.0', action: { name: 'book', surfaceId: 'trip' } });
      sdk.recordA2uiRendererError(new (class A2uiValidationError extends Error {
        readonly code = 'VALIDATION_FAILED';
        readonly surfaceId = 'trip';
      })('bad'));
      sdk.recordA2uiRendererError({ version: '1.0', error: { code: 'EXECUTION_ERROR', message: 'x' } });
    });
    span.end();

    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['handle agent turn']); // no extra spans
    const done = named(exporter, 'handle agent turn');
    expect(done.attributes).toMatchObject({
      'a2ui.agent_message.count': 2,
      'a2ui.renderer_message.count': 3,
      'a2ui.message.types': ['action', 'create_surface', 'error', 'update_components'],
      'a2ui.action.name': 'book',
      'a2ui.error.count': 2,
      'a2ui.error.codes': ['EXECUTION_ERROR', 'VALIDATION_FAILED'],
    });
    // One event per error, never repeated by a later call.
    expect(done.events.map((event) => event.attributes?.['a2ui.error.code'])).toEqual(['VALIDATION_FAILED', 'EXECUTION_ERROR']);
    expect(done.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('content only with capture on; media URLs never', () => {
    const quiet = start(sdk);
    sdk.recordA2uiReceived(surface);
    sdk.recordA2uiSent({ version: '1.0', action: { name: 'go', context: { secret: 'value' } } });
    const text = JSON.stringify(quiet.getFinishedSpans().map((span) => span.attributes));
    expect(text).not.toContain('cdn.example');
    expect(text).not.toContain('secret');
    expect(Object.keys(named(quiet, 'a2ui.receive').attributes)).not.toContain('a2ui.messages');
  });

  it('with capture: the messages, redacted; the action context; the error message', async () => {
    await sdk.uninstrument(0.2);
    const exporter = start(sdk, { GENAI_ENABLE_CONTENT_CAPTURE: 'true', GENAI_CONTENT_MAX_LENGTH: '0' });
    sdk.recordA2uiReceived(surface);
    sdk.recordA2uiSent({ version: '1.0', action: { name: 'go', context: { k: 'v' } } });
    sdk.recordA2uiRendererError(new Error('quoted private text'));
    const received = named(exporter, 'a2ui.receive');
    expect(String(received.attributes['a2ui.messages'])).toContain('"url":"[redacted]"');
    expect(String(received.attributes['a2ui.messages'])).not.toContain('cdn.example');
    expect(named(exporter, 'a2ui.send action').attributes['a2ui.action.context']).toBe('[{"k":"v"}]');
    const failed = named(exporter, 'a2ui.renderer_error');
    expect(failed.attributes['a2ui.error.codes']).toEqual(['Error']);
    expect(failed.attributes['a2ui.error.messages']).toEqual(['quoted private text']);
  });

  it('the message-list wrapper is read as its messages', () => {
    const exporter = start(sdk);
    sdk.recordA2uiReceived({ messages: surface });
    expect(named(exporter, 'a2ui.receive').attributes['a2ui.agent_message.count']).toBe(2);
  });

  it('GENAI_A2UI_ENABLED=false: nothing is recorded, anywhere', () => {
    const exporter = start(sdk, { GENAI_A2UI_ENABLED: 'false' });
    sdk.recordA2uiReceived(surface);
    sdk.recordA2uiSent({ version: '1.0', action: { name: 'x' } });
    sdk.recordA2uiRendererError(new Error('x'));
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('before instrument(), and on anything at all, it never throws', () => {
    expect(() => sdk.recordA2uiReceived(surface)).not.toThrow();
    for (const bad of [undefined, null, 5, 'x', [], {}, [null], Symbol.iterator]) {
      expect(() => sdk.recordA2uiReceived(bad)).not.toThrow();
      expect(() => sdk.recordA2uiSent(bad)).not.toThrow();
      expect(() => sdk.recordA2uiRendererError(bad)).not.toThrow();
    }
  });
});

describe('handing a library over (browsers and React Native cannot look one up by name)', () => {
  it('@a2ui/web_core: the renderer adapter, from either entry', async () => {
    const exporter = start(web);
    const webCore = await import('@a2ui/web_core');
    const { basicCatalog } = await import('@a2ui/web_core/catalogs/basic/v1');
    expect(web.instrumentA2uiWebCore(webCore)).toBe(true);
    const processor = new webCore.MessageProcessor([basicCatalog]);
    processor.processMessages([{ version: '1.0', createSurface: { surfaceId: 's1', catalogId: basicCatalog.id } }]);
    expect(() => processor.processMessages([{ version: '1.0', updateComponents: { surfaceId: 'zz', components: [{ id: 'root', component: 'Text', text: 'x' }] } }])).toThrow();
    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'a2ui.apply');
    expect(spans.map((span) => span.status.code)).toEqual([SpanStatusCode.UNSET, SpanStatusCode.ERROR]);
    expect(spans[1]?.attributes['a2ui.error.codes']).toEqual(['INTEGRITY_ERROR']);
    // Handing it over twice does not wrap twice: one batch is still one span.
    expect(native.instrumentA2uiWebCore(webCore)).toBe(true);
    exporter.reset();
    processor.processMessages([{ version: '1.0', createSurface: { surfaceId: 's2', catalogId: basicCatalog.id } }]);
    expect(exporter.getFinishedSpans().filter((span) => span.name === 'a2ui.apply')).toHaveLength(1);
  });

  it('@a2ui/agent', async () => {
    const exporter = start(native);
    const agent = await import('@a2ui/agent');
    const { basicCatalog } = await import('@a2ui/web_core/catalogs/basic/v1');
    expect(native.instrumentA2uiAgent(agent)).toBe(true);
    const processor = new agent.A2uiRequestProcessor([basicCatalog], undefined, new agent.DirectJsonFormatFactory());
    processor.parseResponse(`<a2ui-json>${JSON.stringify([{ version: '1.0', createSurface: { surfaceId: 's1', catalogId: basicCatalog.id } }])}</a2ui-json>`);
    expect(named(exporter, 'a2ui.parse_response').attributes['a2ui.validation.outcome']).toBe('valid');
  });

  it('the A2A client: a class shaped like the SDK\'s, and its calls carry the trace context', async () => {
    const exporter = start(web);
    const seen: { serviceParameters?: Record<string, string> }[] = [];
    class Client {
      transport = { protocolName: 'JSONRPC', protocolVersion: '1.0' };
      agentCard = {
        name: 'planner',
        description: '',
        version: '1',
        supportedInterfaces: [{ url: 'https://planner.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: {},
        skills: [],
      };
      getTask(_params: unknown, options?: { serviceParameters?: Record<string, string> }): Promise<unknown> {
        seen.push(options ?? {});
        return Promise.resolve({ id: 't-1', contextId: 'c-1', status: { state: 3 }, artifacts: [] });
      }
    }
    expect(web.instrumentA2aClient({ Client })).toBe(true);
    await new Client().getTask({ id: 't-1' });
    const span = named(exporter, 'GetTask planner');
    expect(span.attributes).toMatchObject({ 'a2a.task.id': 't-1', 'a2a.task.state': 'completed', 'a2a.protocol.binding': 'jsonrpc', 'server.address': 'planner.example' });
    expect(seen[0]?.serviceParameters?.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });

  it('modules that are not the libraries are refused, and nothing throws', () => {
    start(web);
    for (const bad of [undefined, null, {}, 5, 'x']) {
      expect(web.instrumentA2aClient(bad)).toBe(false);
      expect(web.instrumentA2uiAgent(bad)).toBe(false);
      expect(web.instrumentA2uiWebCore(bad)).toBe(false);
    }
  });
});
