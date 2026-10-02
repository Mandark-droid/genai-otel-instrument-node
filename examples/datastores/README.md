# Datastore example: a traced vector search

`qdrant.mjs`: one query against a Qdrant collection through `@qdrant/js-client-rest`.

Span: `qdrant.query_points` (client kind), with `db.system`, the collection, `db.vector.top_k`
and `rag.result.score_max` / `_min` / `_mean` / `_margin`. Metrics: `mcp.requests`,
`mcp.client.operation.duration`. The query vector and the stored payloads are not
recorded.

Datastore instrumentation needs no set-up: it is on by default
(`GENAI_ENABLE_MCP_INSTRUMENTATION`) and covers whichever of these are installed -
PostgreSQL, MySQL, Redis, FalkorDB, Kafka, RabbitMQ, OpenSearch, Elasticsearch, MinIO, S3,
Qdrant, Pinecone, Chroma, Milvus. See `docs/parity-matrix.md` for what each records.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock server | Yes: `tests/e2e/datastore-example.test.ts` runs it as a child process against the built package and a stand-in for Qdrant's HTTP API, and checks the span it exports |
| Run against a real Qdrant | **No.** No Qdrant server was available where this was written |

## Run it

```bash
npm ci && npm run build
QDRANT_URL=http://localhost:6333 EXAMPLE_COLLECTION=<a collection> EXAMPLE_VECTOR_SIZE=<its dimension> \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/datastores/qdrant.mjs
```

`EXAMPLE_SESSION_ID` sets the `session.id` on the span; it is printed either way.
