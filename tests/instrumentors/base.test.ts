/**
 * BaseInstrumentor behaviours that the provider tests do not reach: the helper
 * functions, the generic (non-SDK) call shapes, and the "never break the host"
 * paths.
 */
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type OTelConfig } from '../../src/config';
import {
  BaseInstrumentor,
  clearBaseUrlClaims,
  clientBaseUrl,
  errorTypeName,
  findBaseUrlClaim,
  registerBaseUrlClaim,
  requestParameterAttributes,
  serverAttributes,
  type AttributeExtractor,
  type UsageDict,
} from '../../src/instrumentors/base';
import { extractBudgetAttributes } from '../../src/agent-budget';
import { startHarness, type Harness } from '../helpers/harness';

class TestInstrumentor extends BaseInstrumentor {
  usage: UsageDict | null = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  estimate: UsageDict | null = null;
  bypass = false;

  instrument(config: OTelConfig): void {
    this.setupConfig(config);
    this.instrumented = true;
  }
  uninstrument(): void {
    this.instrumented = false;
  }
  detachConfig(): void {
    this.config = undefined;
  }
  protected override extractUsage(result: unknown): UsageDict | null {
    return typeof result === 'object' && result !== null && 'chunk' in result ? null : this.usage;
  }
  protected override estimateUsage(): UsageDict | null {
    return this.estimate;
  }
  protected override shouldBypass(): boolean {
    return this.bypass;
  }
  wrap<F extends (...args: never[]) => unknown>(name: string, original: F, extract?: AttributeExtractor): F {
    return this.createSpanWrapper(name, extract)(original);
  }
  firstMessage(messages: unknown): string | null {
    return this.buildFirstMessage(messages);
  }
  aliases(attributes: Record<string, unknown>): Record<string, unknown> {
    return this.withProviderAliases(attributes);
  }
}

const MODEL_ATTRS: AttributeExtractor = (_instance, _args, params) => ({
  'gen_ai.system': 'test',
  'gen_ai.request.model': params.model ?? 'unknown',
});

describe('helpers', () => {
  afterEach(() => clearBaseUrlClaims());

  it('serverAttributes: host and port from the client base URL, wherever the client hangs', () => {
    expect(serverAttributes({ baseURL: 'https://api.openai.com/v1' })).toEqual({ 'server.address': 'api.openai.com', 'server.port': 443 });
    expect(serverAttributes({ _client: { baseURL: 'http://vllm.internal:8000/v1' } })).toEqual({
      'server.address': 'vllm.internal',
      'server.port': 8000,
    });
    expect(serverAttributes({ _client: { _client: { baseURL: 'http://gateway/v1' } } })).toEqual({
      'server.address': 'gateway',
      'server.port': 80,
    });
    expect(serverAttributes({ baseURL: 'http://[::1]:11434/v1' })).toEqual({ 'server.address': '::1', 'server.port': 11434 });
    expect(serverAttributes({ baseURL: new URL('https://EXAMPLE.com:8443') })).toEqual({ 'server.address': 'example.com', 'server.port': 8443 });
  });

  it('serverAttributes: nothing when no base URL can be observed - never a guessed vendor host', () => {
    expect(serverAttributes({})).toEqual({});
    expect(serverAttributes(undefined)).toEqual({});
    expect(serverAttributes({ baseURL: 'not a url' })).toEqual({});
    expect(serverAttributes({ _client: null })).toEqual({});
    expect(serverAttributes({ baseURL: 'unix://socket' })).toEqual({ 'server.address': 'socket' });
    expect(clientBaseUrl({ _client: { baseURL: 'x' } })).toBe('x');
  });

  it('requestParameterAttributes: only what the caller passed', () => {
    expect(requestParameterAttributes({})).toEqual({});
    expect(requestParameterAttributes({ seed: 7, stream: 0, top_k: 40.5, n: 2 })).toEqual({
      'gen_ai.request.seed': 7,
      'gen_ai.request.stream': false,
      'gen_ai.request.top_k': 40.5,
      'gen_ai.request.choice.count': 2,
    });
    expect(requestParameterAttributes({ seed: 1.5, n: 0, candidate_count: 3 })).toEqual({ 'gen_ai.request.choice.count': 3 });
    expect(requestParameterAttributes({ seed: true, top_k: '5', stream: undefined })).toEqual({});
  });

  it('requestParameterAttributes: output type from response_format', () => {
    expect(requestParameterAttributes({ response_format: { type: 'json_schema' } })).toEqual({ 'gen_ai.output.type': 'json' });
    expect(requestParameterAttributes({ response_format: { type: 'json_object' } })).toEqual({ 'gen_ai.output.type': 'json' });
    expect(requestParameterAttributes({ response_format: 'TEXT' })).toEqual({ 'gen_ai.output.type': 'text' });
    expect(requestParameterAttributes({ response_format: { type: 'audio' } })).toEqual({});
    expect(requestParameterAttributes({ response_format: null })).toEqual({});
  });

  it('errorTypeName is the class name, as type(e).__name__ is', () => {
    class RateLimitError extends Error {}
    expect(errorTypeName(new RateLimitError('x'))).toBe('RateLimitError');
    expect(errorTypeName(new TypeError('x'))).toBe('TypeError');
    expect(errorTypeName(new Error('x'))).toBe('Error');
    const named = new Error('x');
    named.name = 'AbortError';
    expect(errorTypeName(named)).toBe('AbortError');
    expect(errorTypeName('a string')).toBe('string');
    expect(errorTypeName(null)).toBe('object');
  });

  it('base URL claims are matched as case-insensitive substrings', () => {
    expect(findBaseUrlClaim('https://openrouter.ai/api/v1')).toBeUndefined();
    registerBaseUrlClaim('OpenRouter.ai', 'openrouter');
    expect(findBaseUrlClaim('https://OPENROUTER.ai/api/v1')).toBe('openrouter');
    expect(findBaseUrlClaim(new URL('https://openrouter.ai/api/v1'))).toBe('openrouter');
    expect(findBaseUrlClaim('https://api.openai.com/v1')).toBeUndefined();
    expect(findBaseUrlClaim(undefined)).toBeUndefined();
  });

  it('matches the host or a subdomain of it, not the domain written anywhere in the URL', () => {
    registerBaseUrlClaim('openrouter.ai', 'openrouter');
    expect(findBaseUrlClaim('https://api.openrouter.ai/v1')).toBe('openrouter');
    expect(findBaseUrlClaim('http://openrouter.ai:8080/v1')).toBe('openrouter');
    // The reference matches these too (substring anywhere); they are not OpenRouter.
    expect(findBaseUrlClaim('https://gateway.example.com/openrouter.ai/v1')).toBeUndefined();
    expect(findBaseUrlClaim('https://openrouter.ai.example.com/v1')).toBeUndefined();
    expect(findBaseUrlClaim('https://notopenrouter.ai/v1')).toBeUndefined();
    expect(findBaseUrlClaim('not a url')).toBeUndefined();
  });
});

describe('first message and provider aliases', () => {
  const make = (overrides: Partial<OTelConfig> = {}): TestInstrumentor => {
    const instrumentor = new TestInstrumentor();
    instrumentor.instrument(loadConfig({ enableContentCapture: true, ...overrides }, {}));
    return instrumentor;
  };

  it('buildFirstMessage: role and content of the first message, as json.dumps writes it', () => {
    expect(make().firstMessage([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }])).toBe(
      '{"role": "system", "content": "Be brief."}',
    );
    expect(make().firstMessage([{ content: 'no role' }])).toBe('{"role": "user", "content": "no role"}');
    expect(make().firstMessage(['a bare string'])).toBe('{"role": "user", "content": "a bare string"}');
    expect(make().firstMessage([{ role: 'user' }])).toBe('{"role": "user", "content": ""}');
  });

  it('buildFirstMessage: structured content is written as Python would str() it', () => {
    expect(make().firstMessage([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(
      '{"role": "user", "content": "[{\'type\': \'text\', \'text\': \'hi\'}]"}',
    );
  });

  it('buildFirstMessage: truncation, no limit, capture off, nothing to capture', () => {
    expect(make({ contentMaxLength: 4 }).firstMessage([{ role: 'user', content: 'abcdefgh' }])).toBe('{"role": "user", "content": "abcd"}');
    expect(make({ contentMaxLength: 0 }).firstMessage([{ role: 'user', content: 'x'.repeat(500) }])).toHaveLength(
      '{"role": "user", "content": ""}'.length + 500,
    );
    expect(make({ enableContentCapture: false }).firstMessage([{ role: 'user', content: 'secret' }])).toBeNull();
    expect(make().firstMessage([])).toBeNull();
    expect(make().firstMessage(undefined)).toBeNull();
    expect(make().firstMessage('not a list')).toBeNull();
  });

  it('buildFirstMessage: with no configuration attached it captures, capped at 200 characters', () => {
    const instrumentor = new TestInstrumentor();
    const captured = instrumentor.firstMessage([{ role: 'user', content: 'y'.repeat(300) }]) ?? '';
    expect((JSON.parse(captured) as { content: string }).content).toHaveLength(200);
  });

  it('withProviderAliases: mirrors gen_ai.system onto gen_ai.provider.name and back, never overwriting', () => {
    expect(make().aliases({ 'gen_ai.system': 'openai' })).toEqual({ 'gen_ai.system': 'openai', 'gen_ai.provider.name': 'openai' });
    expect(make().aliases({ 'gen_ai.provider.name': 'openai' })).toEqual({ 'gen_ai.system': 'openai', 'gen_ai.provider.name': 'openai' });
    expect(make({ semconvStabilityOptIn: 'gen_ai' }).aliases({ 'gen_ai.provider.name': 'openai' })).toEqual({ 'gen_ai.provider.name': 'openai' });
    expect(make().aliases({ 'gen_ai.system': 'a', 'gen_ai.provider.name': 'b' })).toEqual({ 'gen_ai.system': 'a', 'gen_ai.provider.name': 'b' });
    const untouched = { 'http.method': 'GET' };
    expect(make().aliases(untouched)).toBe(untouched);
  });
});

describe('the span wrapper, on call shapes other than an SDK promise', () => {
  let harness: Harness;
  let instrumentor: TestInstrumentor;

  beforeEach(async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    instrumentor = new TestInstrumentor();
    instrumentor.instrument(loadConfig({}, {}));
  });
  afterEach(async () => {
    try {
      expect(harness.openSpans()).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it('a synchronous function', () => {
    const wrapped = instrumentor.wrap('test.sync', (params: { model: string }) => ({ echoed: params.model }), MODEL_ATTRS);
    expect(wrapped({ model: 'gpt-4o-mini' })).toEqual({ echoed: 'gpt-4o-mini' });
    const span = harness.span('test.sync');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(15);
    expect(span.attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });

  it('a plain promise', async () => {
    const wrapped = instrumentor.wrap('test.promise', async (params: { model: string }) => ({ echoed: params.model }), MODEL_ATTRS);
    await expect(wrapped({ model: 'gpt-4o-mini' })).resolves.toEqual({ echoed: 'gpt-4o-mini' });
    expect(harness.span('test.promise').status.code).toBe(SpanStatusCode.OK);
  });

  it('a rejected promise: ERROR status, the rejection reaches the caller unchanged', async () => {
    const boom = new RangeError('too far');
    const wrapped = instrumentor.wrap('test.reject', async () => Promise.reject(boom), MODEL_ATTRS);
    await expect(wrapped()).rejects.toBe(boom);
    const span = harness.span('test.reject');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'too far' });
    expect((await harness.metric('gen_ai.client.errors'))?.points[0]?.attributes).toEqual({ operation: 'test.reject', error_type: 'RangeError' });
  });

  it('a synchronous throw: ERROR status, the function ran exactly once', () => {
    let calls = 0;
    const wrapped = instrumentor.wrap('test.throw', () => {
      calls += 1;
      throw new Error('sync failure');
    });
    expect(() => wrapped()).toThrow('sync failure');
    expect(calls).toBe(1);
    expect(harness.span('test.throw').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('a non-Error rejection is still recorded', async () => {
    const wrapped = instrumentor.wrap('test.reject.string', async () => Promise.reject('plain string'));
    await expect(wrapped()).rejects.toBe('plain string');
    expect(harness.span('test.reject.string').status.message).toBe('plain string');
  });

  it('a streamed call returning a generic async iterable is measured in place', async () => {
    async function* generate(): AsyncGenerator<{ chunk: number }> {
      yield { chunk: 1 };
      yield { chunk: 2 };
    }
    const iterable = generate();
    const wrapped = instrumentor.wrap('test.stream', async (_params: { model: string; stream: boolean }) => iterable, MODEL_ATTRS);
    const returned = await wrapped({ model: 'gpt-4o-mini', stream: true });
    expect(returned).toBe(iterable);
    const seen: number[] = [];
    for await (const item of returned) seen.push(item.chunk);
    expect(seen).toEqual([1, 2]);
    const span = harness.span('test.stream');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.streaming.token_count']).toBe(2);
    expect(span.attributes['gen_ai.streaming.tpot_unavailable_reason']).toBe('output_token_count_unavailable');
  });

  it('an exception thrown into a streamed iterator ends the span with ERROR status', async () => {
    async function* generate(): AsyncGenerator<{ chunk: number }> {
      yield { chunk: 1 };
      yield { chunk: 2 };
    }
    const wrapped = instrumentor.wrap('test.stream.throw', async (_params: { stream: boolean }) => generate());
    const iterator = (await wrapped({ stream: true }))[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.throw(new Error('consumer failed'))).rejects.toThrow('consumer failed');
    expect(harness.span('test.stream.throw').status).toEqual({ code: SpanStatusCode.ERROR, message: 'consumer failed' });
  });

  it('stream: true with a result that is not a stream is recorded as an ordinary call', async () => {
    const wrapped = instrumentor.wrap('test.notstream', async (_params: { model: string; stream: boolean }) => ({ done: true }), MODEL_ATTRS);
    await wrapped({ model: 'gpt-4o-mini', stream: true });
    const span = harness.span('test.notstream');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect('gen_ai.streaming.token_count' in span.attributes).toBe(false);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(15);
  });

  it('usage estimated by the instrumentor is flagged as an estimate', () => {
    instrumentor.usage = null;
    instrumentor.estimate = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
    instrumentor.wrap('test.estimate', (_params: { model: string }) => ({}), MODEL_ATTRS)({ model: 'gpt-4o-mini' });
    const span = harness.span('test.estimate');
    expect(span.attributes['gen_ai.usage.token_count_estimated']).toBe(true);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(6);
  });

  it('no usage at all: no token, cost or pricing attributes', () => {
    instrumentor.usage = null;
    instrumentor.wrap('test.nousage', (_params: { model: string }) => ({}), MODEL_ATTRS)({ model: 'gpt-4o-mini' });
    const span = harness.span('test.nousage');
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });

  it('non-primitive attributes are stringified the way the reference wrapper does; null ones are left out', () => {
    const extract: AttributeExtractor = () => ({ 'gen_ai.system': 'test', 'custom.list': ['a', 1], 'custom.null': null, 'custom.undefined': undefined });
    instrumentor.wrap('test.attrs', () => ({}), extract)();
    const span = harness.span('test.attrs');
    expect(span.attributes['custom.list']).toBe("['a', 1]");
    expect('custom.null' in span.attributes).toBe(false);
    expect('custom.undefined' in span.attributes).toBe(false);
  });

  it('an attribute extractor that throws costs the attributes, not the call', () => {
    const wrapped = instrumentor.wrap(
      'test.badextract',
      () => 'result',
      () => {
        throw new Error('extractor bug');
      },
    );
    expect(wrapped()).toBe('result');
    expect(harness.span('test.badextract').status.code).toBe(SpanStatusCode.OK);
    expect(harness.logs.warn.some((line) => line.includes('extractor bug'))).toBe(true);
  });

  it('when the span cannot be started at all, the function still runs, exactly once', () => {
    const original = trace.getTracer.bind(trace);
    let calls = 0;
    const wrapped = instrumentor.wrap('test.nospan', () => {
      calls += 1;
      return 'result';
    });
    trace.getTracer = () => {
      throw new Error('tracer unavailable');
    };
    try {
      expect(wrapped()).toBe('result');
    } finally {
      trace.getTracer = original;
    }
    expect(calls).toBe(1);
    expect(harness.spans()).toEqual([]);
    expect(harness.logs.error.some((line) => line.includes('tracer unavailable'))).toBe(true);
  });

  it('an instrumentor that is switched off, or bypassed, calls straight through', () => {
    const wrapped = instrumentor.wrap('test.off', () => 'result');
    instrumentor.bypass = true;
    expect(wrapped()).toBe('result');
    instrumentor.bypass = false;
    instrumentor.uninstrument();
    expect(wrapped()).toBe('result');
    expect(harness.spans()).toEqual([]);
  });

  it('with no configuration attached: tokens are recorded, cost is not', () => {
    instrumentor.detachConfig();
    instrumentor.wrap('test.noconfig', (_params: { model: string }) => ({}), MODEL_ATTRS)({ model: 'gpt-4o-mini' });
    const span = harness.span('test.noconfig');
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(15);
    expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    // And the superseded names are emitted: unset opt-in means both spellings.
    expect(span.attributes['gen_ai.usage.prompt_tokens']).toBe(10);
  });

  it('custom pricing reaches an instrumentor that sets its configuration up', () => {
    const custom = new TestInstrumentor();
    custom.instrument(loadConfig({ customPricingJson: '{"chat": {"acme-internal-llm": {"promptPrice": 0.001, "completionPrice": 0.002}}}' }, {}));
    custom.wrap('test.custom', (_params: { model: string }) => ({}), MODEL_ATTRS)({ model: 'acme-internal-llm' });
    const span = harness.span('test.custom');
    expect(span.attributes['gen_ai.usage.cost.total']).toBe((10 / 1000) * 0.001 + (5 / 1000) * 0.002);
    expect(span.attributes['gen_ai.usage.cost.pricing_source']).toBe('table');
  });

  it('an embedding call from an instrumentor with no content hook of its own gets the generic embedding content', async () => {
    await harness.stop();
    harness = await startHarness({ enabledInstrumentors: [], enableContentCapture: true, captureEmbeddingVectors: true });
    const capturing = new TestInstrumentor();
    capturing.instrument(loadConfig({ enableContentCapture: true, captureEmbeddingVectors: true }, {}));
    const extract: AttributeExtractor = (_instance, _args, params) => ({
      'gen_ai.system': 'test',
      'gen_ai.request.model': params.model,
      'gen_ai.request.type': 'embedding',
    });
    const embed = capturing.wrap('test.embed', (_params: { model: string; input: unknown }) => ({ data: [{ embedding: [0.5, 0.25] }] }), extract);
    embed({ model: 'text-embedding-3-small', input: ['x'.repeat(600), 'second'] });
    const span = harness.span('test.embed');
    expect(span.attributes['embedding.model_name']).toBe('text-embedding-3-small');
    expect(span.attributes['embedding.text']).toBe('x'.repeat(500));
    expect(span.attributes['embedding.vector']).toBe('[0.5, 0.25]');
    expect(span.attributes['embedding.vector.dimension']).toBe(2);

    harness.reset();
    embed({ model: 'text-embedding-3-small', input: { text: 'nested text' } });
    expect(harness.span('test.embed').attributes['embedding.text']).toBe('nested text');
    harness.reset();
    embed({ model: 'text-embedding-3-small', input: [101, 102] });
    expect('embedding.text' in harness.span('test.embed').attributes).toBe(false);
  });

  it('a pricing-table entry the calculator cannot price is counted as pricing missing, and the call is unharmed', async () => {
    // One of the 13 shipped entries in the wrong shape: the calculator raises on it.
    const extract: AttributeExtractor = (_instance, _args, params) => ({
      'gen_ai.system': 'test',
      'gen_ai.request.model': params.model,
      'gen_ai.request.type': 'image',
    });
    instrumentor.usage = { size: '1024x1024', n: 1 };
    const wrapped = instrumentor.wrap('test.image', (_params: { model: string }) => 'image', extract);
    expect(wrapped({ model: 'recraft/recraftv3' })).toBe('image');
    const span = harness.span('test.image');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
    expect((await harness.metric('gen_ai.usage.cost.pricing_missing'))?.points).toEqual([
      { attributes: { model: 'recraft/recraftv3', call_type: 'image' }, value: 1 },
    ]);
    expect(harness.logs.warn.some((line) => line.includes('Failed to calculate cost'))).toBe(true);
  });

  it('the wrapper keeps the name of the function it wraps', () => {
    function create(): string {
      return 'x';
    }
    expect(instrumentor.wrap('test.name', create).name).toBe('create');
    instrumentor.wrap('test.name', create)();
  });
});

describe('sampled-out calls', () => {
  let harness: Harness;
  let instrumentor: TestInstrumentor;

  beforeEach(async () => {
    harness = await startHarness({ enabledInstrumentors: [], samplingRate: 0 });
    instrumentor = new TestInstrumentor();
    instrumentor.instrument(loadConfig({}, {}));
  });
  afterEach(async () => {
    await harness.stop();
  });

  it('synchronous and promise results count the request and its latency, and nothing else', async () => {
    instrumentor.wrap('test.unsampled', () => 'x')();
    await instrumentor.wrap('test.unsampled', async () => 'y')();
    expect(harness.spans()).toEqual([]);
    expect((await harness.metric('gen_ai.requests'))?.points[0]).toMatchObject({ value: 2, attributes: { operation: 'test.unsampled' } });
    expect((await harness.metric('gen_ai.client.operation.duration'))?.points[0]?.count).toBe(2);
    expect(await harness.metric('gen_ai.client.token.usage')).toBeUndefined();
  });

  it('a failed sampled-out call counts neither a request nor an error', async () => {
    await expect(instrumentor.wrap('test.unsampled.fail', async () => Promise.reject(new Error('x')))()).rejects.toThrow('x');
    expect(await harness.metric('gen_ai.requests')).toBeUndefined();
    expect(await harness.metric('gen_ai.client.errors')).toBeUndefined();
  });
});

describe('agent budget governance', () => {
  let harness: Harness;
  let instrumentor: TestInstrumentor;

  beforeEach(async () => {
    harness = await startHarness({ enabledInstrumentors: [] });
    instrumentor = new TestInstrumentor();
    instrumentor.instrument(loadConfig({}, {}));
  });
  afterEach(async () => {
    instrumentor.uninstrument();
    await harness.stop();
  });

  /** The test instrumentor reads no usage from a result carrying `chunk`: an agent's result has none of its own. */
  const AGENT_RESULT = { chunk: true };

  const AGENT: AttributeExtractor = (_instance, _args, params) => ({
    'gen_ai.system': 'test',
    'gen_ai.operation.name': 'agent.run',
    'gen_ai.agent.name': 'planner',
    'gen_ai.request.model': 'planner',
    ...extractBudgetAttributes(params),
  });

  it('extractBudgetAttributes reads a cap wherever a framework keeps it, and never invents one', () => {
    expect(extractBudgetAttributes({ max_turns: 8 })).toEqual({ 'gen_ai.agent.iteration_budget': 8 });
    expect(extractBudgetAttributes(undefined, { other: 1 }, { recursion_limit: 25, token_budget: 4000 })).toEqual({
      'gen_ai.agent.iteration_budget': 25,
      'gen_ai.agent.token_budget': 4000,
    });
    // Zero, negative, boolean and non-numeric values are not budgets.
    expect(extractBudgetAttributes({ max_turns: 0, max_iterations: true, max_iter: 'ten', max_tokens: -5 })).toEqual({});
    expect(extractBudgetAttributes({ max_iterations: 3.9 })).toEqual({ 'gen_ai.agent.iteration_budget': 3 });
  });

  it('the tokens and calls of the model calls made inside an agent invocation are put on its span, with the utilisation', async () => {
    const llm = instrumentor.wrap('test.chat', async (_params: { model: string }) => ({ ok: true }), MODEL_ATTRS);
    const agent = instrumentor.wrap(
      'test.agent',
      async (_params: { token_budget: number; max_turns: number }) => {
        await llm({ model: 'gpt-4o-mini' });
        await llm({ model: 'gpt-4o-mini' });
        return AGENT_RESULT;
      },
      AGENT,
    );
    instrumentor.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    await agent({ token_budget: 100, max_turns: 4 });

    const span = harness.span('test.agent');
    expect(span.attributes).toMatchObject({
      'gen_ai.agent.token_budget': 100,
      'gen_ai.agent.iteration_budget': 4,
      'gen_ai.agent.token_budget.consumed': 30,
      'gen_ai.agent.iteration_budget.consumed': 2,
    });
    const utilisation = await harness.metric('gen_ai.invoke_agent.token_budget.utilization');
    expect(utilisation?.points).toHaveLength(1);
    expect(utilisation?.points[0]?.attributes).toEqual({ 'gen_ai.operation.name': 'agent.run', 'gen_ai.agent.name': 'planner' });
  });

  it('a nested agent accounts for its own calls only; a call outside any agent is counted nowhere', async () => {
    const llm = instrumentor.wrap('test.chat', async (_params: { model: string }) => ({ ok: true }), MODEL_ATTRS);
    const worker = instrumentor.wrap(
      'test.worker',
      async (_params: object) => {
        await llm({ model: 'm' });
        return AGENT_RESULT;
      },
      () => ({ 'gen_ai.operation.name': 'agent.run', 'gen_ai.agent.name': 'worker' }),
    );
    const supervisor = instrumentor.wrap(
      'test.supervisor',
      async (_params: object) => {
        await llm({ model: 'm' });
        await worker({});
        return AGENT_RESULT;
      },
      () => ({ 'gen_ai.operation.name': 'agent.run', 'gen_ai.agent.name': 'supervisor' }),
    );
    await llm({ model: 'm' });
    await supervisor({});
    expect(harness.span('test.worker').attributes['gen_ai.agent.token_budget.consumed']).toBe(15);
    expect(harness.span('test.supervisor').attributes['gen_ai.agent.token_budget.consumed']).toBe(15);
    // No budget was configured: consumption is recorded, a utilisation is not.
    expect(await harness.metric('gen_ai.invoke_agent.token_budget.utilization')).toBeUndefined();
  });

  it('an agent that made no model call carries no consumption attributes', async () => {
    const agent = instrumentor.wrap('test.agent', async (_params: object) => null, AGENT);
    instrumentor.usage = null;
    await agent({ max_turns: 4 });
    const attributes = harness.span('test.agent').attributes;
    expect(attributes['gen_ai.agent.iteration_budget']).toBe(4);
    expect('gen_ai.agent.token_budget.consumed' in attributes).toBe(false);
    expect('gen_ai.agent.iteration_budget.consumed' in attributes).toBe(false);
  });
});
