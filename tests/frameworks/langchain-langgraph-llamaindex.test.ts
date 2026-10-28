/**
 * LangChain, LangGraph and LlamaIndex: the real framework classes, with a
 * chat model, graph nodes and a query engine defined here so that no provider
 * is called.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { BaseQueryEngine } from 'llamaindex';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { withSession } from '../../src/session';
import { startHarness, type Harness } from '../helpers/harness';

let harness: Harness;

afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
  }
});

/** A chat model of the real base class that answers from memory. Named so the provider is recognised. */
class ChatOpenAIStandIn extends BaseChatModel {
  model = 'gpt-4o-mini';
  fail = false;

  _llmType(): string {
    return 'stand-in';
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    if (this.fail) throw new Error('rate limited');
    const message = new AIMessage({ content: 'Paris.', usage_metadata: { input_tokens: 19, output_tokens: 9, total_tokens: 28 } });
    return { generations: [{ text: 'Paris.', message }] };
  }

  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    yield new ChatGenerationChunk({ text: 'Par', message: new AIMessageChunk({ content: 'Par' }) });
    yield new ChatGenerationChunk({
      text: 'is.',
      message: new AIMessageChunk({ content: 'is.', usage_metadata: { input_tokens: 19, output_tokens: 9, total_tokens: 28 } }),
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('LangChain', () => {
  it('chat model invoke: provider from the class name, model, message count, tokens, cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain'] });
    const result = await new ChatOpenAIStandIn({}).invoke([new HumanMessage('What is the capital of France?')]);
    expect(result.content).toBe('Paris.');
    const span = harness.span('langchain.chat_model.invoke');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.message_count': 1,
      'langchain.chat_model.name': 'gpt-4o-mini',
      'langchain.chat_model.operation': 'invoke',
      'langchain.chat_model.provider': 'openai',
      'langchain.chat_model.message_count': 1,
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.cost.total': getDefaultCostCalculator().calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat'),
    });
    // With no session known, one is generated - as the reference does.
    expect(String(span.attributes['session.id'])).toMatch(UUID);
    expect(span.attributes['langchain.session.id']).toBe(span.attributes['session.id']);
  });

  it('a session in scope is used instead of a generated one; one in the call options wins over it', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain'] });
    const model = new ChatOpenAIStandIn({});
    await withSession('chat-7', () => model.invoke([new HumanMessage('hi')]));
    expect(harness.span('langchain.chat_model.invoke').attributes['session.id']).toBe('chat-7');
    harness.reset();
    await withSession('chat-7', () => model.invoke([new HumanMessage('hi')], { configurable: { session_id: 'explicit-9' } }));
    expect(harness.span('langchain.chat_model.invoke').attributes['session.id']).toBe('explicit-9');
  });

  it('a chain is a span named for its class, with the model call inside it', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain'] });
    const chain = ChatPromptTemplate.fromTemplate('Capital of {country}?').pipe(new ChatOpenAIStandIn({}));
    await chain.invoke({ country: 'France' });
    const chainSpan = harness.span('langchain.chain.RunnableSequence');
    expect(chainSpan.attributes['langchain.chain.type']).toBe('RunnableSequence');
    const modelSpan = harness.span('langchain.chat_model.invoke');
    expect(modelSpan.parentSpanContext?.spanId).toBe(chainSpan.spanContext().spanId);
    // One session for the chain and what runs inside it.
    expect(modelSpan.attributes['session.id']).toBe(chainSpan.attributes['session.id']);
  });

  it('batch: one span with the batch size', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain'] });
    await new ChatOpenAIStandIn({}).batch([[new HumanMessage('a')], [new HumanMessage('b')]]);
    const span = harness.span('langchain.chat_model.batch');
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'batch',
      'langchain.chat_model.operation': 'batch',
      'langchain.chat_model.batch_size': 2,
    });
  });

  it('stream: open until the stream is read to the end, with the usage of the final chunk', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain'] });
    let text = '';
    for await (const chunk of await new ChatOpenAIStandIn({}).stream([new HumanMessage('hi')])) text += String(chunk.content);
    expect(text).toBe('Paris.');
    const span = harness.span('langchain.chat_model.invoke');
    expect(span.attributes['gen_ai.request.stream']).toBe(true);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(28);
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
  });

  it('a model call that fails ends the span with ERROR status and no usage', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain'] });
    const model = new ChatOpenAIStandIn({ maxRetries: 0 });
    model.fail = true;
    await expect(model.invoke([new HumanMessage('hi')])).rejects.toThrow('rate limited');
    const span = harness.span('langchain.chat_model.invoke');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });
});

describe('LangGraph', () => {
  const State = Annotation.Root({ question: Annotation<string>(), answer: Annotation<string>() });
  const graph = (): ReturnType<StateGraph<typeof State.spec>['compile']> =>
    new StateGraph(State)
      .addNode('think', async (state) => ({ answer: `about ${state.question}` }))
      .addNode('reply', async (state) => ({ answer: `${state.answer}: Paris.` }))
      .addEdge(START, 'think')
      .addEdge('think', 'reply')
      .addEdge('reply', END)
      .compile() as never;

  it('invoke: a graph-execution span with the structure, the thread as the session, and the recursion limit as the budget', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
    const result = await graph().invoke({ question: 'the capital of France' }, { configurable: { thread_id: 'thread-3' }, recursionLimit: 12 });
    expect(result.answer).toBe('about the capital of France: Paris.');
    // The run, and each node in a span of its own beneath it (Python 1.44.0).
    expect(harness.spans().map((span) => span.name).sort()).toEqual(['langgraph.graph.invoke', 'langgraph.node.reply', 'langgraph.node.think']);
    const span = harness.span('langgraph.graph.invoke');
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'langgraph',
      'gen_ai.operation.name': 'graph.execution',
      'langgraph.node_count': 2,
      // Request-side lists reach the span as text, as in the reference: its wrapper
      // stringifies every non-scalar initial attribute.
      'langgraph.nodes': "['think', 'reply']",
      'langgraph.input.keys': "['question']",
      'langgraph.thread_id': 'thread-3',
      'langgraph.recursion_limit': 12,
      'gen_ai.agent.iteration_budget': 12,
      'session.id': 'thread-3',
      'langgraph.session.id': 'thread-3',
      'gen_ai.conversation.id': 'thread-3',
      'langgraph.output.keys': ['question', 'answer'],
      'gen_ai.response.finish_reasons': ['completed'],
    });
    // State content is not recorded without content capture.
    expect(JSON.stringify(span.attributes)).not.toContain('capital of France');
  });

  it('with LangChain instrumented too, the sequences LangGraph builds around its nodes are not chain spans', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langchain', 'langgraph'] });
    const chain = ChatPromptTemplate.fromTemplate('Capital of {country}?').pipe(new ChatOpenAIStandIn({}));
    const withChain = new StateGraph(State)
      .addNode('think', async () => ({ answer: String((await chain.invoke({ country: 'France' })).content) }))
      .addEdge(START, 'think')
      .addEdge('think', END)
      .compile();
    await withChain.invoke({ question: 'x' }, { configurable: { thread_id: 'thread-8' } });
    // The application's own chain inside the node is still a span.
    expect(harness.spans().map((span) => span.name).sort()).toEqual([
      'langchain.chain.RunnableSequence',
      'langchain.chat_model.invoke',
      'langgraph.graph.invoke',
      'langgraph.node.think',
    ]);
    // What the node calls nests under the node's span.
    expect(harness.span('langchain.chain.RunnableSequence').parentSpanContext?.spanId).toBe(harness.span('langgraph.node.think').spanContext().spanId);
    // And the graph's thread is the session of everything inside the run.
    for (const span of harness.spans()) expect(span.attributes['session.id'], span.name).toBe('thread-8');
  });

  it('with content capture on, the input and output state are recorded, bounded', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'], enableContentCapture: true, contentMaxLength: 12 });
    await graph().invoke({ question: 'the capital of France' });
    const attributes = harness.span('langgraph.graph.invoke').attributes;
    expect(attributes['langgraph.output.answer']).toBe('about the ca');
  });

  it('stream: one span, closed when the stream ends', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
    const updates: unknown[] = [];
    for await (const update of await graph().stream({ question: 'x' })) updates.push(update);
    expect(updates.length).toBeGreaterThan(0);
    expect(harness.spans().map((span) => span.name).sort()).toEqual(['langgraph.graph.stream', 'langgraph.node.reply', 'langgraph.node.think']);
    expect(harness.span('langgraph.graph.stream').status.code).toBe(SpanStatusCode.OK);
  });

  it('node spans: under the run, with step, triggers and the agent graph keys; the run is the root node', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
    await graph().invoke({ question: 'x' });
    const run = harness.span('langgraph.graph.invoke');
    const think = harness.span('langgraph.node.think');
    const reply = harness.span('langgraph.node.reply');
    for (const node of [think, reply]) expect(node.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(run.attributes).toMatchObject({ 'graph.node.id': 'LangGraph', 'openinference.span.kind': 'CHAIN' });
    expect(think.attributes).toMatchObject({
      'langgraph.node': 'think',
      'graph.node.id': 'think',
      'graph.node.parent_id': 'LangGraph',
      'openinference.span.kind': 'CHAIN',
      'langgraph.node.attempt': 1,
    });
    expect(typeof think.attributes['langgraph.step']).toBe('number');
    expect(JSON.parse(String(think.attributes.metadata))).toEqual({ langgraph_node: 'think', langgraph_step: think.attributes['langgraph.step'] });
    expect(think.attributes['langgraph.triggers']).toBeDefined();
    expect(reply.attributes['langgraph.step']).toBeGreaterThan(Number(think.attributes['langgraph.step']));
  });

  it('a node paused by interrupt() is marked interrupted, not failed', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
    const asking = new StateGraph(State)
      .addNode('ask', async () => ({ answer: String(interrupt('Which city?')) }))
      .addEdge(START, 'ask')
      .addEdge('ask', END)
      .compile({ checkpointer: new MemorySaver() });
    await asking.invoke({ question: 'x' }, { configurable: { thread_id: 't-1' } });
    const ask = harness.span('langgraph.node.ask');
    expect(ask.attributes['langgraph.node.interrupted']).toBe(true);
    expect(ask.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES=false: node spans without the graph keys', async () => {
    process.env.GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES = 'false';
    try {
      harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
      await graph().invoke({ question: 'x' });
      const think = harness.span('langgraph.node.think').attributes;
      expect(think['langgraph.node']).toBe('think');
      for (const key of ['graph.node.id', 'metadata']) expect(key in think).toBe(false);
      expect('graph.node.id' in harness.span('langgraph.graph.invoke').attributes).toBe(false);
    } finally {
      delete process.env.GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES;
    }
  });

  it('an enclosing withSession scope wins over the thread; an id in the input wins over both', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
    await withSession('conv-1', () => graph().invoke({ question: 'x' }, { configurable: { thread_id: 'thread-3' } }));
    expect(harness.span('langgraph.graph.invoke').attributes['session.id']).toBe('conv-1');
    harness.reset();
    await withSession('conv-1', () => graph().invoke({ question: 'x', session_id: 'own' } as never, { configurable: { thread_id: 'thread-3' } }));
    expect(harness.span('langgraph.graph.invoke').attributes['session.id']).toBe('own');
  });

  it('a node that throws ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['langgraph'] });
    const failing = new StateGraph(State)
      .addNode('boom', async () => {
        throw new Error('tool exploded');
      })
      .addEdge(START, 'boom')
      .addEdge('boom', END)
      .compile();
    await expect(failing.invoke({ question: 'x' })).rejects.toThrow('tool exploded');
    expect(harness.span('langgraph.graph.invoke').status.code).toBe(SpanStatusCode.ERROR);
    expect(harness.span('langgraph.node.boom').status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'Error' });
  });
});

describe('LlamaIndex', () => {
  class StandInQueryEngine extends BaseQueryEngine {
    constructor() {
      super();
    }
    protected override _getPrompts(): Record<string, never> {
      return {};
    }
    protected override _updatePrompts(): void {}
    protected override _getPromptModules(): Record<string, never> {
      return {};
    }
    override async _query(): Promise<never> {
      return { message: { content: 'Paris.', role: 'assistant' }, sourceNodes: [], toString: () => 'Paris.' } as never;
    }
  }

  it('a query is a span; the query text only with content capture on', async () => {
    harness = await startHarness({ enabledInstrumentors: ['llama_index'] });
    const response = await new StandInQueryEngine().query({ query: 'What is the capital of France?' });
    expect(String(response)).toBe('Paris.');
    const span = harness.span('llamaindex.query_engine');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect('llamaindex.query' in span.attributes).toBe(false);
    await harness.stop();

    harness = await startHarness({ enabledInstrumentors: ['llama_index'], enableContentCapture: true });
    await new StandInQueryEngine().query({ query: 'What is the capital of France?' });
    expect(harness.span('llamaindex.query_engine').attributes['llamaindex.query']).toBe('What is the capital of France?');
  });
});
