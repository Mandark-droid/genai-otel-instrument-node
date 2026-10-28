/**
 * Instrumentors for LangChain (`@langchain/core`), LangGraph
 * (`@langchain/langgraph`) and LlamaIndex (`llamaindex`). Ports of
 * `langchain_instrumentor.py`, `langgraph_instrumentor.py` and
 * `llamaindex_instrumentor.py`.
 *
 * LangChain: `BaseChatModel.invoke` / `batch` / stream, and runnable
 * sequences as the chains of the JavaScript library. As in the reference, a
 * chat-model span carries the tokens and cost the model reported; when the
 * model is a provider client this SDK also instruments, that provider's span
 * carries them too - sum one or the other, not both.
 *
 * LangGraph: `invoke` and `stream` of a compiled graph, as agent invocations
 * (`graph.execution`), so the model calls inside are accounted to the run.
 */
import { context, createContextKey, type AttributeValue, SpanStatusCode, trace } from '@opentelemetry/api';
import { agentGraphEnabled } from '../agent-graph';
import { extractBudgetAttributes } from '../agent-budget';
import type { UsageDict } from '../instrumentors/base';
import type { PatchTarget } from '../instrumentors/patching';
import { exportedClass, prototypeDefining } from '../instrumentors/wrap';
import { ATTR } from '../semconv';
import { FrameworkInstrumentor, isObject, type Obj } from './base';

type AnyFunction = (...args: never[]) => unknown;

const PROVIDERS: readonly (readonly [string, string])[] = [
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google', 'google'],
  ['ollama', 'ollama'],
  ['bedrock', 'bedrock'],
  ['cohere', 'cohere'],
  ['groq', 'groq'],
  ['mistral', 'mistral'],
];

function pick(source: unknown, ...keys: string[]): unknown {
  if (!isObject(source)) return undefined;
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

/** A sequence LangGraph assembled around a node (the node, then its channel writes), not a chain the application built. */
function isGraphPlumbing(sequence: unknown): boolean {
  if (!isObject(sequence)) return false;
  const steps = [sequence.first, ...(Array.isArray(sequence.middle) ? (sequence.middle as unknown[]) : []), sequence.last];
  return steps.some((step) => isObject(step) && Array.isArray(step.lc_namespace) && step.lc_namespace[0] === 'langgraph');
}

export class LangChainInstrumentor extends FrameworkInstrumentor {
  protected readonly label = 'LangChain';
  protected readonly packages = ['@langchain/core/language_models/chat_models', '@langchain/core/runnables'];
  protected override get owner(): string {
    return 'langchain';
  }

  protected targets(module: unknown, packageName: string): PatchTarget[] {
    if (packageName.endsWith('/runnables')) {
      const sequence: unknown = exportedClass(module, 'RunnableSequence');
      if (typeof sequence !== 'function') return [];
      return [
        {
          holder: prototypeDefining(sequence, 'invoke'),
          method: 'invoke',
          wrap: (original) =>
            this.operationWrapperNamed(
              (instance) => `langchain.chain.${isObject(instance) ? instance.constructor.name : 'Runnable'}`,
              (instance, args) => {
                const sessionId = this.sessionOf(instance, args);
                return {
                  'langchain.chain.type': isObject(instance) ? instance.constructor.name : 'Runnable',
                  [ATTR.SESSION_ID]: sessionId,
                  'langchain.session.id': sessionId,
                  [ATTR.GEN_AI_CONVERSATION_ID]: sessionId,
                };
              },
            )(original),
        },
      ];
    }
    const model: unknown = exportedClass(module, 'BaseChatModel');
    if (typeof model !== 'function') return [];
    const prototype = (model as { prototype: object }).prototype;
    return [
      {
        holder: prototype,
        method: 'invoke',
        spanName: 'langchain.chat_model.invoke',
        attributes: (instance, args) => this.chatAttributes(instance, args, 'invoke'),
        options: { params: () => ({}) },
      },
      {
        // Inherited from Runnable; wrapped here it becomes the chat model's own.
        holder: prototype,
        method: 'batch',
        spanName: 'langchain.chat_model.batch',
        attributes: (instance, args) => this.batchAttributes(instance, args),
        options: { params: () => ({}) },
      },
      {
        // `stream()` runs through this generator.
        holder: prototype,
        method: '_streamIterator',
        // Streaming does not change the span name (SDK_ADDITIONS.md section 7); `gen_ai.request.stream` says it.
        spanName: 'langchain.chat_model.invoke',
        attributes: (instance, args) => ({ ...this.chatAttributes(instance, args, 'stream'), [ATTR.GEN_AI_REQUEST_STREAM]: true }),
        options: { params: () => ({}), streaming: true },
      },
    ];
  }

  /** A span around an operation whose name depends on the instance. */
  private operationWrapperNamed(
    name: (instance: unknown) => string,
    attributes: (instance: unknown, args: unknown[]) => Record<string, AttributeValue | undefined>,
  ): (original: AnyFunction) => AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return (original) => {
      const byName = new Map<string, AnyFunction>();
      return function (this: unknown, ...args: unknown[]): unknown {
        // LangGraph runs every node as a sequence of its own: the graph span covers those.
        if (isGraphPlumbing(this)) return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
        const spanName = name(this);
        let wrapped = byName.get(spanName);
        if (!wrapped) {
          wrapped = instrumentor.operationWrapper(spanName, attributes)(original);
          byName.set(spanName, wrapped);
        }
        return (wrapped as unknown as (...a: unknown[]) => unknown).apply(this, args);
      } as unknown as AnyFunction;
    };
  }

  private sessionOf(instance: unknown, args: unknown[]): string | undefined {
    const options = args[1];
    const configurable = pick(options, 'configurable');
    return this.resolveSessionId(
      [pick(options, 'session_id', 'session.id'), pick(configurable, 'session_id', 'session.id'), pick(args[0], 'session_id', 'session.id')],
      instance,
      args,
      true,
    );
  }

  private modelName(instance: unknown): string {
    for (const key of ['modelName', 'model_name', 'model', 'modelId', 'model_id']) {
      const value = isObject(instance) ? instance[key] : undefined;
      if (typeof value === 'string' && value) return value;
    }
    return isObject(instance) ? instance.constructor.name : 'unknown';
  }

  /** From the class name, then from where the class lives. */
  private provider(instance: unknown): string | undefined {
    if (!isObject(instance)) return undefined;
    const className = instance.constructor.name.toLowerCase();
    for (const [key, value] of PROVIDERS) if (className.includes(key)) return value;
    const namespace = Array.isArray(instance.lc_namespace) ? instance.lc_namespace.join('.').toLowerCase() : '';
    for (const [key, value] of PROVIDERS) if (namespace.includes(key)) return value;
    return undefined;
  }

  private chatAttributes(instance: unknown, args: unknown[], operation: string): Obj {
    const provider = this.provider(instance);
    const model = this.modelName(instance);
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: provider ?? 'langchain',
      [ATTR.GEN_AI_REQUEST_MODEL]: model,
      [ATTR.GEN_AI_OPERATION_NAME]: 'chat',
      'langchain.chat_model.name': model,
      'langchain.chat_model.operation': operation,
    };
    if (provider) attributes['langchain.chat_model.provider'] = provider;
    const messages = args[0];
    if (Array.isArray(messages) || typeof messages === 'string') {
      const count = messages.length;
      attributes[ATTR.GEN_AI_REQUEST_MESSAGE_COUNT] = count;
      attributes['langchain.chat_model.message_count'] = count;
    }
    const sessionId = this.sessionOf(instance, args);
    attributes[ATTR.SESSION_ID] = sessionId;
    attributes['langchain.session.id'] = sessionId;
    return attributes;
  }

  private batchAttributes(instance: unknown, args: unknown[]): Obj {
    const provider = this.provider(instance);
    const model = this.modelName(instance);
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: provider ?? 'langchain',
      [ATTR.GEN_AI_REQUEST_MODEL]: model,
      [ATTR.GEN_AI_OPERATION_NAME]: 'batch',
      'langchain.chat_model.name': model,
      'langchain.chat_model.operation': 'batch',
    };
    if (Array.isArray(args[0])) attributes['langchain.chat_model.batch_size'] = args[0].length;
    const sessionId = this.sessionOf(instance, args);
    attributes[ATTR.SESSION_ID] = sessionId;
    attributes['langchain.session.id'] = sessionId;
    return attributes;
  }

  /** `usage_metadata` on the message, else the provider's own block under `response_metadata`. */
  protected override extractUsage(result: unknown): UsageDict | null {
    if (!isObject(result)) return null;
    let usage: unknown = result.usage_metadata;
    if (!isObject(usage) && isObject(result.response_metadata)) {
      usage = result.response_metadata.tokenUsage ?? result.response_metadata.token_usage ?? result.response_metadata.usage;
    }
    if (!isObject(usage)) return null;
    const prompt = Number(usage.input_tokens || usage.prompt_tokens || usage.promptTokens || 0);
    const completion = Number(usage.output_tokens || usage.completion_tokens || usage.completionTokens || 0);
    if (!prompt && !completion) return null;
    return { prompt_tokens: Math.trunc(prompt), completion_tokens: Math.trunc(completion), total_tokens: Math.trunc(prompt) + Math.trunc(completion) };
  }
}

const GRAPH_RUNNING = createContextKey('traceverse.genai-otel-instrument.langgraph-running');
// Runners and tasks already decorated, so a re-entered run does not stack spans.
const decorated = new WeakSet<object>();

/** LangGraph's GraphBubbleUp family (interrupt, parent commands): `is_bubble_up` on the error. */
function isGraphBubbleUp(error: unknown): boolean {
  return isObject(error) && (error as { is_bubble_up?: unknown }).is_bubble_up === true;
}

function clean(attributes: Obj): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== null) out[key] = value as AttributeValue;
  return out;
}

export class LangGraphInstrumentor extends FrameworkInstrumentor {
  protected readonly label = 'LangGraph';
  protected readonly packages = ['@langchain/langgraph'];
  protected override get owner(): string {
    return 'langgraph';
  }

  protected targets(module: unknown): PatchTarget[] {
    const graph: unknown = exportedClass(module, 'CompiledStateGraph');
    if (typeof graph !== 'function') return [];
    return [...this.runTargets(graph), ...this.nodeTargets(graph)];
  }

  /**
   * A span per node execution (Python 1.44.0 wraps `run_with_retry`). Here the run loop, a method
   * of the exported Pregel class in both the CommonJS and the ES-module build, hands each step's
   * tasks to its runner, which calls `task.proc.invoke(input, config)`: each task's `proc` is
   * wrapped as the runner picks it up, so what the node calls nests under its span. These are
   * LangGraph internals; a version that moved them loses node spans and nothing else.
   */
  private nodeTargets(graph: unknown): PatchTarget[] {
    const holder = prototypeDefining(graph, '_runLoop');
    if (!holder) return [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return [
      {
        holder,
        method: '_runLoop',
        wrap: (original: AnyFunction): AnyFunction =>
          function (this: unknown, ...args: unknown[]): unknown {
            try {
              instrumentor.decorateRunner(args[0]);
            } catch {
              // tracing must never cost the graph its run
            }
            return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
          } as unknown as AnyFunction,
      },
    ];
  }

  private decorateRunner(params: unknown): void {
    const runner = isObject(params) ? params.runner : undefined;
    const loop = isObject(params) ? params.loop : undefined;
    if (!isObject(runner) || !isObject(loop) || typeof runner.tick !== 'function' || decorated.has(runner)) return;
    const tick = runner.tick as (...a: unknown[]) => unknown;
    decorated.add(runner);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    runner.tick = function (this: unknown, ...args: unknown[]): unknown {
      if (instrumentor.instrumented && isObject(loop.tasks)) {
        for (const task of Object.values(loop.tasks)) instrumentor.traceTask(task);
      }
      return tick.apply(this, args);
    };
  }

  /** Span name and start attributes for a node task, or undefined to leave it untraced. */
  nodeSpan(task: unknown): [string, Obj] | undefined {
    const name = isObject(task) ? task.name : undefined;
    // __start__ writes the graph input into its channels; it is not a node.
    if (typeof name !== 'string' || !name || name.startsWith('__')) return undefined;
    const metadata = pick(pick(task, 'config'), 'metadata');
    const step = pick(metadata, 'langgraph_step');
    const attributes: Obj = { 'langgraph.node': name };
    if (typeof step === 'number' && Number.isInteger(step)) attributes['langgraph.step'] = step;
    const triggers = isObject(task) ? task.triggers : undefined;
    if (Array.isArray(triggers) && triggers.length) attributes['langgraph.triggers'] = triggers.slice(0, 10).map(String);
    if (agentGraphEnabled(process.env.GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES)) {
      attributes['graph.node.id'] = name;
      attributes['openinference.span.kind'] = 'CHAIN';
      // OpenInference's metadata attribute, which Arize reads LangGraph nodes from. Only the node
      // keys: the run metadata can hold user data.
      const nodeMetadata: Obj = { langgraph_node: name };
      if (typeof step === 'number' && Number.isInteger(step)) nodeMetadata.langgraph_step = step;
      attributes.metadata = JSON.stringify(nodeMetadata);
    }
    return [`langgraph.node.${name}`, attributes];
  }

  private traceTask(task: unknown): void {
    if (!isObject(task) || decorated.has(task) || !isObject(task.proc) || typeof task.proc.invoke !== 'function') return;
    decorated.add(task);
    const prepared = this.nodeSpan(task);
    if (!prepared) return;
    const [spanName, attributes] = prepared;
    const proc = task.proc;
    const invoke = proc.invoke as (...a: unknown[]) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    // A span per attempt: whether LangGraph retries a failed attempt is decided after it returns.
    let attempt = 0;
    const traced = Object.create(proc) as Obj;
    traced.invoke = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      attempt += 1;
      const span = instrumentor.tracer.startSpan(spanName, {
        attributes: clean({ ...attributes, 'langgraph.node.attempt': attempt }),
      });
      return context.with(trace.setSpan(context.active(), span), () => invoke.apply(proc, args)).then(
        (result) => {
          span.end();
          return result;
        },
        (error: unknown) => {
          if (isGraphBubbleUp(error)) {
            // interrupt() and Command(graph=PARENT) travel as errors; they are control flow.
            span.setAttribute('langgraph.node.interrupted', true);
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.name : typeof error });
            if (error instanceof Error) span.recordException(error);
          }
          span.end();
          throw error;
        },
      );
    };
    task.proc = traced;
  }

  /** One span per graph run (`invoke` / `stream`). */
  private runTargets(graph: unknown): PatchTarget[] {
    return (['invoke', 'stream'] as const).map((method) => ({
      holder: prototypeDefining(graph, method),
      method,
      wrap: (original: AnyFunction): AnyFunction => {
        const traced = this.createSpanWrapper(`langgraph.graph.${method}`, (instance, args) => this.graphAttributes(instance, args), {
          params: () => ({}),
          streaming: method === 'stream',
        })(original);
        return function (this: unknown, ...args: unknown[]): unknown {
          // `invoke` runs the graph through `stream`: one span for one run.
          if (context.active().getValue(GRAPH_RUNNING) === this) return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
          return context.with(context.active().setValue(GRAPH_RUNNING, this), () => (traced as unknown as (...a: unknown[]) => unknown).apply(this, args));
        } as unknown as AnyFunction;
      },
    }));
  }

  private graphAttributes(instance: unknown, args: unknown[]): Obj {
    const [input, config] = args;
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'langgraph',
      [ATTR.GEN_AI_OPERATION_NAME]: 'graph.execution',
      ...extractBudgetAttributes(config, instance),
    };
    if (agentGraphEnabled(process.env.GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES)) {
      // The run is the root node of the agent graph; its nodes hang beneath it (Python 1.44.0).
      const name = isObject(instance) ? instance.name : undefined;
      attributes['graph.node.id'] = typeof name === 'string' && name ? name : 'LangGraph';
      attributes['openinference.span.kind'] = 'CHAIN';
    }
    if (isObject(instance)) {
      const nodes = isObject(instance.nodes) ? Object.keys(instance.nodes).filter((name) => !name.startsWith('__')) : [];
      if (nodes.length > 0) {
        attributes['langgraph.node_count'] = nodes.length;
        attributes['langgraph.nodes'] = nodes.slice(0, 10);
      }
      const edges = isObject(instance.builder) ? instance.builder.edges : undefined;
      const edgeCount = edges instanceof Set ? edges.size : Array.isArray(edges) ? edges.length : 0;
      if (edgeCount > 0) attributes['langgraph.edge_count'] = edgeCount;
      const channels = isObject(instance.channels) ? Object.keys(instance.channels).filter((name) => !name.startsWith('__') && !name.includes(':')) : [];
      if (channels.length > 0) {
        attributes['langgraph.channels'] = channels.slice(0, 10);
        attributes['langgraph.channel_count'] = channels.length;
      }
    }

    if (isObject(input) && !Array.isArray(input)) {
      attributes['langgraph.input.keys'] = Object.keys(input).slice(0, 10);
      for (const key of ['messages', 'query', 'question']) {
        if (key in input) attributes[`langgraph.input.${key}`] = this.content(input[key]);
      }
    } else if (input !== undefined && input !== null) {
      attributes['langgraph.input'] = this.content(input);
    }

    const configurable = pick(config, 'configurable');
    const threadId = pick(configurable, 'thread_id');
    if (threadId !== undefined) attributes['langgraph.thread_id'] = String(threadId);
    const checkpointId = pick(configurable, 'checkpoint_id');
    if (checkpointId !== undefined) attributes['langgraph.checkpoint_id'] = String(checkpointId);
    const recursionLimit = pick(config, 'recursionLimit', 'recursion_limit');
    if (typeof recursionLimit === 'number') attributes['langgraph.recursion_limit'] = recursionLimit;

    // An id in the input, then an enclosing withSession scope, then the thread (Python 1.45.0).
    const sessionId = this.resolveSessionId(
      [pick(input, 'session_id', 'session.id')],
      instance,
      args,
      true,
      [threadId === undefined ? undefined : String(threadId)],
    );
    attributes[ATTR.SESSION_ID] = sessionId;
    attributes['langgraph.session.id'] = sessionId;
    attributes[ATTR.GEN_AI_CONVERSATION_ID] = sessionId;
    return attributes;
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result) || Array.isArray(result)) return attributes;
    attributes['langgraph.output.keys'] = Object.keys(result).slice(0, 10);
    for (const key of ['messages', 'answer', 'output']) {
      if (key in result) attributes[`langgraph.output.${key}`] = this.content(result[key]);
    }
    if (Array.isArray(result.messages)) attributes['langgraph.message_count'] = result.messages.length;
    return attributes;
  }

  protected override extractFinishReason(result: unknown): string | null {
    return result ? 'completed' : null;
  }
}

export class LlamaIndexInstrumentor extends FrameworkInstrumentor {
  protected readonly label = 'LlamaIndex';
  protected readonly packages = ['llamaindex'];
  // It warns, and its class checks break, when both of its builds are loaded.
  protected override readonly loadOnce = true;
  protected override get owner(): string {
    return 'llamaindex';
  }

  protected targets(module: unknown): PatchTarget[] {
    const engine: unknown = exportedClass(module, 'BaseQueryEngine');
    if (typeof engine !== 'function') return [];
    return [
      {
        holder: prototypeDefining(engine, 'query'),
        method: 'query',
        wrap: this.operationWrapper('llamaindex.query_engine', (_instance, args) => {
          const query = typeof args[0] === 'string' ? args[0] : pick(args[0], 'query');
          return { 'llamaindex.query': this.content(typeof query === 'string' ? query : pick(query, 'query')) };
        }),
      },
    ];
  }
}
