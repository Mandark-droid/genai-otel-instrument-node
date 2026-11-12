/**
 * The public A2UI API through the Node entry, with Node's async context: the active span survives an
 * `await`, so the attributes land on the span the application is in.
 */
import { context, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import * as sdk from '../../src/index';
import { startHarness, type Harness } from '../helpers/harness';

let harness: Harness;
afterEach(async () => {
  await harness?.stop();
});

describe('Node entry', () => {
  it('exports the API, the hand-over functions, the attribute names and the instrumentors', () => {
    for (const name of ['recordA2uiReceived', 'recordA2uiSent', 'recordA2uiRendererError', 'instrumentA2aClient', 'instrumentA2uiAgent', 'instrumentA2uiWebCore'] as const) {
      expect(typeof sdk[name], name).toBe('function');
    }
    expect(sdk.A2UIAttributes.ACTION_NAME).toBe('a2ui.action.name');
    expect(sdk.A2AAttributes.TASK_STATE).toBe('a2a.task.state');
    expect(sdk.DEFAULT_INSTRUMENTORS).toEqual(expect.arrayContaining(['a2a', 'a2ui']));
    expect(sdk.availableInstrumentors()).toEqual(expect.arrayContaining(['a2a', 'a2ui', 'a2ui_web_core']));
  });

  it('the span the application is in, across an await', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    await trace.getTracer('app').startActiveSpan('turn', async (span) => {
      await new Promise((done) => setTimeout(done, 5));
      sdk.recordA2uiSent({ version: '1.0', action: { name: 'approve', surfaceId: 's' } });
      await new Promise((done) => setTimeout(done, 5));
      sdk.recordA2uiRendererError({ code: 'EXPRESSION_ERROR', surfaceId: 's' });
      span.end();
    });
    expect(harness.spans().map((span) => span.name)).toEqual(['turn']);
    expect(harness.span('turn').attributes).toMatchObject({ 'a2ui.action.name': 'approve', 'a2ui.error.codes': ['EXPRESSION_ERROR'], 'a2ui.renderer_message.count': 2 });
  });

  it('a non-recording span is not written to: a short span is opened instead, and ends', async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    const ended = trace.wrapSpanContext({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 });
    context.with(trace.setSpan(context.active(), ended), () => sdk.recordA2uiReceived({ version: '1.0', deleteSurface: { surfaceId: 'gone' } }));
    expect(harness.span('a2ui.receive').attributes).toMatchObject({ 'a2ui.message.types': ['delete_surface'], 'a2ui.surface.id': 'gone' });
    expect(harness.openSpans()).toEqual([]);
  });

  it('GENAI_A2UI_ENABLED=false through instrument(): nothing', async () => {
    harness = await startHarness({ enabledInstrumentors: [], a2uiEnabled: false });
    sdk.recordA2uiReceived({ version: '1.0', deleteSurface: { surfaceId: 'gone' } });
    expect(harness.spans()).toEqual([]);
  });
});
