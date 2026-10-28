/**
 * Agent graph attributes for Arize AX / Phoenix agent-trajectory views - a port of the Python
 * library's `AgentGraphSpanProcessor` (1.44.0), same keys and rules.
 *
 * Arize builds its agent graph from `graph.node.id` (required) and `graph.node.parent_id`
 * (optional; inferred from the span tree when absent), and labels nodes with
 * `graph.node.display_name`. Agents are reported as `gen_ai.agent.name`, so this processor adds
 * those keys, plus the OpenInference `agent.name` and span kind, to every span that names an agent.
 *
 * The parent link is the nearest enclosing agent, which can sit several spans up (an LLM or tool
 * span usually separates two agents), so each span inside an agent records the graph node it
 * belongs to. Everything happens at span start, so an agent span must carry its name in its start
 * attributes (the instrumentors and `traceAgent` do).
 *
 * Keys a span already carries are left alone. Turned off with
 * GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES=false, as in the Python library.
 */
import { type Attributes, type Context, trace } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { logger } from './logger';

export const AGENT_NAME = 'agent.name';
export const GRAPH_NODE_ID = 'graph.node.id';
export const GRAPH_NODE_NAME = 'graph.node.name';
// The Arize AX agent page names the label graph.node.display_name; the OpenInference spec calls it
// graph.node.name. Both are written.
export const GRAPH_NODE_DISPLAY_NAME = 'graph.node.display_name';
export const GRAPH_NODE_PARENT_ID = 'graph.node.parent_id';
const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind';

// Spans still open inside an agent. Entries leave on span end; the cap only guards against spans
// that are never ended.
const MAX_TRACKED_SPANS = 10000;

interface GraphNode {
  nodeId: string;
  parentId: string | undefined;
}

/** The span's graph node, or undefined when the span is not an agent. */
function nodeIdOf(attributes: Attributes): string | undefined {
  for (const key of [GRAPH_NODE_ID, AGENT_NAME, 'gen_ai.agent.name']) {
    const value = attributes[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return undefined;
}

/**
 * A GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES value, parsed as `OTelConfig.enableAgentGraphAttributes`
 * parses it (`.lower() == "true"`, default true). The setups read the config field.
 */
export function agentGraphEnabled(value: string | undefined): boolean {
  return (value ?? 'true').toLowerCase() === 'true';
}

export class AgentGraphSpanProcessor implements SpanProcessor {
  private readonly nodes = new Map<string, GraphNode>();

  onStart(span: Span, parentContext: Context): void {
    try {
      const spanId = span.spanContext().spanId;
      const parentSpanId = trace.getSpan(parentContext)?.spanContext().spanId;
      const enclosing = parentSpanId ? this.nodes.get(parentSpanId) : undefined;
      const attributes = span.attributes ?? {};
      const nodeId = nodeIdOf(attributes);
      const node = nodeId === undefined ? enclosing : this.annotate(span, attributes, nodeId, enclosing);
      if (node) {
        if (this.nodes.size >= MAX_TRACKED_SPANS) this.nodes.clear();
        this.nodes.set(spanId, node);
      }
    } catch (error) {
      // Graph attributes must never break a span.
      logger.debug(`Failed to add agent graph attributes: ${String(error)}`);
    }
  }

  private annotate(span: Span, attributes: Attributes, nodeId: string, enclosing: GraphNode | undefined): GraphNode {
    let parentId: string | undefined;
    if (GRAPH_NODE_PARENT_ID in attributes) parentId = String(attributes[GRAPH_NODE_PARENT_ID] ?? '') || undefined;
    else if (!enclosing) parentId = undefined;
    // The same agent one level down (a task and the agent running it): one node, not a self-loop.
    else if (enclosing.nodeId === nodeId) parentId = enclosing.parentId;
    else parentId = enclosing.nodeId;

    const agentName = attributes[AGENT_NAME] ?? attributes['gen_ai.agent.name'];
    if (agentName && !(AGENT_NAME in attributes)) span.setAttribute(AGENT_NAME, String(agentName));
    if (!(GRAPH_NODE_ID in attributes)) span.setAttribute(GRAPH_NODE_ID, nodeId);
    if (!(GRAPH_NODE_NAME in attributes)) span.setAttribute(GRAPH_NODE_NAME, nodeId);
    if (!(GRAPH_NODE_DISPLAY_NAME in attributes))
      span.setAttribute(GRAPH_NODE_DISPLAY_NAME, String(attributes[GRAPH_NODE_NAME] ?? nodeId));
    // An unset parent marks the root node, so only a real parent is written.
    if (parentId && !(GRAPH_NODE_PARENT_ID in attributes)) span.setAttribute(GRAPH_NODE_PARENT_ID, parentId);
    if (!(OPENINFERENCE_SPAN_KIND in attributes)) span.setAttribute(OPENINFERENCE_SPAN_KIND, 'AGENT');
    return { nodeId, parentId };
  }

  onEnd(span: ReadableSpan): void {
    try {
      this.nodes.delete(span.spanContext().spanId);
    } catch {
      // nothing to clean up
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.nodes.clear();
    return Promise.resolve();
  }
}
