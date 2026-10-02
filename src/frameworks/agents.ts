/**
 * Instrumentors for the agent frameworks: OpenAI Agents (`@openai/agents`),
 * Google ADK (`@google/adk`) and Bedrock Agents
 * (`@aws-sdk/client-bedrock-agent-runtime`). Ports of
 * `openai_agents_instrumentor.py`, `google_adk_instrumentor.py` and
 * `bedrock_agents_instrumentor.py`.
 *
 * As in the reference, these spans carry no tokens of their own: the model
 * calls made inside them do, and are accounted to the run's budget.
 */
import { extractBudgetAttributes } from '../agent-budget';
import type { PatchTarget } from '../instrumentors/patching';
import { exportedClass, prototypeDefining } from '../instrumentors/wrap';
import { ATTR } from '../semconv';
import { FrameworkInstrumentor, isObject, type Obj } from './base';

function pick(source: unknown, ...keys: string[]): unknown {
  if (!isObject(source)) return undefined;
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

const nameOf = (item: unknown): string => {
  const name = pick(item, 'name', 'agentName', 'toolName');
  if (typeof name === 'string' && name) return name;
  return isObject(item) ? item.constructor.name : String(item).slice(0, 50);
};

/** The text of a message given as a string, or as `{ parts: [{ text }] }`. */
function firstText(message: unknown): string | undefined {
  if (typeof message === 'string') return message;
  const parts = pick(message, 'parts');
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const text = pick(part, 'text');
    if (typeof text === 'string' && text) return text;
  }
  return undefined;
}

export class OpenAIAgentsInstrumentor extends FrameworkInstrumentor {
  protected readonly label = 'OpenAI Agents SDK';
  protected readonly packages = ['@openai/agents-core', '@openai/agents'];
  protected override get owner(): string {
    return 'openai_agents';
  }

  protected targets(module: unknown): PatchTarget[] {
    const runner: unknown = exportedClass(module, 'Runner');
    if (typeof runner !== 'function') return [];
    return [
      {
        // `run()` of the package and `Runner.run` both arrive here.
        holder: prototypeDefining(runner, 'run'),
        method: 'run',
        spanName: 'openai_agents.runner.run',
        attributes: (instance, args) => this.runAttributes(instance, args),
        options: { params: () => ({}) },
      },
    ];
  }

  private runAttributes(instance: unknown, args: unknown[]): Obj {
    const [agent, input, options] = args;
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'openai_agents',
      [ATTR.GEN_AI_OPERATION_NAME]: 'agent.run',
      ...extractBudgetAttributes(options, pick(instance, 'config'), instance),
    };
    if (isObject(agent)) {
      if (typeof agent.name === 'string') {
        attributes['openai.agent.name'] = agent.name;
        attributes[ATTR.GEN_AI_AGENT_NAME] = agent.name;
        // The reference uses the agent's name as the "model" of the run.
        attributes[ATTR.GEN_AI_REQUEST_MODEL] = agent.name;
      }
      if (typeof agent.model === 'string' && agent.model) attributes['openai.agent.model'] = agent.model;
      if (typeof agent.instructions === 'string') attributes['openai.agent.instructions'] = this.content(agent.instructions, 500);
      if (Array.isArray(agent.tools) && agent.tools.length > 0) {
        attributes['openai.agent.tools'] = agent.tools.map(nameOf);
        attributes['openai.agent.tool_count'] = agent.tools.length;
      }
      if (Array.isArray(agent.handoffs) && agent.handoffs.length > 0) {
        attributes['openai.agent.handoffs'] = agent.handoffs.map(nameOf);
        attributes['openai.agent.handoff_count'] = agent.handoffs.length;
      }
      const guardrails = [agent.guardrails, agent.inputGuardrails, agent.outputGuardrails].reduce<number>(
        (count, list) => count + (Array.isArray(list) ? list.length : 0),
        0,
      );
      if (guardrails > 0) {
        attributes['openai.agent.guardrails_enabled'] = true;
        attributes['openai.agent.guardrail_count'] = guardrails;
      }
    }
    if (typeof input === 'string' && input) {
      attributes['openai.agent.input'] = this.content(input, 500);
      attributes['openai.agent.input_length'] = input.length;
    } else if (Array.isArray(input) && input.length > 0) {
      attributes['openai.agent.input'] = this.content(JSON.stringify(input), 500);
    }
    const session = pick(options, 'session');
    if (isObject(session)) {
      const sessionId = pick(session, 'sessionId', 'session_id');
      if (typeof sessionId === 'string' && sessionId) {
        attributes['openai.session.id'] = sessionId;
        attributes[ATTR.SESSION_ID] = sessionId;
      }
      attributes['openai.session.type'] = session.constructor.name;
    }
    return attributes;
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    const output = pick(result, 'finalOutput', 'final_output');
    if (output !== undefined) {
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      attributes['openai.agent.output'] = this.content(text, 500);
      attributes['openai.agent.output_length'] = text.length;
    }
    for (const list of [result.inputGuardrailResults, result.outputGuardrailResults]) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const violations = list.filter((entry) => pick(pick(entry, 'output'), 'tripwireTriggered') === true).length;
      attributes['openai.guardrail.violations'] = Number(attributes['openai.guardrail.violations'] ?? 0) + violations;
      attributes['openai.guardrail.validated'] = true;
    }
    return attributes;
  }
}

export class GoogleADKInstrumentor extends FrameworkInstrumentor {
  protected readonly label = 'Google ADK';
  protected readonly packages = ['@google/adk'];
  protected override get owner(): string {
    return 'google_adk';
  }

  protected targets(module: unknown): PatchTarget[] {
    const runner: unknown = exportedClass(module, 'Runner');
    if (typeof runner !== 'function') return [];
    return [
      {
        // An async generator of events: the span covers the run until the last one.
        holder: prototypeDefining(runner, 'runAsync'),
        method: 'runAsync',
        spanName: 'google_adk.runner.run',
        attributes: (instance, args) => this.runAttributes(instance, args),
        options: { params: () => ({}), streaming: true },
      },
    ];
  }

  private runAttributes(instance: unknown, args: unknown[]): Obj {
    const params = args[0];
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'google_adk',
      [ATTR.GEN_AI_OPERATION_NAME]: 'runner.run',
      ...extractBudgetAttributes(params, pick(params, 'runConfig', 'run_config'), instance),
    };
    const appName = pick(instance, 'appName', 'app_name');
    if (appName !== undefined) attributes['google_adk.app_name'] = String(appName);
    const agent = pick(instance, 'agent');
    if (isObject(agent)) {
      if (typeof agent.name === 'string') {
        attributes['google_adk.agent.name'] = agent.name;
        attributes[ATTR.GEN_AI_AGENT_NAME] = agent.name;
      }
      const model = typeof agent.model === 'string' ? agent.model : pick(agent.model, 'model');
      if (typeof model === 'string' && model) attributes[ATTR.GEN_AI_REQUEST_MODEL] = model;
      if (typeof agent.description === 'string' && agent.description) attributes['google_adk.agent.description'] = this.content(agent.description);
      const subAgents = pick(agent, 'subAgents', 'sub_agents');
      if (Array.isArray(subAgents) && subAgents.length > 0) {
        attributes['google_adk.sub_agent_count'] = subAgents.length;
        attributes['google_adk.sub_agent_names'] = subAgents.map(nameOf).slice(0, 10);
      }
      if (Array.isArray(agent.tools) && agent.tools.length > 0) {
        attributes['google_adk.tools'] = agent.tools.map(nameOf).slice(0, 10);
        attributes['google_adk.tool_count'] = agent.tools.length;
      }
    }
    const userId = pick(params, 'userId', 'user_id');
    if (userId) attributes['google_adk.user_id'] = String(userId);
    const sessionId = pick(params, 'sessionId', 'session_id');
    if (sessionId) {
      attributes['google_adk.session_id'] = String(sessionId);
      attributes[ATTR.SESSION_ID] = String(sessionId);
      attributes[ATTR.GEN_AI_CONVERSATION_ID] = String(sessionId);
    }
    const text = firstText(pick(params, 'newMessage', 'new_message'));
    if (text) attributes['google_adk.input_message'] = this.content(text);
    return attributes;
  }
}

const AGENT_SPANS: Readonly<Record<string, string>> = {
  InvokeAgentCommand: 'bedrock.agents.invoke_agent',
  RetrieveCommand: 'bedrock.agents.retrieve',
  RetrieveAndGenerateCommand: 'bedrock.agents.retrieve_and_generate',
};

const commandName = (command: unknown): string => (isObject(command) && typeof command.constructor === 'function' ? command.constructor.name : '');

export class BedrockAgentsInstrumentor extends FrameworkInstrumentor {
  protected readonly label = 'AWS Bedrock Agents';
  protected readonly packages = ['@aws-sdk/client-bedrock-agent-runtime'];
  protected override get owner(): string {
    return 'bedrock_agents';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'BedrockAgentRuntimeClient');
    if (typeof client !== 'function') return [];
    return [
      {
        // Defined on this client's prototype alone, not on the base class every AWS client shares.
        holder: (client as { prototype: object }).prototype,
        method: 'send',
        attributes: (_instance, args, params) => this.commandAttributes(commandName(args[0]), params),
        options: {
          params: (args) => (isObject(args[0]) && isObject(args[0].input) ? args[0].input : {}),
          spanName: (_params, args) => AGENT_SPANS[commandName(args[0])] ?? 'bedrock.agents.send',
        },
      },
    ];
  }

  /** The three operations the reference traces; every other command passes through. */
  protected override shouldBypass(_instance: unknown, args: unknown[]): boolean {
    return !(commandName(args[0]) in AGENT_SPANS);
  }

  private commandAttributes(command: string, input: Obj): Obj {
    const attributes: Obj = { [ATTR.GEN_AI_SYSTEM]: 'bedrock_agents' };
    const session = (key: string): void => {
      if (typeof input.sessionId !== 'string' || !input.sessionId) return;
      attributes[key] = input.sessionId;
      attributes[ATTR.SESSION_ID] = input.sessionId;
      attributes[ATTR.GEN_AI_CONVERSATION_ID] = input.sessionId;
    };
    if (command === 'InvokeAgentCommand') {
      attributes[ATTR.GEN_AI_OPERATION_NAME] = 'invoke_agent';
      if (input.agentId !== undefined) attributes['bedrock.agent.id'] = String(input.agentId);
      if (input.agentAliasId !== undefined) attributes['bedrock.agent.alias_id'] = String(input.agentAliasId);
      session('bedrock.agent.session_id');
      if (input.inputText !== undefined) attributes['bedrock.agent.input_text'] = this.content(input.inputText, 500);
      const state = input.sessionState;
      if (isObject(state)) {
        if ('promptSessionAttributes' in state) attributes['bedrock.agent.prompt_attributes'] = this.content(JSON.stringify(state.promptSessionAttributes));
        if ('sessionAttributes' in state) attributes['bedrock.agent.session_attributes'] = this.content(JSON.stringify(state.sessionAttributes));
      }
      if (typeof input.enableTrace === 'boolean') attributes['bedrock.agent.enable_trace'] = input.enableTrace;
    } else if (command === 'RetrieveCommand') {
      attributes[ATTR.GEN_AI_OPERATION_NAME] = 'retrieve';
      if (input.knowledgeBaseId !== undefined) attributes['bedrock.knowledge_base.id'] = String(input.knowledgeBaseId);
      attributes['bedrock.retrieval.query'] = this.content(pick(input.retrievalQuery, 'text'), 500);
      const vector = pick(input.retrievalConfiguration, 'vectorSearchConfiguration');
      const count = pick(vector, 'numberOfResults');
      if (typeof count === 'number') attributes['bedrock.retrieval.number_of_results'] = count;
      const searchType = pick(vector, 'overrideSearchType');
      if (typeof searchType === 'string') attributes['bedrock.retrieval.search_type'] = searchType;
    } else {
      attributes[ATTR.GEN_AI_OPERATION_NAME] = 'retrieve_and_generate';
      attributes['bedrock.rag.input_text'] = this.content(pick(input.input, 'text'), 500);
      session('bedrock.rag.session_id');
      const configuration = input.retrieveAndGenerateConfiguration;
      const type = pick(configuration, 'type');
      if (typeof type === 'string') attributes['bedrock.rag.type'] = type;
      const knowledgeBase = pick(configuration, 'knowledgeBaseConfiguration');
      const id = pick(knowledgeBase, 'knowledgeBaseId');
      if (id !== undefined) attributes['bedrock.knowledge_base.id'] = String(id);
      const modelArn = pick(knowledgeBase, 'modelArn');
      if (typeof modelArn === 'string') attributes[ATTR.GEN_AI_REQUEST_MODEL] = modelArn;
      // The reference reads these directly under `inferenceConfig`; the API nests them under `textInferenceConfig`.
      const inference = pick(pick(knowledgeBase, 'generationConfiguration'), 'inferenceConfig');
      const text = pick(inference, 'textInferenceConfig') ?? inference;
      const temperature = pick(text, 'temperature');
      if (typeof temperature === 'number') attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = temperature;
      const maxTokens = pick(text, 'maxTokens');
      if (typeof maxTokens === 'number') attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = maxTokens;
      const topP = pick(text, 'topP');
      if (typeof topP === 'number') attributes[ATTR.GEN_AI_REQUEST_TOP_P] = topP;
    }
    return attributes;
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;
    if (typeof result.sessionId === 'string' && result.sessionId) {
      attributes['bedrock.agent.response.session_id'] = result.sessionId;
      attributes[ATTR.SESSION_ID] = result.sessionId;
      attributes[ATTR.GEN_AI_CONVERSATION_ID] = result.sessionId;
    }
    if (typeof result.contentType === 'string') attributes['bedrock.agent.response.content_type'] = result.contentType;
    if (result.completion !== undefined) attributes['bedrock.agent.response.has_completion'] = true;
    if (Array.isArray(result.retrievalResults)) attributes['bedrock.retrieval.results_count'] = result.retrievalResults.length;
    const text = pick(result.output, 'text');
    if (text !== undefined) attributes['bedrock.rag.output_text'] = this.content(text, 500);
    if (Array.isArray(result.citations)) attributes['bedrock.rag.citations_count'] = result.citations.length;
    return attributes;
  }

  protected override extractFinishReason(result: unknown): string | null {
    if (!isObject(result)) return null;
    if (typeof result.stopReason === 'string') return result.stopReason;
    return result.output !== undefined || result.completion !== undefined ? 'completed' : null;
  }
}
