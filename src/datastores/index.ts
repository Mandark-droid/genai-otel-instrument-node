/**
 * The datastore instrumentors, started together when
 * `GENAI_ENABLE_MCP_INSTRUMENTATION` is on (the default) - the counterpart of
 * `MCPInstrumentorManager.instrument_all()` in the reference.
 *
 * Each looks for its client library and does nothing if it is not installed.
 */
import type { Instrumentor } from '../instrumentors/registry';
import { FalkorDBInstrumentor, RedisInstrumentor } from './redis';
import { MySQLInstrumentor, PostgresInstrumentor } from './sql';

export function datastoreInstrumentors(): Instrumentor[] {
  return [new PostgresInstrumentor(), new MySQLInstrumentor(), new RedisInstrumentor(), new FalkorDBInstrumentor()];
}

export { DatastoreInstrumentor, peerAttributes, type DatastoreCall, type DatastoreWrapperOptions } from './base';
export { getMcpMetrics, MCP_METER_NAME, resetMcpMetrics, type McpMetrics } from './mcp-metrics';
export { estimatePayloadSize } from './payload';
export { FalkorDBInstrumentor, RedisInstrumentor } from './redis';
export { MySQLInstrumentor, PostgresInstrumentor, sqlVerb, timescaleOperation } from './sql';
