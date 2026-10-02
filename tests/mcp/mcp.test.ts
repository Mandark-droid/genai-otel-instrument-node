/**
 * MCP semantic conventions.
 *
 * The first half checks the port against vectors produced by running the
 * Python reference (`scripts/gen-mcp-vectors.py` -> tests/fixtures/mcp/python-vectors.json).
 * The second half runs a real `@modelcontextprotocol/sdk` client against a
 * real server over the SDK's in-memory transport.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import vectors from '../fixtures/mcp/python-vectors.json';
import { setAmbientEnv } from '../../src/env';
import {
  buildCallAttributes,
  buildErrorAttributes,
  buildResultAttributes,
  buildSpanName,
  computeCartHash,
  extractCart,
  extractResultPayload,
  hashIdentifier,
  mcpInstrumentor,
  MCPSessionState,
  MCPToolRegistry,
  resetSaltCache,
  withExpectedTool,
  withMcpSession,
  type MCPCallContext,
} from '../../src/mcp';
import { startHarness, type Harness } from '../helpers/harness';

/** Python `None` arrives as JSON null; here "absent" is undefined. */
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

const registry = (): MCPToolRegistry => {
  const built = MCPToolRegistry.fromDicts(vectors.schemas);
  built.markPlacement(vectors.mark_placement);
  return built;
};

describe('against the Python reference', () => {
  it('hashIdentifier', () => {
    for (const entry of vectors.hash_identifier) {
      expect(hashIdentifier(entry.value, entry.salt, entry.length), JSON.stringify(entry.value)).toBe(orUndefined(entry.expected));
    }
  });

  it('computeCartHash: the same items in another order hash the same; an empty cart has no hash', () => {
    for (const entry of vectors.cart_hash) {
      expect(computeCartHash(entry.cart), JSON.stringify(entry.cart)).toBe(orUndefined(entry.expected));
    }
    expect(vectors.cart_hash[0]?.expected).toBe(vectors.cart_hash[1]?.expected);
  });

  it('registry.resolve: prefixes stripped by known server, ambiguity kept, unknown tools resolve to themselves', () => {
    const built = registry();
    for (const entry of vectors.resolve) {
      const resolution = built.resolve(entry.raw, orUndefined(entry.hint));
      expect(
        {
          rawName: resolution.rawName,
          tool: resolution.tool,
          server: resolution.server ?? null,
          stage: resolution.stage ?? null,
          behaviour: resolution.behaviour ?? null,
          idempotent: resolution.idempotent ?? null,
          placement: resolution.placement,
          capabilities: [...resolution.capabilities].sort(),
          prefixStripped: resolution.prefixStripped,
          ambiguous: resolution.ambiguous,
          known: resolution.known,
        },
        `${entry.raw} (hint ${String(entry.hint)})`,
      ).toEqual(entry.expected);
    }
    expect(built.candidateCount).toBe(vectors.candidate_count);
    expect(built.servers).toEqual(vectors.servers);
  });

  it('capabilities: what the surface can do, declared or by name', () => {
    const built = registry();
    for (const [capability, tools] of Object.entries(vectors.capabilities)) {
      expect(built.toolsForCapability(capability).map((tool) => tool.name).sort(), capability).toEqual(tools);
    }
    expect(built.missingCapabilities()).toEqual(vectors.missing_capabilities);
  });

  it('identifier checks: an id seen in no prior response is flagged by key, never by value', () => {
    const state = new MCPSessionState('s1', { seedIdentifiers: ['ADDR-USER'] });
    for (const step of vectors.identifier_steps) {
      if (step.op === 'observe') {
        expect(state.observeResponse(step.payload), JSON.stringify(step.payload)).toBe(step.learned);
      } else {
        expect(state.checkRequestIdentifiers(step.arguments), JSON.stringify(step.arguments)).toEqual({
          hallucinated: step.hallucinated,
          keys: step.keys,
        });
      }
    }
  });

  it('call and result attributes over a session: stage, ground truth, hashed user, cart hash, duplicate placement', () => {
    setAmbientEnv({ GENAI_MCP_HASH_SALT: 'pepper' });
    try {
      const built = registry();
      const state = new MCPSessionState('sess-1', { seedIdentifiers: ['ADDR-USER'] });
      const callContext: MCPCallContext = {
        sessionId: 'sess-1',
        expectedTool: 'search_restaurants',
        requestedResolution: 'cancel_order',
        userId: '+919000000001',
        seedIdentifiers: ['ADDR-USER'],
      };
      for (const call of vectors.calls as unknown as { raw: string; arguments: unknown; hint: string | null; span_name: string; attributes: object; result?: unknown; result_attributes?: object }[]) {
        const { attributes, resolution } = buildCallAttributes(call.raw, call.arguments, {
          registry: built,
          sessionState: state,
          context: callContext,
          serverHint: orUndefined(call.hint),
        });
        expect(buildSpanName(resolution, call.raw), call.raw).toBe(call.span_name);
        expect(attributes, call.raw).toEqual(call.attributes);
        if (call.result !== undefined) {
          expect(buildResultAttributes(call.result, resolution, state), `${call.raw} result`).toEqual(call.result_attributes);
        }
      }
    } finally {
      setAmbientEnv({});
      resetSaltCache();
    }
  });

  it('error attributes, payload and cart extraction', () => {
    for (const entry of vectors.error_attributes) expect(buildErrorAttributes(entry.source), JSON.stringify(entry.source)).toEqual(entry.expected);
    for (const entry of vectors.extract_result_payload) {
      expect(extractResultPayload(entry.result) ?? null, JSON.stringify(entry.result)).toEqual(entry.expected);
    }
    for (const entry of vectors.extract_cart) expect(extractCart(entry.payload) ?? null, JSON.stringify(entry.payload)).toEqual(entry.expected);
  });

  it('with no salt configured, hashes are consistent within the process and say so once', () => {
    resetSaltCache();
    const first = hashIdentifier('user-1');
    expect(first).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(hashIdentifier('user-1')).toBe(first);
    expect(hashIdentifier('user-2')).not.toBe(first);
    resetSaltCache();
  });
});

describe('a real MCP client and server', () => {
  let harness: Harness;
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    harness = await startHarness({ enabledInstrumentors: ['mcp_client'] });
    mcpInstrumentor().setRegistry(registry());
    server = new McpServer({ name: 'food', version: '1.0.0' });
    server.registerTool(
      'search_restaurants',
      { description: 'Find restaurants', inputSchema: { query: z.string() } },
      async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify({ restaurants: [{ id: 'R-1', name: `best ${query}` }] }) }] }),
    );
    server.registerTool('place_food_order', { description: 'Order', inputSchema: { restaurantId: z.string() } }, async ({ restaurantId }) =>
      restaurantId === 'R-1'
        ? { content: [{ type: 'text', text: JSON.stringify({ orderId: 'O-9' }) }] }
        : { isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'Unknown restaurant' }) }] },
    );
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    harness.reset();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    mcpInstrumentor().setRegistry(undefined);
    mcpInstrumentor().sessionRegistry.clear();
    try {
      expect(harness.openSpans()).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it('a tool call is a client span and a server span; arguments and results are not recorded', async () => {
    const result = await withMcpSession('sess-42', () => withExpectedTool('search_restaurants', () => client.callTool({ name: 'search_restaurants', arguments: { query: 'pizza' } })), {
      userId: 'user@example.com',
      requestedResolution: 'cancel_order',
    });
    expect(JSON.stringify(result.content)).toContain('R-1');

    const span = harness.span('mcp.call_tool food.search_restaurants');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'mcp.tool': 'search_restaurants',
      'mcp.tool.raw_name': 'search_restaurants',
      'mcp.server': 'food',
      'mcp.stage': 'Discover',
      'mcp.behaviour': 'read-only',
      'mcp.idempotent': true,
      'mcp.session_id': 'sess-42',
      'session.id': 'sess-42',
      'gen_ai.conversation.id': 'sess-42',
      'mcp.tool_selection.expected': 'search_restaurants',
      'mcp.tool_selection.correct': true,
      'mcp.tool_selection.requested_capability': 'cancel_order',
      'mcp.tool_selection.candidate_count': 9,
    });
    expect(String(span.attributes['mcp.user.id_hash'])).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(span.attributes)).not.toContain('pizza');
    expect(JSON.stringify(span.attributes)).not.toContain('user@example.com');

    const serverSpan = harness.span('mcp.server.call_tool search_restaurants');
    expect(serverSpan.kind).toBe(SpanKind.SERVER);
    expect(serverSpan.attributes['mcp.tool']).toBe('search_restaurants');
    // Every span of the session carries the session id.
    expect(serverSpan.attributes['session.id']).toBe('sess-42');
  });

  it('an identifier the session never saw is flagged; one it did see is not; a second placement is counted', async () => {
    await withMcpSession('sess-7', async () => {
      await client.callTool({ name: 'place_food_order', arguments: { restaurantId: 'R-1' } });
      await client.callTool({ name: 'search_restaurants', arguments: { query: 'pizza' } });
      await client.callTool({ name: 'place_food_order', arguments: { restaurantId: 'R-1' } });
    });
    const placements = harness.spans().filter((span) => span.name === 'mcp.call_tool food.place_food_order');
    expect(placements).toHaveLength(2);
    expect(placements[0]?.attributes).toMatchObject({
      'mcp.identifier.hallucinated': true,
      'mcp.identifier.hallucinated_keys': ['restaurantId'],
      'commerce.order.placement_attempt': 1,
      'commerce.order.placed': true,
      'mcp.behaviour': 'mutating',
    });
    expect(placements[1]?.attributes).toMatchObject({ 'mcp.identifier.hallucinated': false, 'commerce.order.placement_attempt': 2 });
    expect(JSON.stringify(placements[0]?.attributes)).not.toContain('R-1');
  });

  it('a tool that reports an error ends both spans with ERROR status and the upstream message verbatim', async () => {
    const result = await client.callTool({ name: 'place_food_order', arguments: { restaurantId: 'R-404' } });
    expect(result.isError).toBe(true);
    const span = harness.span('mcp.call_tool food.place_food_order');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['mcp.error.message_raw']).toBe('Unknown restaurant');
    expect('commerce.order.placed' in span.attributes).toBe(false);
    expect(harness.span('mcp.server.call_tool place_food_order').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('without a session or a registry a call still gets a span with the tool name', async () => {
    mcpInstrumentor().setRegistry(undefined);
    await client.callTool({ name: 'search_restaurants', arguments: { query: 'x' } });
    const span = harness.span('mcp.call_tool search_restaurants');
    expect(span.attributes).toMatchObject({ 'mcp.tool': 'search_restaurants', 'mcp.tool.raw_name': 'search_restaurants' });
    expect('mcp.session_id' in span.attributes).toBe(false);
    expect('mcp.identifier.hallucinated' in span.attributes).toBe(false);
  });
});
