/**
 * `@a2ui/agent` 0.1.0 instrumentation, against the real processor and the real v1 basic catalog.
 */
import { SpanKind, SpanStatusCode, trace, context } from '@opentelemetry/api';
import { A2uiRequestProcessor, DirectJsonFormatFactory } from '@a2ui/agent';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import { afterEach, describe, expect, it } from 'vitest';
import { a2uiAgentInstrumentor } from '../../src/a2ui/agent-instrumentor';
import { startHarness, type Harness } from '../helpers/harness';

const CATALOG = basicCatalog.id;
const createSurface = (surfaceId: string) => ({ version: '1.0', createSurface: { surfaceId, catalogId: CATALOG } });
const updateComponents = (surfaceId: string, components: unknown[]) => ({ version: '1.0', updateComponents: { surfaceId, components } });
const block = (messages: unknown[]) => `<a2ui-json>${JSON.stringify(messages)}</a2ui-json>`;
/** Updates a surface nobody created: the SDK refuses it. */
const ORPHAN = updateComponents('nowhere', [{ id: 'root', component: 'Text', text: 'x' }]);
const good = [createSurface('s1'), updateComponents('s1', [{ id: 'root', component: 'Text', text: 'hello' }])];
const processor = (): A2uiRequestProcessor => new A2uiRequestProcessor([basicCatalog], undefined, new DirectJsonFormatFactory());

let harness: Harness;
afterEach(async () => {
  await harness?.stop();
});

describe('parseResponse', () => {
  it('a valid response: one INTERNAL span with the version, surface, catalog, counts and outcome', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const parts = processor().parseResponse(`Here you go ${block(good)} done`);
    expect(parts.map((part) => part.type)).toEqual(['text', 'a2ui', 'text']);

    const span = harness.span('a2ui.parse_response');
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toEqual({
      'a2ui.protocol.version': '1.0',
      'a2ui.agent_message.count': 2,
      'a2ui.message.types': ['create_surface', 'update_components'],
      'a2ui.surface.id': 's1',
      'a2ui.surface.count': 1,
      'a2ui.catalog.id': CATALOG,
      'a2ui.catalog.ids': [CATALOG],
      'a2ui.component.count': 1,
      'a2ui.validation.outcome': 'valid',
    });
    expect(harness.openSpans()).toEqual([]);
  });

  it('returns exactly what the SDK returned', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const direct = processor();
    const wrapped = direct.parseResponse(block(good));
    expect(wrapped).toEqual([{ type: 'a2ui', a2ui: good }]);
  });

  it('text with no UI: a valid parse with nothing to count', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    processor().parseResponse('just words');
    const span = harness.span('a2ui.parse_response');
    expect(span.attributes).toEqual({ 'a2ui.agent_message.count': 0, 'a2ui.validation.outcome': 'valid' });
  });

  it('the model wrote UI the SDK rejected: ERROR, the error class, invalid - and the error still reaches the caller', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const bad = [updateComponents('missing-surface', [{ id: 'root', component: 'Text', text: 'private text' }])];
    let thrown: unknown;
    try {
      processor().parseResponse(block(bad));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).constructor.name).toBe('A2uiIntegrityError');

    const span = harness.span('a2ui.parse_response');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'A2uiIntegrityError' });
    expect(span.attributes['error.type']).toBe('A2uiIntegrityError');
    expect(span.attributes['a2ui.validation.outcome']).toBe('invalid');
    // The error message can quote the model's output: not on the span without capture.
    expect(JSON.stringify([span.status, span.attributes, span.events])).not.toContain('missing-surface');
    expect(harness.openSpans()).toEqual([]);
  });

  it('JSON that is not JSON is a ParseError', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    expect(() => processor().parseResponse('<a2ui-json>{not json}</a2ui-json>')).toThrow();
    const span = harness.span('a2ui.parse_response');
    expect(span.attributes['error.type']).toBe('ParseError');
    expect(span.attributes['a2ui.validation.outcome']).toBe('invalid');
  });

  it('with content capture the error message and the messages are recorded', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'], enableContentCapture: true, contentMaxLength: 0 });
    expect(() => processor().parseResponse(block([ORPHAN]))).toThrow();
    const failed = harness.span('a2ui.parse_response');
    expect(String(failed.status.message)).toContain('nowhere');
    expect(failed.events.map((event) => event.name)).toContain('exception');

    harness.reset();
    processor().parseResponse(block([createSurface('s1'), updateComponents('s1', [{ id: 'root', component: 'Text', text: 'hi' }])]));
    const ok = harness.span('a2ui.parse_response');
    expect(String(ok.attributes['a2ui.messages'])).toContain('"surfaceId":"s1"');
    expect(ok.attributes['a2ui.component.types']).toEqual(['Text']);
  });

  it('is the parent of nothing it should not be, and a child of the LLM span it ran under', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const llm = trace.getTracer('test').startSpan('llm call');
    context.with(trace.setSpan(context.active(), llm), () => processor().parseResponse(block(good)));
    llm.end();
    const span = harness.span('a2ui.parse_response');
    expect(span.parentSpanContext?.spanId).toBe(llm.spanContext().spanId);
  });
});

describe('openStream', () => {
  const text = `Sure. ${block(good)} Enjoy.`;

  it('one span for the whole stream: it ends at close() and carries the totals', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const stream = processor().openStream();
    const seen = [...stream.feed(text.slice(0, 25)), ...stream.feed(text.slice(25))];
    expect(harness.spans()).toEqual([]);
    expect(harness.openSpans()).toEqual(['a2ui.parse_stream']);
    const rest = stream.close();
    expect([...seen, ...rest].some((part) => part.type === 'a2ui')).toBe(true);

    const span = harness.span('a2ui.parse_stream');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toMatchObject({
      'a2ui.agent_message.count': 2,
      'a2ui.surface.id': 's1',
      'a2ui.component.count': 1,
      'a2ui.validation.outcome': 'valid',
    });
    expect(harness.openSpans()).toEqual([]);
  });

  it('the stream is not made the current span between chunks', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const stream = processor().openStream();
    expect(trace.getActiveSpan()).toBeUndefined();
    stream.feed(text);
    expect(trace.getActiveSpan()).toBeUndefined();
    stream.close();
  });

  it('a rejected block ends the stream: feed throws, the span is ERROR with the class', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const stream = processor().openStream();
    expect(() => stream.feed(block([ORPHAN]))).toThrow();
    const span = harness.span('a2ui.parse_stream');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('A2uiIntegrityError');
    expect(span.attributes['a2ui.validation.outcome']).toBe('invalid');
    expect(harness.openSpans()).toEqual([]);
  });

  it('afterRejectedBlock continue: the stream goes on, and the span is ERROR too (a block failed validation)', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const stream = processor().openStream({ afterRejectedBlock: 'continue' });
    const parts = [...stream.feed(`x ${block([ORPHAN])} y`), ...stream.close()];
    expect(parts.map((part) => part.type)).toEqual(['text', 'error', 'text']);
    const span = harness.span('a2ui.parse_stream');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['a2ui.validation.outcome']).toBe('invalid');
    expect(typeof span.attributes['error.type']).toBe('string');
  });

  it('an unterminated block fails at close()', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    const stream = processor().openStream();
    stream.feed('<a2ui-json>[{"version":"1.0"');
    expect(() => stream.close()).toThrow();
    expect(harness.span('a2ui.parse_stream').attributes['error.type']).toBe('ParseError');
  });

  it('a stream nobody closes still ends its span once it is collected', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    (() => {
      const stream = processor().openStream();
      stream.feed('hello');
    })();
    const collect = (globalThis as { gc?: () => void }).gc;
    if (!collect) return; // test workers run with --expose-gc
    for (let i = 0; i < 20 && harness.openSpans().length > 0; i += 1) {
      collect();
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(harness.openSpans()).toEqual([]);
  });
});

describe('switched off, and not there', () => {
  it('GENAI_A2UI_ENABLED=false: the processor is the SDK\'s again - no span at all', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'], a2uiEnabled: false });
    processor().parseResponse(block(good));
    const stream = processor().openStream();
    stream.feed(block(good));
    stream.close();
    expect(harness.spans()).toEqual([]);
  });

  it('a module that is not the SDK is not patched', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    expect(a2uiAgentInstrumentor().instrumentModule({})).toBe(false);
    expect(a2uiAgentInstrumentor().instrumentModule({ A2uiRequestProcessor: class {} })).toBe(false);
  });

  it('after uninstrument() no span', async () => {
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    await harness.stop();
    processor().parseResponse(block(good));
    harness = await startHarness({ enabledInstrumentors: ['a2ui'] });
    expect(harness.spans()).toEqual([]);
  });
});
