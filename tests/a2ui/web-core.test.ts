/**
 * The `@a2ui/web_core` renderer adapter, against the real `MessageProcessor` and the v1 basic catalog.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { MessageProcessor } from '@a2ui/web_core';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_INSTRUMENTORS } from '../../src/config';
import { a2uiWebCoreInstrumentor } from '../../src/a2ui/web-core-instrumentor';
import { startHarness, type Harness } from '../helpers/harness';

const CATALOG = basicCatalog.id;
/** Wire-format messages, as an agent sends them: the processor's own types are for the typed messages. */
const wire = (message: unknown): never => message as never;
const createSurface = (surfaceId: string) => wire({ version: '1.0', createSurface: { surfaceId, catalogId: CATALOG } });
const updateComponents = (surfaceId: string, components: unknown[]) => wire({ version: '1.0', updateComponents: { surfaceId, components } });
const text = (id: string, value: string) => ({ id, component: 'Text', text: value });

let harness: Harness;
const start = async (options: Record<string, unknown> = {}): Promise<void> => {
  harness = await startHarness({ enabledInstrumentors: ['a2ui_web_core'], ...options });
};
afterEach(async () => {
  await harness?.stop();
});

describe('one batch applied, one a2ui.apply span', () => {
  it('processMessages: the version, surface, catalog and counts; the duration is the batch', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    processor.processMessages([createSurface('s1'), updateComponents('s1', [text('root', 'hi')])]);

    const span = harness.span('a2ui.apply');
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
    expect([...processor.getSurfaces().keys()]).toEqual(['s1']); // the application's own result is untouched
    expect(harness.openSpans()).toEqual([]);
  });

  it('one message and the message-list wrapper are batches too', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    processor.processMessages(createSurface('a'));
    processor.processMessages({ messages: [createSurface('b'), createSurface('c')] });
    const counts = harness
      .spans()
      .map((span) => span.attributes['a2ui.agent_message.count'])
      .sort();
    expect(counts).toEqual([1, 2]);
  });

  it('processMessagesAsync: the span covers the awaited batch', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    const responses = await processor.processMessagesAsync([createSurface('s1')]);
    expect(responses).toEqual([]);
    expect(harness.span('a2ui.apply').attributes['a2ui.surface.id']).toBe('s1');
    expect(harness.openSpans()).toEqual([]);
  });
});

describe('a batch the renderer rejects', () => {
  const orphan = updateComponents('nowhere', [text('root', 'private text')]);

  it('a thrown error: ERROR, the class, the code as an event, and the error still reaches the caller', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    expect(() => processor.processMessages([orphan])).toThrow();

    const span = harness.span('a2ui.apply');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'A2uiIntegrityError' });
    expect(span.attributes).toMatchObject({
      'error.type': 'A2uiIntegrityError',
      'a2ui.validation.outcome': 'invalid',
      'a2ui.error.codes': ['INTEGRITY_ERROR'],
      'a2ui.error.count': 1,
      'a2ui.surface.id': 'nowhere',
    });
    expect(span.events.map((event) => [event.name, event.attributes])).toContainEqual(['a2ui.error', { 'a2ui.error.code': 'INTEGRITY_ERROR', 'a2ui.surface.id': 'nowhere' }]);
    expect(JSON.stringify([span.attributes, span.events, span.status])).not.toContain('private text');
    expect(harness.openSpans()).toEqual([]);
  });

  it('processMessagesWithErrors returns the errors instead of throwing: the span is still ERROR, and each error is an event', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    const errors = processor.processMessagesWithErrors([orphan, updateComponents('also-nowhere', [text('root', 'x')])]);
    expect(errors).toHaveLength(2);
    const span = harness.span('a2ui.apply');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['a2ui.error.count']).toBe(2);
    expect(span.events.filter((event) => event.name === 'a2ui.error')).toHaveLength(2);
  });

  it('reportErrorsOnly: the application never sees an error, and the span still does', async () => {
    await start();
    const sent: unknown[] = [];
    const processor = new MessageProcessor([basicCatalog], undefined, { reportErrorsOnly: true, errorHandler: (error) => sent.push(error) });
    expect(() => processor.processMessages([orphan])).not.toThrow();
    expect(sent).toHaveLength(1);
    const span = harness.span('a2ui.apply');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['a2ui.error.codes']).toEqual(['INTEGRITY_ERROR']);
  });

  it('processMessagesAsync that rejects: ERROR and the rejection reaches the caller', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    await expect(processor.processMessagesAsync([orphan])).rejects.toThrow();
    expect(harness.span('a2ui.apply').status.code).toBe(SpanStatusCode.ERROR);
    expect(harness.openSpans()).toEqual([]);
  });

  it('one good batch after a bad one is a clean span again', async () => {
    await start();
    const processor = new MessageProcessor([basicCatalog]);
    expect(() => processor.processMessages([orphan])).toThrow();
    processor.processMessages([createSurface('s1')]);
    const spans = harness.spans().filter((span) => span.name === 'a2ui.apply');
    expect(spans.map((span) => span.status.code)).toEqual([SpanStatusCode.ERROR, SpanStatusCode.UNSET]);
    expect(spans[1]?.attributes['a2ui.error.count']).toBeUndefined();
  });

  it('with content capture the message, path and the batch are recorded', async () => {
    await start({ enableContentCapture: true, contentMaxLength: 0 });
    const processor = new MessageProcessor([basicCatalog]);
    processor.processMessagesWithErrors([orphan]);
    const span = harness.span('a2ui.apply');
    expect(span.attributes['a2ui.error.messages']).toEqual(['Surface not found for message: nowhere']);
    expect(String(span.attributes['a2ui.messages'])).toContain('private text');
  });
});

describe('opt-in, switched off and not there', () => {
  it('not in the default list: without naming it nothing is patched', async () => {
    expect(DEFAULT_INSTRUMENTORS).not.toContain('a2ui_web_core');
    harness = await startHarness({ enabledInstrumentors: ['a2a', 'a2ui'] });
    new MessageProcessor([basicCatalog]).processMessages([createSurface('s1')]);
    expect(harness.spans().filter((span) => span.name === 'a2ui.apply')).toEqual([]);
  });

  it('GENAI_A2UI_ENABLED=false: no span', async () => {
    await start({ a2uiEnabled: false });
    new MessageProcessor([basicCatalog]).processMessages([createSurface('s1')]);
    expect(harness.spans()).toEqual([]);
  });

  it('a module that is not web_core is not patched; one that is can be handed over', async () => {
    await start();
    expect(a2uiWebCoreInstrumentor().instrumentModule({})).toBe(false);
    expect(a2uiWebCoreInstrumentor().instrumentModule({ MessageProcessor: class {} })).toBe(false);
  });

  it('after uninstrument() the processor is the SDK\'s again', async () => {
    await start();
    await harness.stop();
    new MessageProcessor([basicCatalog]).processMessages([createSurface('s1')]);
    await start();
    expect(harness.spans()).toEqual([]);
  });
});
