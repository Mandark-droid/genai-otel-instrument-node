/**
 * Session scope: every span started inside `withSession()` - or after
 * `setSession()` - carries the session id the platform groups a run by.
 */
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentSession, SessionSpanProcessor, setSession, withSession } from '../../src/session';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let manager: AsyncLocalStorageContextManager;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SessionSpanProcessor(), new SimpleSpanProcessor(exporter)] });
  manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
});
afterEach(async () => {
  setSession(undefined);
  context.disable();
  manager.disable();
  await provider.shutdown();
});

const span = (name: string): void => provider.getTracer('any.instrumentation').startSpan(name).end();
const attributesOf = (name: string): Record<string, unknown> => {
  const found = exporter.getFinishedSpans().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no span ${name}`);
  return found.attributes;
};

describe('withSession', () => {
  it('puts session.id and gen_ai.conversation.id on every span started in scope, whoever starts it', () => {
    withSession('s-1', () => span('inside'));
    span('outside');
    expect(attributesOf('inside')).toEqual({ 'session.id': 's-1', 'gen_ai.conversation.id': 's-1' });
    expect(attributesOf('outside')).toEqual({});
  });

  it('returns what the function returns and holds across await', async () => {
    const value = await withSession('s-2', async () => {
      await new Promise((done) => setTimeout(done, 5));
      span('after-await');
      return 42;
    });
    expect(value).toBe(42);
    expect(attributesOf('after-await')['session.id']).toBe('s-2');
  });

  it('carries a user id when given one', () => {
    withSession('s-3', () => span('with-user'), { userId: 'u-9' });
    expect(attributesOf('with-user')).toEqual({ 'session.id': 's-3', 'gen_ai.conversation.id': 's-3', 'user.id': 'u-9' });
  });

  it('the inner scope wins when nested, and the outer one resumes', () => {
    withSession('outer', () => {
      withSession('inner', () => span('nested'));
      span('resumed');
    });
    expect(attributesOf('nested')['session.id']).toBe('inner');
    expect(attributesOf('resumed')['session.id']).toBe('outer');
  });

  it('rethrows, and concurrent scopes do not leak into each other', async () => {
    expect(() =>
      withSession('s-4', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        withSession(id, async () => {
          await new Promise((done) => setTimeout(done, Math.random() * 10));
          span(`span-${id}`);
        }),
      ),
    );
    for (const id of ['a', 'b', 'c']) expect(attributesOf(`span-${id}`)['session.id']).toBe(id);
  });

  it('an empty id sets nothing', () => {
    withSession('', () => span('empty'));
    expect(attributesOf('empty')).toEqual({});
  });
});

describe('setSession', () => {
  it('is the default for spans outside any withSession scope, until cleared', () => {
    setSession('app-session', { userId: 'u-1' });
    span('default');
    withSession('scoped', () => span('scoped'));
    setSession(undefined);
    span('cleared');
    expect(attributesOf('default')).toEqual({ 'session.id': 'app-session', 'gen_ai.conversation.id': 'app-session', 'user.id': 'u-1' });
    // A scope replaces the default whole: the default's user does not leak into it.
    expect(attributesOf('scoped')).toEqual({ 'session.id': 'scoped', 'gen_ai.conversation.id': 'scoped' });
    expect(attributesOf('cleared')).toEqual({});
  });

  it('currentSession reports what is in force', () => {
    expect(currentSession()).toEqual({});
    setSession('app');
    expect(currentSession()).toEqual({ sessionId: 'app' });
    withSession('s', () => expect(currentSession()).toEqual({ sessionId: 's' }));
  });
});

describe('SessionSpanProcessor', () => {
  it('does not overwrite a session id the span was started with', () => {
    withSession('scope', () => {
      provider.getTracer('x').startSpan('explicit', { attributes: { 'session.id': 'explicit' } }).end();
    });
    expect(attributesOf('explicit')['session.id']).toBe('explicit');
    expect(attributesOf('explicit')['gen_ai.conversation.id']).toBe('scope');
  });

  it('flushes and shuts down as a no-op', async () => {
    const processor = new SessionSpanProcessor();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
    expect(trace.getTracer('x')).toBeDefined();
  });
});
