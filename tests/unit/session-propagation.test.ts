/**
 * Session propagation (Python 1.45.0) and session baggage (1.46.0): the Python library's
 * tests/test_sessions.py cases that apply here, ported.
 */
import {
  context,
  createContextKey,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogger } from '../../src/logger';
import {
  configureSessionPropagation,
  parseBaggageKeys,
  SessionBaggagePropagator,
  SessionSpanProcessor,
  setSession,
  warnIfPropagatorReplaced,
  withSession,
} from '../../src/session';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SessionSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('test');
const attrs = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name)!.attributes;
/** A span with `attributes`, running `body` with it current. */
function span(name: string, attributes: Record<string, string> = {}, body?: () => void) {
  const s = tracer.startSpan(name, { attributes });
  context.with(trace.setSpan(context.active(), s), () => body?.());
  s.end();
}

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
});

beforeEach(() => {
  exporter.reset();
  setSession(undefined);
  configureSessionPropagation({});
});

afterEach(() => setLogger(undefined));

describe('session propagation', () => {
  it('a framework session reaches every child span, the span that owns it included', () => {
    span('graph', { 'session.id': 'thread-9' }, () => span('node', {}, () => span('llm')));
    for (const name of ['graph', 'node', 'llm']) {
      expect(attrs(name)['session.id']).toBe('thread-9');
      expect(attrs(name)['gen_ai.conversation.id']).toBe('thread-9');
    }
  });

  it('a session block wins over the parent span, and existing keys are never overwritten', () => {
    span('graph', { 'session.id': 'thread-9' }, () =>
      withSession('conv-1', () => {
        span('inside');
        span('own', { 'session.id': 'mine', 'gen_ai.conversation.id': 'thread' });
      }),
    );
    expect(attrs('inside')['session.id']).toBe('conv-1');
    expect(attrs('own')).toMatchObject({ 'session.id': 'mine', 'gen_ai.conversation.id': 'thread' });
  });

  it('nested blocks restore the outer session, also after an error', () => {
    withSession('outer', () => {
      withSession('inner', () => span('a'));
      span('b');
      expect(() => withSession('failing', () => { throw new Error('x'); })).toThrow('x');
      span('c');
    });
    expect([attrs('a'), attrs('b'), attrs('c')].map((a) => a['session.id'])).toEqual(['inner', 'outer', 'outer']);
  });

  it('async tasks keep their own session', async () => {
    await Promise.all(
      ['one', 'two'].map((id) =>
        withSession(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'one' ? 10 : 1));
          span(`task-${id}`);
        }),
      ),
    );
    expect(attrs('task-one')['session.id']).toBe('one');
    expect(attrs('task-two')['session.id']).toBe('two');
  });

  it('OpenInference setSession / setUser context values are honoured, read by key name', () => {
    const ctx = ROOT_CONTEXT.setValue(createContextKey('OpenInference SDK Context Key session.id'), 'oi-session').setValue(
      createContextKey('OpenInference SDK Context Key user.id'),
      'oi-user',
    );
    context.with(ctx, () => span('oi'));
    expect(attrs('oi')).toMatchObject({ 'session.id': 'oi-session', 'user.id': 'oi-user', 'gen_ai.conversation.id': 'oi-session' });
  });

  it('GENAI_ENABLE_SESSION_PROPAGATION=false: no inheritance from the parent; explicit sessions still apply', () => {
    configureSessionPropagation({ enabled: false });
    span('graph', { 'session.id': 'thread-9' }, () => span('child'));
    withSession('explicit', () => span('scoped'));
    expect('session.id' in attrs('child')).toBe(false);
    expect(attrs('scoped')['session.id']).toBe('explicit');
  });
});

describe('session baggage', () => {
  const propagator = new SessionBaggagePropagator();
  const inject = (ctx = context.active()) => {
    const carrier: Record<string, string> = {};
    propagator.inject(ctx, carrier, defaultTextMapSetter);
    return carrier.baggage ?? '';
  };
  const extract = (header: string) => propagator.extract(ROOT_CONTEXT, { baggage: header }, defaultTextMapGetter);

  it.each([
    [undefined, []],
    ['', []],
    ['session.id', ['session.id']],
    [' user.id , session.id, other ', ['session.id', 'user.id']],
  ])('parseBaggageKeys(%j)', (raw, expected) => expect(parseBaggageKeys(raw)).toEqual(expected));

  it('nothing crosses by default; sent ids follow the send list', () => {
    withSession('s-1', () => expect(inject()).toBe(''), { userId: 'u-1' });
    configureSessionPropagation({ send: ['session.id'] });
    withSession('s-1', () => expect(inject()).toBe('session.id=s-1'), { userId: 'u-1' });
  });

  it('a service that accepts inbound session ids tags its spans; one that does not ignores them', () => {
    configureSessionPropagation({ accept: ['session.id'] });
    context.with(extract('session.id=upstream,user.id=u-9'), () => span('accepted'));
    configureSessionPropagation({});
    context.with(extract('session.id=upstream'), () => span('ignored'));
    expect(attrs('accepted')['session.id']).toBe('upstream');
    expect('user.id' in attrs('accepted')).toBe(false);
    expect('session.id' in attrs('ignored')).toBe(false);
  });

  it.each(['x'.repeat(257), 'bad\u0007id'])('an invalid inbound id is dropped (%#)', (value) => {
    configureSessionPropagation({ accept: ['session.id'] });
    const ctx = extract(`session.id=${encodeURIComponent(value)}`);
    expect(propagation.getBaggage(ctx)?.getEntry('session.id')).toBeUndefined();
  });

  it('inbound ids are not forwarded unless sent; other baggage passes through', () => {
    configureSessionPropagation({ accept: ['session.id'] });
    const ctx = extract('session.id=upstream,tenant=acme');
    expect(inject(ctx)).toBe('tenant=acme');
  });

  it('a session block replaces inherited ids in baggage', () => {
    configureSessionPropagation({ accept: ['session.id', 'user.id'], send: ['session.id'] });
    context.with(extract('session.id=upstream,user.id=u-9'), () =>
      withSession('mine', () => expect(inject()).toBe('session.id=mine')),
    );
  });

  it("an inbound session ranks below the service's own", () => {
    configureSessionPropagation({ accept: ['session.id'] });
    context.with(extract('session.id=upstream'), () => {
      withSession('own', () => span('scoped'));
      span('parent', { 'session.id': 'framework' }, () => span('child'));
    });
    expect(attrs('scoped')['session.id']).toBe('own');
    expect(attrs('child')['session.id']).toBe('framework');
  });

  it('warns once when the propagator is replaced; not when ours is installed or baggage is off', () => {
    const warn = vi.fn();
    setLogger({ debug: () => {}, info: () => {}, warn, error: () => {} });
    expect(warnIfPropagatorReplaced()).toBe(false); // baggage off
    configureSessionPropagation({ send: ['session.id'] });
    propagation.setGlobalPropagator(
      new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new SessionBaggagePropagator()] }),
    );
    expect(warnIfPropagatorReplaced()).toBe(false);
    propagation.disable();
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    expect(warnIfPropagatorReplaced()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    propagation.disable();
  });
});
