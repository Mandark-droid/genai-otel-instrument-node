// @ts-check
/**
 * A vector search against Qdrant, traced: one client span per query with the
 * collection, top-k and a summary of the scores that came back - and no
 * vector, no document.
 *
 *   npm run build
 *   QDRANT_URL=http://localhost:6333 EXAMPLE_COLLECTION=example-embeddings \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/datastores/qdrant.mjs
 *
 * Datastore instrumentation is on by default; nothing is configured for it.
 */
import { randomBytes } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { flushTelemetry, instrument, instrumentorsReady, uninstrument, withSession } from '@traceverse/genai-otel-instrument';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-qdrant' });
await instrumentorsReady();

const client = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333', checkCompatibility: false });
const collection = process.env.EXAMPLE_COLLECTION ?? 'example-embeddings';
const dimensions = Number(process.env.EXAMPLE_VECTOR_SIZE ?? 384);
// A stand-in query vector; a real application embeds the user's question.
const vector = Array.from({ length: dimensions }, (_, index) => Math.sin(index));

const sessionId = process.env.EXAMPLE_SESSION_ID ?? `qdrant-${randomBytes(6).toString('hex')}`;
const result = await withSession(sessionId, () => client.query(collection, { query: vector, limit: 5 }));
console.log('session.id:', sessionId, '| points:', result.points.length, '| top score:', result.points[0]?.score ?? 'none');

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
