/**
 * The deterministic terminal-state classifier for MCP sessions, against
 * vectors made by running the reference's `mcp_semconv.terminal_state`
 * (tests/fixtures/mcp/terminal-state-vectors.json): state, rule, resolution,
 * confidence, every signal, every piece of evidence and the audit text.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { classifySession, NoToolResolution, TerminalState, TerminalStateClassifier } from '../../src/mcp';
import { MCPToolRegistry } from '../../src/mcp/tool-registry';

interface Vector {
  name: string;
  spans: { name: string; status: unknown; attributes: Record<string, unknown> }[];
  options: { registry?: boolean; requested?: string; capabilities?: string[] };
  result: {
    state: string;
    rule: string;
    resolution: string | null;
    confident: boolean;
    order_placed: boolean;
    signals: Record<string, unknown>;
    evidence: { rule: string; detail: string; span_index: number | null; span_name: string | null; attributes: Record<string, unknown> }[];
    explain: string;
  };
}

const file = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/mcp/terminal-state-vectors.json'), 'utf8')) as { registry: unknown[]; vectors: Vector[] };

describe('terminal-state classifier: reference vectors', () => {
  for (const vector of file.vectors) {
    it(vector.name, () => {
      const registry = vector.options.registry ? MCPToolRegistry.fromDicts(file.registry) : undefined;
      const result = classifySession(vector.spans, { registry, requestedResolution: vector.options.requested, availableCapabilities: vector.options.capabilities });
      expect({
        state: result.state,
        rule: result.rule,
        resolution: result.resolution ?? null,
        confident: result.confident,
        order_placed: result.orderPlaced,
        signals: result.signals,
        evidence: result.evidence.map((item) => ({ rule: item.rule, detail: item.detail, span_index: item.spanIndex ?? null, span_name: item.spanName ?? null, attributes: item.attributes })),
        explain: result.explain(),
      }).toEqual(vector.result);
    });
  }
});

describe('terminal-state classifier: this SDK', () => {
  it('reads OpenTelemetry spans as they are: an ERROR status code is a failed call', () => {
    const spans = [{ name: 'mcp.call_tool shop.track_order', status: { code: SpanStatusCode.ERROR }, attributes: { 'mcp.tool': 'track_order' } }];
    expect(classifySession(spans).rule).toBe('recoverable.unretried_failure');
    expect(classifySession([{ name: 'x', status: { code: SpanStatusCode.OK }, attributes: { 'mcp.tool': 'track_order' } }]).confident).toBe(false);
  });

  it('missing capabilities: from an explicit list, from a registry, or none known', () => {
    expect(new TerminalStateClassifier({ availableCapabilities: ['refund'] }).missingCapabilities()).not.toContain('refund');
    expect(new TerminalStateClassifier({ registry: MCPToolRegistry.fromDicts(file.registry) }).missingCapabilities()).not.toContain('cancel_order');
    expect(new TerminalStateClassifier().missingCapabilities()).toEqual([]);
    expect(new TerminalStateClassifier().hasCapability('refund')).toBe(false);
  });

  it('the enumerations carry the reference values', () => {
    expect(TerminalState.BLOCKED_NO_TOOL).toBe('BLOCKED_NO_TOOL');
    expect(NoToolResolution.ORDER_HISTORY_LOOKUP).toBe('order_history_lookup');
    expect(Object.keys(TerminalState)).toHaveLength(7);
  });
});
