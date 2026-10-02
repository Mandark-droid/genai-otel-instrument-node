/**
 * OpenAI Agents (`@openai/agents`), Google ADK (`@google/adk`) and Bedrock
 * Agents (`@aws-sdk/client-bedrock-agent-runtime`).
 *
 * The agent frameworks run for real, with a model defined here in place of a
 * provider. The Bedrock client runs for real against the mock HTTP server.
 */
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  RetrieveAndGenerateCommand,
  RetrieveCommand,
  type BedrockAgentRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { BaseLlm, InMemoryRunner, LlmAgent } from '@google/adk';
import { Agent, Runner, Usage, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';
import { SpanStatusCode } from '@opentelemetry/api';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withSession } from '../../src/session';
import { EVENT_STREAM_HEADERS, eventFrame } from '../helpers/eventstream';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let harness: Harness;

afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
  }
});

describe('OpenAI Agents', () => {
  /** A model of the framework's own interface that answers from memory. */
  class StandInModel implements Model {
    fail = false;
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
      if (this.fail) throw new Error('model unavailable');
      return {
        usage: new Usage({ requests: 1, inputTokens: 21, outputTokens: 4, totalTokens: 25 }),
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Paris.' }] }],
        responseId: 'resp-1',
      };
    }
    // eslint-disable-next-line require-yield
    async *getStreamedResponse(): AsyncIterable<never> {
      throw new Error('not used');
    }
  }

  const agent = (model: Model): Agent =>
    new Agent({ name: 'geographer', instructions: 'Answer in one word. The secret code is 1234.', model, tools: [], handoffs: [] });

  it('a run is an agent span: name, model, turn limit as the iteration budget; nothing of the prompt', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai_agents'] });
    const result = await new Runner({ tracingDisabled: true }).run(agent(new StandInModel()), 'What is the capital of France?', { maxTurns: 6 });
    expect(result.finalOutput).toBe('Paris.');

    const span = harness.span('openai_agents.runner.run');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'openai_agents',
      'gen_ai.operation.name': 'agent.run',
      'openai.agent.name': 'geographer',
      'gen_ai.agent.name': 'geographer',
      'gen_ai.request.model': 'geographer',
      'gen_ai.agent.iteration_budget': 6,
      'openai.agent.input_length': 30,
      'openai.agent.output_length': 6,
    });
    for (const key of ['openai.agent.instructions', 'openai.agent.input', 'openai.agent.output']) expect(key in span.attributes, key).toBe(false);
    expect(JSON.stringify(span.attributes)).not.toContain('1234');
  });

  it('with content capture on, instructions, input and output are recorded, bounded', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai_agents'], enableContentCapture: true, contentMaxLength: 10 });
    await new Runner({ tracingDisabled: true }).run(agent(new StandInModel()), 'What is the capital of France?');
    expect(harness.span('openai_agents.runner.run').attributes).toMatchObject({
      'openai.agent.instructions': 'Answer in ',
      'openai.agent.input': 'What is th',
      'openai.agent.output': 'Paris.',
    });
  });

  it('a run that fails ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai_agents'] });
    const model = new StandInModel();
    model.fail = true;
    await expect(new Runner({ tracingDisabled: true }).run(agent(model), 'hi')).rejects.toThrow('model unavailable');
    expect(harness.span('openai_agents.runner.run').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('Google ADK', () => {
  class StandInLlm extends BaseLlm {
    constructor() {
      super({ model: 'stand-in-model' });
    }
    async *generateContentAsync(): AsyncGenerator<never, void> {
      yield { content: { role: 'model', parts: [{ text: 'Paris.' }] }, turnComplete: true } as never;
    }
    async connect(): Promise<never> {
      throw new Error('not used');
    }
  }

  it('a runner run is an agent span over the whole event stream, with the app, the agent and the session', async () => {
    harness = await startHarness({ enabledInstrumentors: ['google_adk'] });
    const runner = new InMemoryRunner({ agent: new LlmAgent({ name: 'geographer', model: new StandInLlm(), instruction: 'One word.' }), appName: 'geo-app' });
    await runner.sessionService.createSession({ appName: 'geo-app', userId: 'u-1', sessionId: 'adk-session-5' });

    const texts: string[] = [];
    for await (const event of runner.runAsync({ userId: 'u-1', sessionId: 'adk-session-5', newMessage: { role: 'user', parts: [{ text: 'Capital of France?' }] } })) {
      for (const part of event.content?.parts ?? []) if (part.text) texts.push(part.text);
    }
    expect(texts.join('')).toContain('Paris.');

    const span = harness.span('google_adk.runner.run');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'google_adk',
      'gen_ai.operation.name': 'runner.run',
      'google_adk.app_name': 'geo-app',
      'google_adk.agent.name': 'geographer',
      'gen_ai.agent.name': 'geographer',
      'google_adk.user_id': 'u-1',
      'google_adk.session_id': 'adk-session-5',
      'session.id': 'adk-session-5',
      'gen_ai.conversation.id': 'adk-session-5',
    });
    expect('google_adk.input_message' in span.attributes).toBe(false);
  });
});

describe('Bedrock Agents', () => {
  let server: MockLlm;
  beforeAll(async () => {
    server = await startMockLlm();
  });
  afterAll(async () => {
    await server.close();
  });
  const client = (): BedrockAgentRuntimeClient => {
    const config: BedrockAgentRuntimeClientConfig = {
      region: 'us-east-1',
      endpoint: server.url,
      requestHandler: new NodeHttpHandler(),
      credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret-not-a-real-key' },
      maxAttempts: 1,
    };
    return new BedrockAgentRuntimeClient(config);
  };

  it('Retrieve: the knowledge base, the result count, and the query only with content capture on', async () => {
    harness = await startHarness({ enabledInstrumentors: ['bedrock_agents'] });
    server.reply({ json: { retrievalResults: [{ content: { text: 'a' }, score: 0.9 }, { content: { text: 'b' }, score: 0.5 }] } });
    const output = await client().send(
      new RetrieveCommand({
        knowledgeBaseId: 'KB123',
        retrievalQuery: { text: 'refund policy' },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 2, overrideSearchType: 'HYBRID' } },
      }),
    );
    expect(output.retrievalResults).toHaveLength(2);
    const span = harness.span('bedrock.agents.retrieve');
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'bedrock_agents',
      'gen_ai.operation.name': 'retrieve',
      'bedrock.knowledge_base.id': 'KB123',
      'bedrock.retrieval.number_of_results': 2,
      'bedrock.retrieval.search_type': 'HYBRID',
      'bedrock.retrieval.results_count': 2,
    });
    expect('bedrock.retrieval.query' in span.attributes).toBe(false);
  });

  it('RetrieveAndGenerate: model, session, citations', async () => {
    harness = await startHarness({ enabledInstrumentors: ['bedrock_agents'] });
    server.reply({ json: { output: { text: 'Refunds take 5 days.' }, citations: [{}, {}], sessionId: 'rag-session-1' } });
    await client().send(
      new RetrieveAndGenerateCommand({
        input: { text: 'How long do refunds take?' },
        retrieveAndGenerateConfiguration: {
          type: 'KNOWLEDGE_BASE',
          knowledgeBaseConfiguration: {
            knowledgeBaseId: 'KB123',
            modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
            generationConfiguration: { inferenceConfig: { textInferenceConfig: { temperature: 0.1, maxTokens: 200 } } },
          },
        },
      }),
    );
    const span = harness.span('bedrock.agents.retrieve_and_generate');
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'retrieve_and_generate',
      'bedrock.rag.type': 'KNOWLEDGE_BASE',
      'bedrock.knowledge_base.id': 'KB123',
      'gen_ai.request.model': 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
      'bedrock.rag.citations_count': 2,
      'bedrock.agent.response.session_id': 'rag-session-1',
      'session.id': 'rag-session-1',
      'gen_ai.response.finish_reasons': ['completed'],
    });
    expect(JSON.stringify(span.attributes)).not.toContain('Refunds take');
  });

  it('InvokeAgent: the agent, its alias and the session; the calls inside share the session', async () => {
    harness = await startHarness({ enabledInstrumentors: ['bedrock_agents'] });
    server.reply({
      headers: { ...EVENT_STREAM_HEADERS, 'x-amz-bedrock-agent-session-id': 'agent-session-9', 'x-amzn-bedrock-agent-content-type': 'application/json' },
      raw: eventFrame('chunk', { bytes: Buffer.from('Paris.').toString('base64') }),
    });
    const output = await withSession('outer-scope', () =>
      client().send(new InvokeAgentCommand({ agentId: 'AG1', agentAliasId: 'AL1', sessionId: 'agent-session-9', inputText: 'Capital of France?', enableTrace: false })),
    );
    let text = '';
    for await (const event of output.completion ?? []) text += new TextDecoder().decode(event.chunk?.bytes);
    expect(text).toBe('Paris.');
    const span = harness.span('bedrock.agents.invoke_agent');
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'bedrock_agents',
      'gen_ai.operation.name': 'invoke_agent',
      'bedrock.agent.id': 'AG1',
      'bedrock.agent.alias_id': 'AL1',
      'bedrock.agent.session_id': 'agent-session-9',
      // The agent's own session id is what the span carries, even inside another scope.
      'session.id': 'agent-session-9',
      'gen_ai.conversation.id': 'agent-session-9',
      'bedrock.agent.enable_trace': false,
      'bedrock.agent.response.has_completion': true,
    });
    expect('bedrock.agent.input_text' in span.attributes).toBe(false);
  });

  it('a failing call ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['bedrock_agents'] });
    server.reply({ status: 404, headers: { 'x-amzn-errortype': 'ResourceNotFoundException' }, json: { message: 'Knowledge base not found' } });
    await expect(client().send(new RetrieveCommand({ knowledgeBaseId: 'NOPE', retrievalQuery: { text: 'x' } }))).rejects.toThrow();
    expect(harness.span('bedrock.agents.retrieve').status.code).toBe(SpanStatusCode.ERROR);
  });
});
