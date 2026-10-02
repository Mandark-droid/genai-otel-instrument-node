# MCP example: tool calls traced on both sides

`tool-call.mjs`: an MCP client calls two tools on an MCP server, both from
`@modelcontextprotocol/sdk`, joined by the SDK's in-memory transport.

Spans: `mcp.call_tool orders.find_order`, `mcp.call_tool orders.cancel_order` (client) and
`mcp.server.call_tool <tool>` (server). The client spans say what each call was -
`mcp.server`, `mcp.stage`, `mcp.behaviour`, `mcp.idempotent`, whether the tool matched the
expected one, and `mcp.identifier.hallucinated` when an identifier in the request was
never returned by an earlier call of the session. Tool arguments and results are not
recorded; the user id is hashed.

MCP instrumentation is opt-in, as in the Python library: put `mcp_client` in
`GENAI_ENABLED_INSTRUMENTORS` (or `enabledInstrumentors`).

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run | **Yes, run here and in CI**: it needs no network. `tests/e2e/mcp-example.test.ts` runs it as a child process against the built package and checks the six spans it exports |
| Against a remote MCP server (HTTP / stdio transport) | **No.** The instrumentation is on the client and server classes, not on a transport, so it does not depend on which one is used - but only the in-memory one was exercised |

## Run it

```bash
npm ci && npm run build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/mcp/tool-call.mjs
```

Set `GENAI_MCP_HASH_SALT` to a stable secret if hashed user ids must match across
processes; without it a random per-process salt is used and a warning says so.
