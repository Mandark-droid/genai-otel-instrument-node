/** AgentGraphSpanProcessor: the Python library's tests (tests/test_agent_graph.py), ported. */
import { type Attributes, type Context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { metrics } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentGraphSpanProcessor, agentGraphEnabled } from '../../src/agent-graph';
import * as native from '../../src/index.react-native';
import { setLogger } from '../../src/logger';

function setup() {
  const processor = new AgentGraphSpanProcessor();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [processor, new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('test');
  /** Runs `body` inside a span started under `parent`; ends it after. */
  const withSpan = (name: string, attributes: Attributes, parent: Context, body?: (ctx: Context) => void) => {
    const span = tracer.startSpan(name, { attributes }, parent);
    body?.(trace.setSpan(parent, span));
    span.end();
  };
  const spans = () => Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
  return { processor, withSpan, spans, nodes: () => (processor as unknown as { nodes: Map<string, unknown> }).nodes };
}

const agent = (name: string) => ({ 'gen_ai.agent.name': name });

describe('AgentGraphSpanProcessor', () => {
  it('a root agent gets the graph attributes without a parent', () => {
    const { withSpan, spans } = setup();
    withSpan('root', agent('planner'), ROOT_CONTEXT);
    expect(spans().root).toMatchObject({
      'agent.name': 'planner',
      'graph.node.id': 'planner',
      'graph.node.name': 'planner',
      'graph.node.display_name': 'planner',
      'openinference.span.kind': 'AGENT',
    });
    expect('graph.node.parent_id' in spans().root!).toBe(false);
  });

  it("a sub-agent's parent is the nearest enclosing agent, across non-agent spans", () => {
    const { withSpan, spans } = setup();
    withSpan('orchestrator', agent('orchestrator'), ROOT_CONTEXT, (c1) =>
      withSpan('llm', { 'gen_ai.operation.name': 'chat' }, c1, (c2) =>
        withSpan('researcher', agent('researcher'), c2, (c3) => withSpan('writer', agent('writer'), c3)),
      ),
    );
    expect(spans().researcher!['graph.node.parent_id']).toBe('orchestrator');
    expect(spans().writer!['graph.node.parent_id']).toBe('researcher');
  });

  it('non-agent spans are untouched', () => {
    const { withSpan, spans } = setup();
    withSpan('orchestrator', agent('orchestrator'), ROOT_CONTEXT, (c) => withSpan('llm', { 'gen_ai.operation.name': 'chat' }, c));
    for (const key of ['agent.name', 'graph.node.id', 'graph.node.parent_id', 'openinference.span.kind'])
      expect(key in spans().llm!).toBe(false);
  });

  it('the same agent nested is one node, not a self-loop', () => {
    const { withSpan, spans } = setup();
    withSpan('manager', agent('manager'), ROOT_CONTEXT, (c1) =>
      withSpan('task', agent('researcher'), c1, (c2) =>
        withSpan('agent', agent('researcher'), c2, (c3) => withSpan('tool_agent', agent('searcher'), c3)),
      ),
    );
    expect(spans().task!['graph.node.parent_id']).toBe('manager');
    expect(spans().agent!['graph.node.parent_id']).toBe('manager');
    expect(spans().tool_agent!['graph.node.parent_id']).toBe('researcher');
  });

  it('the same agent nested at the root stays the root', () => {
    const { withSpan, spans } = setup();
    withSpan('run', agent('assistant'), ROOT_CONTEXT, (c) => withSpan('on_messages', agent('assistant'), c));
    expect('graph.node.parent_id' in spans().on_messages!).toBe(false);
  });

  it('keys a span already has are not overwritten', () => {
    const { withSpan, spans } = setup();
    withSpan('orchestrator', agent('orchestrator'), ROOT_CONTEXT, (c) =>
      withSpan(
        'custom',
        {
          'gen_ai.agent.name': 'worker',
          'agent.name': 'Worker Agent',
          'graph.node.id': 'worker-node',
          'graph.node.name': 'Worker',
          'graph.node.parent_id': 'explicit-parent',
          'openinference.span.kind': 'CHAIN',
        },
        c,
      ),
    );
    expect(spans().custom).toMatchObject({
      'agent.name': 'Worker Agent',
      'graph.node.id': 'worker-node',
      'graph.node.name': 'Worker',
      'graph.node.display_name': 'Worker',
      'graph.node.parent_id': 'explicit-parent',
      'openinference.span.kind': 'CHAIN',
    });
  });

  it('an explicit parent id is inherited by children of the same node; an empty one means root', () => {
    const { withSpan, spans } = setup();
    withSpan('worker', { 'graph.node.id': 'worker', 'graph.node.parent_id': 'boss' }, ROOT_CONTEXT, (c) =>
      withSpan('worker_inner', agent('worker'), c),
    );
    withSpan('outer', agent('outer'), ROOT_CONTEXT, (c1) =>
      withSpan('inner', { 'gen_ai.agent.name': 'inner', 'graph.node.parent_id': '' }, c1, (c2) => withSpan('leaf', agent('inner'), c2)),
    );
    expect(spans().worker_inner!['graph.node.parent_id']).toBe('boss');
    expect(spans().inner!['graph.node.parent_id']).toBe('');
    expect('graph.node.parent_id' in spans().leaf!).toBe(false);
  });

  it('an OpenInference agent span (agent.name) counts as a parent; agent.name only from an agent key', () => {
    const { withSpan, spans } = setup();
    withSpan('oi_agent', { 'agent.name': 'oi' }, ROOT_CONTEXT, (c) => withSpan('ours', agent('ours'), c));
    withSpan('node', { 'graph.node.id': 'step-1' }, ROOT_CONTEXT);
    expect(spans().oi_agent!['graph.node.id']).toBe('oi');
    expect(spans().ours!['graph.node.parent_id']).toBe('oi');
    expect('agent.name' in spans().node!).toBe(false);
    expect(spans().node!['graph.node.name']).toBe('step-1');
  });

  it('tracking is released when spans end, and spans outside any agent are not tracked', () => {
    const { withSpan, spans, nodes } = setup();
    withSpan('orchestrator', agent('orchestrator'), ROOT_CONTEXT, (c) => {
      withSpan('llm', {}, c, () => expect(nodes().size).toBe(2));
      withSpan('sibling', agent('sibling'), c);
    });
    expect(nodes().size).toBe(0);
    expect(spans().sibling!['graph.node.parent_id']).toBe('orchestrator');
    withSpan('plain', {}, ROOT_CONTEXT, (c) => withSpan('child', {}, c, () => expect(nodes().size).toBe(0)));
  });

  it('GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES: on by default, off with false', () => {
    expect(agentGraphEnabled(undefined)).toBe(true);
    expect(agentGraphEnabled('true')).toBe(true);
    expect(agentGraphEnabled('FALSE')).toBe(false);
  });
});

describe('agent graph through the React Native entry', () => {
  afterEach(async () => {
    await native.uninstrument(0.2);
    trace.disable();
    metrics.disable();
    setLogger(undefined);
  });

  it('a skill run inside an agent run is its child node, across await', async () => {
    setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
    const exporter = new InMemorySpanExporter();
    native.instrument({
      serviceName: 'graph-test',
      endpoint: 'https://collector.example',
      fetch: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    await native.traceAgent('assistant', {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await native.traceAgent('skill:morning-briefing', {}, async () => native.traceTool('tasks.list', {}, async () => []));
    });
    const by = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(by['invoke_agent assistant']).toMatchObject({ 'graph.node.id': 'assistant', 'agent.name': 'assistant' });
    expect(by['invoke_agent skill:morning-briefing']).toMatchObject({
      'graph.node.id': 'skill:morning-briefing',
      'graph.node.parent_id': 'assistant',
    });
    expect('graph.node.id' in by['execute_tool tasks.list']!).toBe(false);
  });

  it('can be turned off', async () => {
    const exporter = new InMemorySpanExporter();
    native.instrument({
      serviceName: 'graph-test',
      endpoint: 'https://collector.example',
      fetch: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES: 'false',
    });
    await native.traceAgent('assistant', {}, async () => 1);
    expect('graph.node.id' in exporter.getFinishedSpans()[0]!.attributes).toBe(false);
  });
});
