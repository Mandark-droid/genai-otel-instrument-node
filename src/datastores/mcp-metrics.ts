/**
 * The four `mcp.*` instruments every datastore and tool instrumentor shares:
 * requests, operation duration, request size, response size.
 *
 * A port of `genai_otel/mcp_instrumentors/base.py` (`BaseMCPInstrumentor`):
 * same names, units and instrumentation scope, created once.
 */
import { metrics, type Counter, type Histogram } from '@opentelemetry/api';
import { createCounter, createHistogram } from '../metrics';
import { clearStateSlot, stateSlot } from '../state';

/** The Python module that creates them; a backend may key on the scope. */
export const MCP_METER_NAME = 'genai_otel.mcp_instrumentors.base';

const SLOT = 'mcpMetrics';

export interface McpMetrics {
  requests: Counter;
  duration: Histogram;
  requestSize: Histogram;
  responseSize: Histogram;
}

export function getMcpMetrics(): McpMetrics {
  return stateSlot(SLOT, () => {
    const meter = metrics.getMeter(MCP_METER_NAME);
    return {
      requests: createCounter(meter, 'mcp.requests'),
      duration: createHistogram(meter, 'mcp.client.operation.duration'),
      requestSize: createHistogram(meter, 'mcp.request.size'),
      responseSize: createHistogram(meter, 'mcp.response.size'),
    };
  });
}

/** Instruments stay bound to the meter provider that created them. */
export function resetMcpMetrics(): void {
  clearStateSlot(SLOT);
}
