/**
 * The datastore instrumentors, started together when
 * `GENAI_ENABLE_MCP_INSTRUMENTATION` is on (the default) - the counterpart of
 * `MCPInstrumentorManager.instrument_all()` in the reference.
 *
 * Each looks for its client library and does nothing if it is not installed.
 */
import type { OTelConfig } from '../config';
import type { Instrumentor } from '../instrumentors/registry';
import { HttpInstrumentor } from './http';
import { KafkaInstrumentor, RabbitMQInstrumentor } from './messaging';
import { FalkorDBInstrumentor, RedisInstrumentor } from './redis';
import { ElasticsearchInstrumentor, MinIOInstrumentor, OpenSearchInstrumentor, S3Instrumentor } from './search';
import { MySQLInstrumentor, PostgresInstrumentor } from './sql';
import { ChromaInstrumentor, MilvusInstrumentor, PineconeInstrumentor, QdrantInstrumentor } from './vector';

export function datastoreInstrumentors(config: OTelConfig): Instrumentor[] {
  const instrumentors: Instrumentor[] = [
    new PostgresInstrumentor(),
    new MySQLInstrumentor(),
    new ElasticsearchInstrumentor(),
    new OpenSearchInstrumentor(),
    new RedisInstrumentor(),
    new FalkorDBInstrumentor(),
    new KafkaInstrumentor(),
    new MinIOInstrumentor(),
    new S3Instrumentor(),
    new RabbitMQInstrumentor(),
    new QdrantInstrumentor(),
    new PineconeInstrumentor(),
    new ChromaInstrumentor(),
    new MilvusInstrumentor(),
  ];
  // Off unless asked for, as in the reference: every provider client already has a span of its own.
  if (config.enableHttpInstrumentation) instrumentors.push(new HttpInstrumentor());
  return instrumentors;
}

export { DatastoreInstrumentor, peerAttributes, type DatastoreCall, type DatastoreWrapperOptions } from './base';
export { HttpInstrumentor } from './http';
export { KafkaInstrumentor, RabbitMQInstrumentor } from './messaging';
export { getMcpMetrics, MCP_METER_NAME, resetMcpMetrics, type McpMetrics } from './mcp-metrics';
export { estimatePayloadSize } from './payload';
export { FalkorDBInstrumentor, RedisInstrumentor } from './redis';
export { ElasticsearchInstrumentor, MinIOInstrumentor, OpenSearchInstrumentor, S3Instrumentor, searchOperation } from './search';
export { MySQLInstrumentor, PostgresInstrumentor, sqlVerb, timescaleOperation } from './sql';
export { ChromaInstrumentor, extractScores, MilvusInstrumentor, PineconeInstrumentor, QdrantInstrumentor, setScoreAttributes } from './vector';
