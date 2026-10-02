// @ts-check
/**
 * MCP tool calls, traced on both sides: a client and a server from
 * `@modelcontextprotocol/sdk`, joined by the SDK's in-memory transport, so the
 * example needs no network and no second process.
 *
 *   npm run build
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/mcp/tool-call.mjs
 *
 * MCP instrumentation is opt-in, as in the Python library: name `mcp_client`
 * in the instrumentor list.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  flushTelemetry,
  instrument,
  instrumentorsReady,
  mcpInstrumentor,
  MCPToolRegistry,
  uninstrument,
  withExpectedTool,
  withMcpSession,
} from '@traceverse/genai-otel-instrument';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-mcp', enabledInstrumentors: ['mcp_client'] });
await instrumentorsReady();

// What each tool is: journey stage and whether it changes anything. From a
// schema map, never hardcoded in the instrumentation.
mcpInstrumentor().setRegistry(
  MCPToolRegistry.fromDicts([
    {
      server: 'orders',
      tools: [
        { name: 'find_order', stage: 'Track', behaviour: 'read-only' },
        { name: 'cancel_order', stage: 'Manage', behaviour: 'mutating' },
      ],
    },
  ]),
);

const server = new McpServer({ name: 'orders', version: '1.0.0' });
server.registerTool('find_order', { description: 'Look an order up', inputSchema: { customer: z.string() } }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ orderId: 'O-1001', state: 'packed' }) }],
}));
server.registerTool('cancel_order', { description: 'Cancel an order', inputSchema: { orderId: z.string() } }, async ({ orderId }) => ({
  content: [{ type: 'text', text: JSON.stringify({ orderId, state: 'cancelled' }) }],
}));

const client = new Client({ name: 'example-agent', version: '1.0.0' });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const sessionId = process.env.EXAMPLE_SESSION_ID ?? `mcp-${Date.now()}`;
await withMcpSession(
  sessionId,
  async () => {
    await withExpectedTool('find_order', () => client.callTool({ name: 'find_order', arguments: { customer: 'c-17' } }));
    // The order id came back from the first call, so it is not a hallucinated identifier.
    await client.callTool({ name: 'cancel_order', arguments: { orderId: 'O-1001' } });
    // This one was never seen in any response: flagged, by key only.
    await client.callTool({ name: 'cancel_order', arguments: { orderId: 'O-9999' } });
  },
  { userId: 'customer@example.com', requestedResolution: 'cancel_order' },
);
console.log('session.id:', sessionId);

await client.close();
await server.close();
const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
