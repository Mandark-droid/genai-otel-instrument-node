/**
 * A2A client instrumentation, against the real `@a2a-js/sdk` `Client` (interceptors, header
 * normalisation and all) over a transport that records what it was called with - and, for the wire,
 * the SDK's own JSON-RPC transport with a `fetch` that never leaves the process.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Client, ClientFactory, JsonRpcTransportFactory, TenantTransportDecorator } from '@a2a-js/sdk/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { a2aClientInstrumentor } from '../../src/a2a/client-instrumentor';
import { serverAddress } from '../../src/a2a/extract';
import { configureA2ui } from '../../src/a2ui/settings';
import { DEFAULT_INSTRUMENTORS } from '../../src/config';
import { startHarness, type Harness } from '../helpers/harness';

const TASK_STATE = { SUBMITTED: 1, WORKING: 2, COMPLETED: 3, FAILED: 4, REJECTED: 7 } as const;

const part = (value: string) => ({ content: { $case: 'text' as const, value }, metadata: undefined, filename: '', mediaType: '' });
const dataPart = (value: unknown, extra: { mediaType?: string; metadata?: Record<string, unknown> } = {}) => ({
  content: { $case: 'data' as const, value },
  metadata: extra.metadata,
  filename: '',
  mediaType: extra.mediaType ?? '',
});
const filePart = (mediaType: string) => ({ content: { $case: 'raw' as const, value: Buffer.from('secret-bytes') }, metadata: undefined, filename: 'invoice.pdf', mediaType });
const message = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  messageId: 'm-1',
  contextId: 'ctx-1',
  taskId: '',
  role: 1,
  parts,
  metadata: undefined,
  extensions: [] as string[],
  referenceTaskIds: [] as string[],
  ...extra,
});
const request = (parts: unknown[], extra: Record<string, unknown> = {}, requestExtra: Record<string, unknown> = {}) => ({
  tenant: '',
  message: message(parts, extra),
  configuration: undefined,
  metadata: undefined,
  ...requestExtra,
});
const task = (state: number, extra: Record<string, unknown> = {}) => ({
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state, message: undefined, timestamp: undefined },
  artifacts: [] as unknown[],
  history: [],
  metadata: undefined,
  ...extra,
});
const artifact = (parts: unknown[], id = 'a-1') => ({ artifactId: id, name: '', description: '', parts, metadata: undefined, extensions: [] as string[] });

const card = (overrides: Record<string, unknown> = {}) => ({
  name: 'weather-agent',
  description: 'Forecasts for a city',
  version: '2.1.0',
  supportedInterfaces: [{ url: 'https://agents.example:8443/a2a', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
  provider: undefined,
  capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: false, extensions: [] },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [{ id: 'forecast', name: 'forecast', description: 'Weather', tags: [], examples: [], inputModes: [], outputModes: [], securityRequirements: [] }],
  extensions: [],
  signatures: [],
  ...overrides,
});

interface Call {
  method: string;
  params: unknown;
  options: { serviceParameters?: Record<string, string> } | undefined;
}

/** A transport that records its calls and answers from a script. */
function stubTransport(script: {
  result?: unknown;
  events?: unknown[];
  fail?: Error;
  protocolName?: string;
}): { transport: unknown; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string) => (params: unknown, options?: Call['options']) => {
    calls.push({ method, params, options });
    if (script.fail) return Promise.reject(script.fail);
    return Promise.resolve(script.result ?? task(TASK_STATE.COMPLETED));
  };
  const stream = (method: string) =>
    async function* (params: unknown, options?: Call['options']) {
      calls.push({ method, params, options });
      for (const event of script.events ?? []) {
        yield event;
      }
      if (script.fail) throw script.fail;
    };
  const transport = {
    protocolName: script.protocolName ?? 'JSONRPC',
    protocolVersion: '1.0',
    getExtendedAgentCard: (params: unknown, options?: Call['options']) => {
      calls.push({ method: 'getExtendedAgentCard', params, options });
      return Promise.resolve(card({ name: 'weather-agent-extended' }));
    },
    sendMessage: record('sendMessage'),
    sendMessageStream: stream('sendMessageStream'),
    createTaskPushNotificationConfig: record('createTaskPushNotificationConfig'),
    getTaskPushNotificationConfig: record('getTaskPushNotificationConfig'),
    listTaskPushNotificationConfig: record('listTaskPushNotificationConfig'),
    deleteTaskPushNotificationConfig: record('deleteTaskPushNotificationConfig'),
    getTask: record('getTask'),
    cancelTask: record('cancelTask'),
    listTasks: record('listTasks'),
    resubscribeTask: stream('resubscribeTask'),
  };
  return { transport, calls };
}

const clientFor = (transport: unknown, agentCard: unknown = card()): Client => new Client(transport as never, agentCard as never);

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

const streamEvent = (kind: string, value: unknown) => ({ payload: { $case: kind, value } });

let harness: Harness;

async function begin(env: Record<string, string> = {}, options: Record<string, unknown> = {}): Promise<void> {
  harness = await startHarness({ enabledInstrumentors: ['a2a'], ...options });
  void env;
}

beforeEach(() => {
  configureA2ui(undefined);
});

afterEach(async () => {
  await harness?.stop();
});

const only = (name: string): ReadableSpan => harness.span(name);

describe('one client call, one CLIENT span', () => {
  it('sendMessage: name, kind, the call, the target agent, the task and what came back', async () => {
    await begin();
    const { transport } = stubTransport({
      result: task(TASK_STATE.COMPLETED, { artifacts: [artifact([part('sunny'), dataPart({ t: 21 })]), artifact([filePart('image/png')], 'a-2')] }),
    });
    const result = await clientFor(transport).sendMessage(request([part('weather in Pune?'), filePart('application/pdf')], { referenceTaskIds: ['t-0'] }) as never);
    expect((result as { id: string }).id).toBe('task-1');

    const span = only('SendMessage weather-agent');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    // The SDK's own span processors add the agent-graph attributes (`agent.name`, `graph.node.*`) and
    // `openinference.span.kind` to an invoke_agent span; what this instrumentor wrote is exactly this.
    expect(span.attributes).toMatchObject({
      'a2a.method.name': 'SendMessage',
      'gen_ai.operation.name': 'invoke_agent',
      'a2a.protocol.binding': 'jsonrpc',
      'a2a.protocol.version': '1.0',
      'server.address': 'agents.example',
      'server.port': 8443,
      'gen_ai.agent.name': 'weather-agent',
      'gen_ai.agent.description': 'Forecasts for a city',
      'gen_ai.agent.version': '2.1.0',
      'a2a.agent.skill_count': 1,
      'a2a.task.id': 'task-1',
      'a2a.task.state': 'completed',
      'gen_ai.conversation.id': 'ctx-1',
      'a2a.message.id': 'm-1',
      'a2a.message.reference_task_ids': ['t-0'],
      'a2a.message.text_part_count': 1,
      'a2a.message.file_part_count': 1,
      'a2a.message.data_part_count': 0,
      'a2a.message.file_media_types': ['application/pdf'],
      'a2a.response.text_part_count': 1,
      'a2a.response.file_part_count': 1,
      'a2a.response.data_part_count': 1,
      'a2a.response.file_media_types': ['image/png'],
      'a2a.artifact.count': 2,
    });
    expect(harness.openSpans()).toEqual([]);
  });

  it('every other client method has its wire name', async () => {
    await begin();
    const { transport } = stubTransport({ result: { configs: [], nextPageToken: '', tasks: [] } });
    const client = clientFor(transport);
    await client.getTask({ tenant: '', id: 'task-9', historyLength: undefined } as never);
    await client.listTasks({ tenant: '', contextId: 'ctx-5' } as never);
    await client.cancelTask({ tenant: '', id: 'task-9' } as never);
    await client.createTaskPushNotificationConfig({ taskId: 'task-9' } as never);
    await client.getTaskPushNotificationConfig({ taskId: 'task-9' } as never);
    await client.listTaskPushNotificationConfig({ taskId: 'task-9' } as never);
    await client.deleteTaskPushNotificationConfig({ taskId: 'task-9' } as never);
    const names = harness
      .spans()
      .map((span) => span.name)
      .sort();
    expect(names).toEqual(
      [
        'GetTask weather-agent',
        'ListTasks weather-agent',
        'CancelTask weather-agent',
        'CreateTaskPushNotificationConfig weather-agent',
        'GetTaskPushNotificationConfig weather-agent',
        'ListTaskPushNotificationConfigs weather-agent',
        'DeleteTaskPushNotificationConfig weather-agent',
      ].sort(),
    );
    expect(harness.spans().find((span) => span.name.startsWith('GetTask '))?.attributes['a2a.task.id']).toBe('task-9');
    expect(harness.spans().find((span) => span.name.startsWith('ListTasks '))?.attributes['gen_ai.conversation.id']).toBe('ctx-5');
    expect(harness.spans().find((span) => span.name.startsWith('CancelTask '))?.attributes['a2a.method.name']).toBe('CancelTask');
  });

  it('getAgentCard has a span only when it has an extended card to fetch', async () => {
    await begin();
    const plain = stubTransport({});
    await clientFor(plain.transport).getAgentCard();
    expect(harness.spans()).toEqual([]);
    expect(plain.calls).toEqual([]);

    const extended = stubTransport({});
    await clientFor(extended.transport, card({ capabilities: { streaming: true, extendedAgentCard: true, pushNotifications: false, extensions: [] } })).getAgentCard();
    expect(only('GetExtendedAgentCard weather-agent').attributes['a2a.method.name']).toBe('GetExtendedAgentCard');
  });

  it('no card name: the span is named after the host', async () => {
    await begin();
    const { transport } = stubTransport({});
    await clientFor(transport, card({ name: '' })).sendMessage(request([part('x')]) as never);
    const span = only('SendMessage agents.example');
    expect(span.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  it('the binding follows the transport, a tenant decorator included', async () => {
    await begin();
    const rest = stubTransport({ protocolName: 'HTTP+JSON' });
    await clientFor(rest.transport, card({ supportedInterfaces: [{ url: 'http://rest.example/a2a', protocolBinding: 'HTTP+JSON', tenant: '', protocolVersion: '1.0' }] })).getTask({ tenant: '', id: 't' } as never);
    const grpc = stubTransport({ protocolName: 'GRPC' });
    const decorated = new TenantTransportDecorator(grpc.transport as never, 'tenant-a');
    await clientFor(decorated).getTask({ tenant: '', id: 't' } as never);
    const bindings = harness.spans().map((span) => span.attributes['a2a.protocol.binding']);
    expect(bindings).toEqual(['http_json', 'grpc']);
    expect(harness.spans()[0]?.attributes['server.port']).toBe(80);
  });
});

describe('streaming', () => {
  it('SendStreamingMessage when the card says the agent streams; the final task state; the span ends with the stream', async () => {
    await begin();
    const events = [
      streamEvent('task', task(TASK_STATE.SUBMITTED)),
      streamEvent('statusUpdate', { taskId: 'task-1', contextId: 'ctx-1', status: { state: TASK_STATE.WORKING }, metadata: undefined }),
      streamEvent('artifactUpdate', { taskId: 'task-1', contextId: 'ctx-1', artifact: artifact([part('partial')]), append: false, lastChunk: true, metadata: undefined }),
      streamEvent('statusUpdate', { taskId: 'task-1', contextId: 'ctx-1', status: { state: TASK_STATE.COMPLETED }, metadata: undefined }),
    ];
    const { transport } = stubTransport({ events });
    const stream = clientFor(transport).sendMessageStream(request([part('go')]) as never);

    // Nothing has run yet: no span for a stream nobody has read.
    expect(harness.spans()).toEqual([]);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    expect(harness.openSpans()).toEqual(['SendStreamingMessage weather-agent']);
    const rest = await drain({ [Symbol.asyncIterator]: () => iterator });
    expect(rest).toHaveLength(3);

    const span = only('SendStreamingMessage weather-agent');
    expect(span.attributes['a2a.method.name']).toBe('SendStreamingMessage');
    expect(span.attributes['a2a.task.state']).toBe('completed');
    expect(span.attributes['a2a.task.id']).toBe('task-1');
    expect(span.attributes['a2a.artifact.count']).toBe(1);
    expect(span.attributes['a2a.response.text_part_count']).toBe(1);
    expect(harness.openSpans()).toEqual([]);
  });

  it('an agent that does not stream: SendMessage, and the SDK answers with one event', async () => {
    await begin();
    const { transport } = stubTransport({ result: task(TASK_STATE.COMPLETED) });
    const events = await drain(clientFor(transport, card({ capabilities: { streaming: false, extendedAgentCard: false, pushNotifications: false, extensions: [] } })).sendMessageStream(request([part('go')]) as never));
    expect(events).toHaveLength(1);
    expect(only('SendMessage weather-agent').attributes['a2a.task.state']).toBe('completed');
  });

  it('the caller returning early ends the span and closes the SDK stream', async () => {
    await begin();
    const { transport } = stubTransport({ events: [streamEvent('task', task(TASK_STATE.WORKING)), streamEvent('task', task(TASK_STATE.COMPLETED))] });
    for await (const event of clientFor(transport).sendMessageStream(request([part('go')]) as never)) {
      void event;
      break;
    }
    expect(harness.openSpans()).toEqual([]);
    expect(only('SendStreamingMessage weather-agent').attributes['a2a.task.state']).toBe('working');
  });

  it('a stream that fails is an ERROR span carrying the error class', async () => {
    await begin();
    class TaskNotFoundError extends Error {}
    const { transport } = stubTransport({ events: [streamEvent('task', task(TASK_STATE.WORKING))], fail: new TaskNotFoundError('task t-1 not found: private detail') });
    await expect(drain(clientFor(transport).sendMessageStream(request([part('go')]) as never))).rejects.toThrow('not found');
    const span = only('SendStreamingMessage weather-agent');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('TaskNotFoundError');
    // Without content capture the message (it can echo content) is not on the span.
    expect(span.status.message).toBe('TaskNotFoundError');
    expect(JSON.stringify(span.events)).not.toContain('private detail');
  });

  it('resubscribeTask is SubscribeToTask', async () => {
    await begin();
    const { transport } = stubTransport({ events: [streamEvent('statusUpdate', { taskId: 'task-1', contextId: 'ctx-1', status: { state: TASK_STATE.COMPLETED }, metadata: undefined })] });
    await drain(clientFor(transport).resubscribeTask({ tenant: '', id: 'task-1' } as never));
    const span = only('SubscribeToTask weather-agent');
    expect(span.attributes['a2a.task.state']).toBe('completed');
    expect(span.attributes['a2a.method.name']).toBe('SubscribeToTask');
  });

  it('two tasks in one stream: no task id and no state (they would mislabel the span)', async () => {
    await begin();
    const { transport } = stubTransport({
      events: [streamEvent('task', task(TASK_STATE.COMPLETED, { id: 't-a' })), streamEvent('task', task(TASK_STATE.FAILED, { id: 't-b' }))],
    });
    await drain(clientFor(transport).sendMessageStream(request([part('go')]) as never));
    const span = only('SendStreamingMessage weather-agent');
    expect(span.attributes['a2a.task.id']).toBeUndefined();
    expect(span.attributes['a2a.task.state']).toBeUndefined();
    expect(span.attributes['gen_ai.conversation.id']).toBe('ctx-1');
  });
});

describe('errors', () => {
  it('a failed or rejected task is not an error span: the call worked and the answer was no', async () => {
    await begin();
    const { transport } = stubTransport({ result: task(TASK_STATE.REJECTED) });
    await clientFor(transport).sendMessage(request([part('x')]) as never);
    const span = only('SendMessage weather-agent');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['a2a.task.state']).toBe('rejected');
    expect(span.attributes['error.type']).toBeUndefined();
  });

  it('a raised error is ERROR with its class; the message is kept only with content capture', async () => {
    await begin();
    class UnsupportedOperationError extends Error {}
    const { transport } = stubTransport({ fail: new UnsupportedOperationError('cannot do that for jane@example.com') });
    await expect(clientFor(transport).sendMessage(request([part('x')]) as never)).rejects.toThrow('cannot do that');
    const span = only('SendMessage weather-agent');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'UnsupportedOperationError' });
    expect(span.attributes['error.type']).toBe('UnsupportedOperationError');
    expect(JSON.stringify([span.status, span.events, span.attributes])).not.toContain('jane@example.com');
    expect(harness.openSpans()).toEqual([]);
  });

  it('with content capture the message and the exception are recorded', async () => {
    await begin({}, { enableContentCapture: true });
    const { transport } = stubTransport({ fail: new Error('upstream said no') });
    await expect(clientFor(transport).sendMessage(request([part('x')]) as never)).rejects.toThrow('upstream said no');
    const span = only('SendMessage weather-agent');
    expect(span.status.message).toBe('upstream said no');
    expect(span.events.map((event) => event.name)).toContain('exception');
  });

  it('a cancelled request is not a failed call', async () => {
    await begin();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { transport } = stubTransport({ fail: abort });
    await expect(clientFor(transport).sendMessage(request([part('x')]) as never)).rejects.toBe(abort);
    expect(only('SendMessage weather-agent').status.code).toBe(SpanStatusCode.UNSET);
  });

  it('the SDK result is returned as it was, and a throwing observer would not change that', async () => {
    await begin();
    const reply = task(TASK_STATE.COMPLETED);
    const { transport } = stubTransport({ result: reply });
    expect(await clientFor(transport).sendMessage(request([part('x')]) as never)).toBe(reply);
  });
});

describe('trace context between agents', () => {
  it('traceparent reaches the transport, naming the client span; the caller\'s options are not edited', async () => {
    await begin();
    const { transport, calls } = stubTransport({});
    const options = { serviceParameters: { 'x-api-key': 'k' } };
    await clientFor(transport).sendMessage(request([part('x')]) as never, options as never);

    const span = only('SendMessage weather-agent');
    const parameters = calls[0]?.options?.serviceParameters ?? {};
    expect(parameters.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(parameters['x-api-key']).toBe('k');
    expect(parameters['A2A-Version']).toBe('1.0');
    expect(options).toEqual({ serviceParameters: { 'x-api-key': 'k' } });
  });

  it('a parent span makes one trace across the call', async () => {
    await begin();
    const { transport, calls } = stubTransport({});
    const { trace, context } = await import('@opentelemetry/api');
    const parent = trace.getTracer('test').startSpan('caller');
    await context.with(trace.setSpan(context.active(), parent), () => clientFor(transport).sendMessage(request([part('x')]) as never));
    parent.end();
    const span = only('SendMessage weather-agent');
    expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(calls[0]?.options?.serviceParameters?.traceparent).toContain(parent.spanContext().traceId);
  });

  it('GENAI_A2A_PROPAGATE=false: no trace context goes out, and the options are passed through untouched', async () => {
    await begin({}, { a2aPropagate: false });
    const { transport, calls } = stubTransport({});
    await clientFor(transport).sendMessage(request([part('x')]) as never);
    const parameters = calls[0]?.options?.serviceParameters ?? {};
    expect(parameters.traceparent).toBeUndefined();
    expect(parameters.tracestate).toBeUndefined();
    expect(only('SendMessage weather-agent')).toBeDefined();
  });

  it('session baggage obeys the session-baggage policy: only the keys named leave', async () => {
    await begin({}, { sessionBaggageKeys: ['session.id'] });
    const { transport, calls } = stubTransport({});
    const { withSession } = await import('../../src/session');
    await withSession('sess-123', () => clientFor(transport).sendMessage(request([part('x')]) as never), { userId: 'u-9' });
    const baggage = calls[0]?.options?.serviceParameters?.baggage ?? '';
    expect(baggage).toContain('session.id=sess-123');
    expect(baggage).not.toContain('user.id');
  });

  it('and with no session baggage configured, none leaves', async () => {
    await begin();
    const { transport, calls } = stubTransport({});
    const { withSession } = await import('../../src/session');
    await withSession('sess-123', () => clientFor(transport).sendMessage(request([part('x')]) as never));
    expect(calls[0]?.options?.serviceParameters?.baggage).toBeUndefined();
  });
});

describe('content', () => {
  it('without capture: ids, states, counts and types - never text, data or skill names', async () => {
    await begin();
    const { transport } = stubTransport({ result: task(TASK_STATE.COMPLETED, { artifacts: [artifact([part('the secret answer'), dataPart({ ssn: '123' })])] }) });
    await clientFor(transport).sendMessage(request([part('my secret question'), dataPart({ card: '4111' }), filePart('application/pdf')]) as never);
    const span = only('SendMessage weather-agent');
    const text = JSON.stringify(span.attributes);
    for (const secret of ['secret question', 'secret answer', '4111', '123', 'forecast"', 'secret-bytes', 'invoice.pdf']) expect(text).not.toContain(secret);
    expect(Object.keys(span.attributes).filter((key) => /\.(text|data|skill_names)$/.test(key))).toEqual([]);
  });

  it('with capture: text, data and skill names, to the content limit; files never', async () => {
    await begin({}, { enableContentCapture: true, contentMaxLength: 12 });
    const { transport } = stubTransport({ result: task(TASK_STATE.COMPLETED, { artifacts: [artifact([part('answer text that is long'), dataPart({ b: 2, a: 1 })])] }) });
    await clientFor(transport).sendMessage(request([part('question text that is long'), filePart('application/pdf')]) as never);
    const span = only('SendMessage weather-agent');
    expect(span.attributes['a2a.message.text']).toBe('question tex');
    expect(span.attributes['a2a.response.text']).toBe('answer text ');
    expect(span.attributes['a2a.response.data']).toBe('{"a": 1, "b"');
    expect(span.attributes['a2a.agent.skill_names']).toEqual(['forecast']);
    expect(JSON.stringify(span.attributes)).not.toContain('secret-bytes');
    expect(JSON.stringify(span.attributes)).not.toContain('invoice.pdf');
  });
});

describe('A2UI on the call', () => {
  const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
  const A2UI = 'application/a2ui+json';
  const action = { version: '1.0', action: { name: 'select_flight', surfaceId: 'flights', sourceComponentId: 'row-2', context: { flight: 'AI-101', passenger: 'Ada Lovelace' } } };
  const surface = [
    { version: '1.0', createSurface: { surfaceId: 'flights', catalogId: CATALOG } },
    { version: '1.0', updateComponents: { surfaceId: 'flights', components: [{ id: 'root', component: 'Column' }, { id: 'img', component: 'Image', url: 'https://cdn.example/plane.png' }] } },
  ];
  const capabilities = { a2uiRendererCapabilities: { '1.0': { supportedCatalogIds: [CATALOG, 'https://example.com/custom'] } } };

  async function send(options: Record<string, unknown>, reqOptions?: unknown): Promise<ReadableSpan> {
    await begin({}, options);
    const { transport } = stubTransport({
      result: task(TASK_STATE.COMPLETED, { artifacts: [artifact([dataPart(surface, { mediaType: A2UI })])] }),
    });
    await clientFor(transport).sendMessage(
      request([dataPart(action, { metadata: { mimeType: 'application/json+a2ui' } })], { metadata: capabilities, extensions: ['https://a2ui.org/a2a-extension/a2ui/v1.0'] }, { metadata: undefined }) as never,
      reqOptions as never,
    );
    return only('SendMessage weather-agent');
  }

  it('the request side is the renderer\'s (the action, its capabilities) and the response side the agent\'s (the surface)', async () => {
    const span = await send({});
    expect(span.attributes).toMatchObject({
      'a2ui.protocol.version': '1.0',
      'a2ui.agent_message.count': 2,
      'a2ui.renderer_message.count': 1,
      'a2ui.message.types': ['action', 'create_surface', 'update_components'],
      'a2ui.surface.id': 'flights',
      'a2ui.surface.count': 1,
      'a2ui.catalog.id': CATALOG,
      'a2ui.component.count': 2,
      'a2ui.action.name': 'select_flight',
      'a2ui.renderer.supported_catalog_ids': ['https://example.com/custom', CATALOG].sort(),
      'a2ui.extension.active': true,
      // A2UI parts still count as data parts of the A2A message.
      'a2a.message.data_part_count': 1,
      'a2a.response.data_part_count': 1,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('without capture nothing of the UI or the action context is recorded', async () => {
    const span = await send({});
    const text = JSON.stringify(span.attributes);
    expect(text).not.toContain('Ada Lovelace');
    expect(text).not.toContain('cdn.example');
    expect(Object.keys(span.attributes).filter((key) => ['a2ui.messages', 'a2ui.data_model', 'a2ui.action.context', 'a2ui.component.types', 'a2a.message.data', 'a2a.response.data'].includes(key))).toEqual([]);
  });

  it('with capture: the messages with media URLs redacted, in the A2A data attributes too', async () => {
    const span = await send({ enableContentCapture: true, contentMaxLength: 0 });
    expect(span.attributes['a2ui.action.context']).toBe('[{"flight":"AI-101","passenger":"Ada Lovelace"}]');
    expect(span.attributes['a2ui.component.types']).toEqual(['Column', 'Image']);
    const messages = String(span.attributes['a2ui.messages']);
    expect(messages).toContain('"url":"[redacted]"');
    expect(messages).not.toContain('cdn.example');
    expect(String(span.attributes['a2a.response.data'])).not.toContain('cdn.example');
    expect(String(span.attributes['a2a.response.data'])).toContain('"url": "[redacted]"');
  });

  it('the extension header, under either name, marks the call', async () => {
    await begin();
    const { transport } = stubTransport({});
    await clientFor(transport).sendMessage(request([part('hi')]) as never, { serviceParameters: { 'X-A2A-Extensions': 'https://a2ui.org/a2a-extension/a2ui/v0.9' } } as never);
    await clientFor(transport).getTask({ tenant: '', id: 't' } as never, { serviceParameters: { 'A2A-Extensions': 'https://example.com/other, https://a2ui.org/a2a-extension/a2ui/v1.0' } } as never);
    const flags = harness.spans().map((span) => span.attributes['a2ui.extension.active']);
    expect(flags).toEqual([true, true]);
  });

  it('GENAI_A2UI_ENABLED=false: no a2ui attributes, and the A2A data attribute is exactly what A2A alone writes', async () => {
    const span = await send({ a2uiEnabled: false, enableContentCapture: true, contentMaxLength: 0 });
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('a2ui.'))).toEqual([]);
    // Not scrubbed: with A2UI off the reader that scrubs is off too.
    expect(String(span.attributes['a2a.response.data'])).toContain('cdn.example');
    expect(span.attributes['a2a.response.data_part_count']).toBe(1);
  });

  it('a renderer error rides on a successful call without making it an error', async () => {
    await begin();
    const error = { version: '1.0', error: { code: 'VALIDATION_FAILED', surfaceId: 'flights', path: '/components/1', message: 'bad' } };
    const { transport } = stubTransport({});
    await clientFor(transport).sendMessage(request([dataPart([error], { mediaType: A2UI })]) as never);
    const span = only('SendMessage weather-agent');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['a2ui.error.codes']).toEqual(['VALIDATION_FAILED']);
    expect(span.events.map((event) => [event.name, event.attributes])).toEqual([['a2ui.error', { 'a2ui.error.code': 'VALIDATION_FAILED', 'a2ui.surface.id': 'flights' }]]);
  });

  it('several surfaces: the single-valued id is left off, the count and the list are kept', async () => {
    await begin();
    const many = [
      { version: '1.0', createSurface: { surfaceId: 'a', catalogId: 'c1' } },
      { version: '1.0', createSurface: { surfaceId: 'b', catalogId: 'c2' } },
    ];
    const { transport } = stubTransport({ result: task(TASK_STATE.COMPLETED, { artifacts: [artifact([dataPart(many[0], { mediaType: A2UI }), dataPart(many[1], { mediaType: A2UI })])] }) });
    await clientFor(transport).sendMessage(request([part('x')]) as never);
    const span = only('SendMessage weather-agent');
    expect(span.attributes['a2ui.surface.id']).toBeUndefined();
    expect(span.attributes['a2ui.surface.count']).toBe(2);
    expect(span.attributes['a2ui.catalog.ids']).toEqual(['c1', 'c2']);
  });

  it('a data part that is not A2UI is left alone', async () => {
    await begin();
    const { transport } = stubTransport({});
    await clientFor(transport).sendMessage(request([dataPart({ version: '1.0', createSurface: { surfaceId: 'x' } }, { mediaType: 'application/json' })]) as never);
    expect(Object.keys(only('SendMessage weather-agent').attributes).filter((key) => key.startsWith('a2ui.'))).toEqual([]);
  });
});

describe('over the SDK\'s own JSON-RPC transport, with a fetch that never leaves the process', () => {
  function rpcClient(respond: (headers: Headers, body: unknown) => Response): { make: () => Promise<Client>; seen: { headers: Headers; body: unknown }[] } {
    const seen: { headers: Headers; body: unknown }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? 'null'));
      seen.push({ headers, body });
      return respond(headers, body);
    }) as unknown as typeof fetch;
    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] });
    return { make: () => factory.createFromAgentCard(card({ capabilities: { streaming: false, extendedAgentCard: false, pushNotifications: false, extensions: [] } }) as never), seen };
  }

  it('the traceparent is a header on the actual request, and a JSON-RPC error is an ERROR span with its class', async () => {
    await begin();
    const { make, seen } = rpcClient((_headers, body) => {
      const id = (body as { id?: unknown }).id;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found', data: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = await make();
    await expect(client.getTask({ tenant: '', id: 'missing' } as never)).rejects.toBeInstanceOf(Error);

    const span = only('GetTask weather-agent');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('traceparent')).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(String(span.attributes['error.type'])).toMatch(/Error$/);
    expect(span.attributes['a2a.protocol.binding']).toBe('jsonrpc');
    expect(span.attributes['a2a.task.id']).toBe('missing');
  });

  it('a surface in a real JSON-RPC reply, decoded by the SDK, reaches the span', async () => {
    await begin();
    const surfaceMessages = [{ version: '1.0', createSurface: { surfaceId: 'wire', catalogId: 'cat-w' } }];
    const { make } = rpcClient((_headers, body) => {
      const id = (body as { id?: unknown }).id;
      const task = {
        id: 'task-w',
        contextId: 'ctx-w',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'ui', parts: [{ data: surfaceMessages, mediaType: 'application/a2ui+json' }] }],
      };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { task } }));
    });
    const client = await make();
    await client.sendMessage({ tenant: '', message: { messageId: 'm', contextId: '', taskId: '', role: 1, parts: [], extensions: [], referenceTaskIds: [] } } as never);
    const span = only('SendMessage weather-agent');
    expect(span.attributes).toMatchObject({
      'a2a.task.id': 'task-w',
      'a2a.task.state': 'completed',
      'a2ui.agent_message.count': 1,
      'a2ui.surface.id': 'wire',
      'a2ui.catalog.id': 'cat-w',
    });
  });

  it('propagation off: the request carries no traceparent', async () => {
    await begin({}, { a2aPropagate: false });
    const { make, seen } = rpcClient((_headers, body) => new Response(JSON.stringify({ jsonrpc: '2.0', id: (body as { id?: unknown }).id, error: { code: -32603, message: 'x' } })));
    const client = await make();
    await client.getTask({ tenant: '', id: 'x' } as never).catch(() => undefined);
    expect(seen[0]?.headers.get('traceparent')).toBeNull();
  });
});

describe('not there, or switched off', () => {
  it('a module that is not the SDK is not patched, and nothing throws', async () => {
    await begin();
    expect(a2aClientInstrumentor().instrumentModule({})).toBe(false);
    expect(a2aClientInstrumentor().instrumentModule(undefined)).toBe(false);
    expect(a2aClientInstrumentor().instrumentModule({ Client: class {} })).toBe(false);
  });

  it('after uninstrument() the client is the SDK\'s again: no span, no header', async () => {
    await begin();
    await harness.stop();
    const { transport, calls } = stubTransport({});
    await clientFor(transport).sendMessage(request([part('x')]) as never);
    expect(calls[0]?.options?.serviceParameters?.traceparent).toBeUndefined();
    harness = await startHarness({ enabledInstrumentors: ['a2a'] });
    expect(harness.spans()).toEqual([]);
  });

  it('a2a is in the default instrumentor list, and starting it alongside a2ui is not an error', async () => {
    expect(DEFAULT_INSTRUMENTORS).toEqual(expect.arrayContaining(['a2a', 'a2ui']));
    harness = await startHarness({ enabledInstrumentors: ['a2a', 'a2ui'] });
    const { transport } = stubTransport({});
    await clientFor(transport).sendMessage(request([part('x')]) as never);
    expect(harness.spans().map((span) => span.name)).toEqual(['SendMessage weather-agent']);
    expect(harness.logs.error.filter((line) => /a2a/i.test(line))).toEqual([]);
  });
});

describe('server address', () => {
  it('host and port from an interface URL, with the scheme default', () => {
    expect(serverAddress('https://agents.example:8443/a2a')).toEqual({ 'server.address': 'agents.example', 'server.port': 8443 });
    expect(serverAddress('https://agents.example/a2a')).toEqual({ 'server.address': 'agents.example', 'server.port': 443 });
    expect(serverAddress('http://Agents.Example/a2a')).toEqual({ 'server.address': 'agents.example', 'server.port': 80 });
    expect(serverAddress('grpc.example:50051')).toEqual({ 'server.address': 'grpc.example', 'server.port': 50051 });
    expect(serverAddress('http://[::1]:9000/x')).toEqual({ 'server.address': '::1', 'server.port': 9000 });
    expect(serverAddress('https://user:pw@host.example/x')).toEqual({ 'server.address': 'host.example', 'server.port': 443 });
    expect(serverAddress('')).toEqual({});
    expect(serverAddress(42)).toEqual({});
  });
});
