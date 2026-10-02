# Phase 3 plan: datastores, MCP and frameworks

Scope: spec section 6, rows "Frameworks" and "MCP / datastores" for Node. Reference: the
Python library at v1.30.0 - `genai_otel/mcp_instrumentors/`, `genai_otel/mcp_semconv/`,
and the framework instrumentors under `genai_otel/instrumentors/`.

## How the reference does it, and what changes here

The Python library has two kinds of datastore instrumentor:

- **delegating** - PostgreSQL, MySQL, MongoDB, SQLAlchemy, Redis, Kafka, Elasticsearch,
  OpenSearch and HTTP hand the spans to the OpenTelemetry contrib instrumentation for
  that library, and add the four `mcp.*` metrics (requests, operation duration, request
  size, response size) around the driver call;
- **own** - vector databases, MinIO, RabbitMQ, FalkorDB and TimescaleDB create their own
  spans.

On Node the contrib instrumentations hook module loading (`require-in-the-middle`, and
an ES-module loader for `import`), which works only for modules loaded after the hook is
installed and needs a second loader flag for ES-module applications. Everything else in
this SDK patches class prototypes after the fact and works for both module systems and
for clients created earlier. So here **every datastore gets a span from this SDK**,
written to the same OpenTelemetry database conventions the contrib packages use
(`db.system`, `db.operation`, `db.name`, `net.peer.name`, `net.peer.port`), plus the
`mcp.*` metrics exactly as the reference records them. No contrib package is a
dependency. This is listed in the parity matrix as a deliberate difference.

One more deliberate difference: **statement text**. The contrib instrumentations record
`db.statement` always. A statement can carry literal values, and this SDK is for
deployments that must not let personal data into telemetry by accident, so
`db.statement` is recorded only when content capture is on, bounded by
`GENAI_CONTENT_MAX_LENGTH`. Bound parameter values are never recorded. The operation
(`SELECT`, `GET`, `search`) is always recorded.

## Library check (npm, 2026-10-02)

| Store | Python target | JS library | Version | Decision |
|---|---|---|---|---|
| PostgreSQL | psycopg2 | `pg` | 8.23 | Port. Tested against a wire-protocol stand-in |
| TimescaleDB | psycopg2 + hypertable detection | `pg` | | Port on top of the PostgreSQL instrumentor |
| MySQL | mysql-connector | `mysql2` | 3.24 | Port |
| MongoDB | pymongo | `mongodb` | | Not in the Node target list (spec section 6): recorded as not ported |
| SQLAlchemy | sqlalchemy | - | | Not applicable: an ORM of Python's. Drivers are covered directly |
| Redis | redis-py | `redis` 6.3, `ioredis` 6.0 | | Port both. Tested against a RESP stand-in |
| Kafka | kafka-python | `kafkajs` | 2.2.4 (2023) | Port. The library is unmaintained but is what Node applications use; `@confluentinc/kafka-javascript` is recorded as not ported |
| RabbitMQ | pika | `amqplib` | 2.2 | Port |
| OpenSearch | opensearch-py | `@opensearch-project/opensearch` | 3.9 | Port (HTTP mock) |
| Elasticsearch | elasticsearch-py | `@elastic/elasticsearch` | 9.5 | Port (HTTP mock) |
| MinIO / S3 | minio | `minio` 8.0, `@aws-sdk/client-s3` | | Port both |
| Qdrant | qdrant-client | `@qdrant/js-client-rest` | 1.19 | Port (HTTP mock) |
| Pinecone | pinecone | `@pinecone-database/pinecone` | 9.0 | Port |
| Weaviate | weaviate-client | `weaviate-client` | 3.14 | Port |
| Chroma | chromadb | `chromadb` | 3.5 | Port |
| Milvus | pymilvus | `@zilliz/milvus2-sdk-node` | 3.0 | Port |
| FAISS, LanceDB | faiss, lancedb | - | | Not in the Node target list: recorded |
| FalkorDB | falkordb | `falkordb` | 6.8 | Port |
| HTTP | httpx | global `fetch` | | Port, opt-in (`GENAI_ENABLE_HTTP_INSTRUMENTATION`), as in the reference |
| MCP | `mcp` SDK | `@modelcontextprotocol/sdk` | 1.31 | Port: client and server |

| Framework | Python target | JS library | Version | Decision |
|---|---|---|---|---|
| LangChain | langchain | `@langchain/core` | 1.2 | Port: chat models, chains / runnables, agents |
| LangGraph | langgraph | `@langchain/langgraph` | 1.4 | Port: `invoke`, `stream` |
| LlamaIndex | llama_index | `llamaindex` | 0.12 | Port: query engine |
| OpenAI Agents | openai-agents | `@openai/agents` | 0.18 | Port: `run` |
| Google ADK | google-adk | `@google/adk` | 2.2 | Port: `Runner.runAsync` |
| Bedrock Agents | boto3 bedrock-agent-runtime | `@aws-sdk/client-bedrock-agent-runtime` | | Port: InvokeAgent, Retrieve, RetrieveAndGenerate |
| Vercel AI SDK | - (JS only) | `ai` | 7.0 | Its functions are ES-module exports and cannot be patched. It emits its own OpenTelemetry spans when telemetry is enabled on a call; those are priced and normalised by a span processor |
| Mastra | - (JS only) | `@mastra/core` | 1.74 | Same approach as the AI SDK: it emits OpenTelemetry spans itself. Verified or recorded as not exercised |
| CrewAI, DSPy, smolagents, AutoGen, Pydantic AI, Haystack, Instructor, Guardrails AI, Strands | Python only | - | | Not applicable, with the reason, in the parity matrix |

## Units, in order

| # | Unit |
|---|---|
| 3.1 | `mcp.*` metrics, the datastore base class, payload-size estimate (as the reference samples it) |
| 3.2 | PostgreSQL, TimescaleDB, MySQL |
| 3.3 | Redis: `redis`, `ioredis`; FalkorDB |
| 3.4 | Kafka, RabbitMQ |
| 3.5 | OpenSearch, Elasticsearch |
| 3.6 | MinIO, S3 |
| 3.7 | Vector databases: Qdrant, Pinecone, Weaviate, Chroma, Milvus - with the retrieval score attributes (`rag.result.score_*`) |
| 3.8 | HTTP (`fetch`), opt-in |
| 3.9 | MCP SDK: client and server spans, the session tracker, tool registry and privacy rules of `mcp_semconv` |
| 3.10 | Frameworks: LangChain, LangGraph, LlamaIndex, OpenAI Agents, Google ADK, Bedrock Agents |
| 3.11 | Vercel AI SDK and Mastra through their own spans |
| 3.12 | Examples and documentation |

## Testing

Real client library in every case. What stands in for the server:

- HTTP-based clients (OpenSearch, Elasticsearch, Qdrant, Pinecone, Chroma, MinIO, S3):
  the mock HTTP server.
- PostgreSQL and Redis-protocol clients (`pg`, `redis`, `ioredis`, `falkordb`): a small
  wire-protocol stand-in, so the real driver runs end to end.
- MySQL, Kafka, RabbitMQ, Milvus, Weaviate (binary or gRPC protocols): the driver's
  network layer is replaced in the test, and the README says so.

No datastore server is started here. The first run against real servers is the lead's,
on a test host.

## Not in this phase

GPU, energy, CO2, server metrics, evaluation, media: phase 4.
