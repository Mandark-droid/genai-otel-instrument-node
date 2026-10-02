/**
 * MCP instrumentation: one span per tool call, on the client and on the
 * server.
 *
 * The client half is a port of
 * `genai_otel/mcp_semconv/client_instrumentor.py`. It wraps
 * `Client.prototype.callTool` of `@modelcontextprotocol/sdk` - the one place
 * every MCP tool call passes through, whichever framework drives the agent -
 * and records what the call *was*: which server answered, what kind of
 * operation it is, whether the tool chosen matches ground truth, whether the
 * identifiers passed were real.
 *
 * The server half (not in the reference) wraps the point where an `McpServer`
 * runs a tool handler, so the server's side of the same call is a span too.
 *
 * Request and response bodies are never written to a span. The session id is
 * recorded (it is the support-correlation key); user identifiers are hashed;
 * for a hallucinated identifier only the argument key is recorded.
 */
import { context, createContextKey, SpanKind, SpanStatusCode, trace, type Attributes, type AttributeValue } from '@opentelemetry/api';
import { PatchingInstrumentor, type PatchTarget } from '../instrumentors/patching';
import { exportedClass } from '../instrumentors/wrap';
import type { UsageDict } from '../instrumentors/base';
import { logger } from '../logger';
import { pyStr } from '../pycompat';
import { withSession } from '../session';
import { stateSlot } from '../state';
import { CommerceAttributes, MCPAttributes } from './attributes';
import { hashIdentifier } from './privacy';
import { computeCartHash, MCPSessionRegistry, type MCPSessionState } from './session-tracker';
import { unresolved, type MCPToolRegistry, type ToolResolution } from './tool-registry';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the application or the harness knows about the current agent session; none of it is in the protocol. */
export interface MCPCallContext {
  sessionId?: string;
  /** Ground-truth tool for the current step, when known. */
  expectedTool?: string;
  /** The capability the user asked for. */
  requestedResolution?: string;
  /** Overrides the registry's tool count when the surface offered to the model differs. */
  candidateCount?: number;
  /** Raw end-user identifier. Hashed before it reaches a span. */
  userId?: string;
  /** Identifiers the user supplied up front: exempt from the hallucination check. */
  seedIdentifiers?: readonly string[];
}

const CONTEXT_KEY = createContextKey('traceverse.genai-otel-instrument.mcp-call-context');

export function getCallContext(): MCPCallContext | undefined {
  return context.active().getValue(CONTEXT_KEY) as MCPCallContext | undefined;
}

/**
 * Run `fn` as one MCP session. Every tool call inside carries the session id,
 * and so does every other span (it is also a `withSession` scope), so the
 * model calls and the tool calls of one run can be joined.
 */
export function withMcpSession<T>(sessionId: string, fn: () => T, options: Omit<MCPCallContext, 'sessionId' | 'expectedTool'> = {}): T {
  const scope: MCPCallContext = { ...options, sessionId };
  return context.with(context.active().setValue(CONTEXT_KEY, scope), () => withSession(sessionId, fn));
}

/** Declare the ground-truth tool for the call(s) made inside `fn`. */
export function withExpectedTool<T>(name: string | undefined, fn: () => T): T {
  const scope: MCPCallContext = { ...getCallContext(), expectedTool: name };
  return context.with(context.active().setValue(CONTEXT_KEY, scope), fn);
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function maybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The payload of a `CallToolResult`: its structured content, else its text blocks parsed as JSON where they are JSON. */
export function extractResultPayload(result: unknown): unknown {
  if (result === null || result === undefined) return undefined;
  if (Array.isArray(result)) return result;
  if (!isMapping(result)) return undefined;
  // A replayed trace or a plain payload, not a protocol result.
  if (!('content' in result) && !('structuredContent' in result) && !('isError' in result)) return result;
  const structured = result.structuredContent ?? result.structured_content;
  if (structured !== undefined && structured !== null) return structured;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parsed: unknown[] = [];
  for (const block of content as unknown[]) {
    if (isMapping(block) && typeof block.text === 'string') parsed.push(maybeJson(block.text));
  }
  if (parsed.length === 0) return undefined;
  return parsed.length === 1 ? parsed[0] : parsed;
}

const CART_ITEM_KEYS = ['items', 'cartItems', 'cart_items', 'lineItems', 'line_items'];

/** A cart object inside a tool payload, if there is one. */
export function extractCart(payload: unknown): unknown {
  if (!isMapping(payload)) return undefined;
  for (const key of ['cart', 'cartDetails', 'cart_details', 'data']) {
    const value = payload[key];
    if (isMapping(value) && CART_ITEM_KEYS.some((itemKey) => itemKey in value)) return value;
  }
  if (['items', 'cartItems', 'cart_items'].some((key) => key in payload)) return payload;
  return undefined;
}

function isErrorResult(result: unknown): boolean {
  return isMapping(result) && Boolean(result.isError ?? result.is_error);
}

function errorText(payload: unknown): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  if (typeof payload === 'string') return payload;
  if (isMapping(payload)) {
    for (const key of ['message', 'error', 'detail', 'reason']) {
      const value = payload[key];
      if (typeof value === 'string' && value) return value;
      if (isMapping(value) && typeof value.message === 'string' && value.message) return value.message;
    }
  }
  if (Array.isArray(payload) && payload.length > 0) return errorText(payload[0]);
  // As the reference does: the text Python's str() gives.
  return pyStr(payload);
}

/**
 * `mcp.error.*` from a thrown error or an error payload. The message is
 * verbatim: error clustering depends on the exact upstream wording.
 */
export function buildErrorAttributes(source: unknown): Attributes {
  const attributes: Attributes = {};
  if (source === null || source === undefined) return attributes;
  const record = (typeof source === 'object' ? source : {}) as Obj;

  // JSON-RPC error data.
  let code: unknown = isMapping(record.error) ? record.error.code : undefined;
  code ??= record.code;
  if (typeof code === 'number' && Number.isInteger(code)) attributes[MCPAttributes.ERROR_JSONRPC_CODE] = code;

  let status: unknown = isMapping(record.response) ? (record.response.status_code ?? record.response.status) : undefined;
  status ??= record.status_code ?? record.httpStatus;
  if (typeof status === 'number' && Number.isInteger(status)) attributes[MCPAttributes.ERROR_HTTP_STATUS] = status;

  const message = source instanceof Error ? source.message : errorText(source);
  if (message) attributes[MCPAttributes.ERROR_MESSAGE_RAW] = message;
  return attributes;
}

// ---------------------------------------------------------------------------
// Attribute builders
// ---------------------------------------------------------------------------

/**
 * `mcp.call_tool {server}.{tool}`, or `mcp.call_tool {tool}` when the server
 * is not known. The server is part of the name on purpose: the same tool name
 * exists on more than one server of a composite surface.
 */
export function buildSpanName(resolution: ToolResolution, fallback?: unknown): string {
  const tool = resolution.tool || (fallback ? String(fallback) : '');
  return resolution.server ? `mcp.call_tool ${resolution.server}.${tool}` : `mcp.call_tool ${tool}`;
}

export interface CallAttributeInputs {
  registry?: MCPToolRegistry;
  sessionState?: MCPSessionState;
  context?: MCPCallContext;
  serverHint?: string;
}

/** The pre-call attributes of one `callTool`. `toolArguments` is used only for identifier checks; never recorded. */
export function buildCallAttributes(
  rawName: string,
  toolArguments: unknown,
  inputs: CallAttributeInputs = {},
): { attributes: Attributes; resolution: ToolResolution } {
  const { registry, sessionState, context: callContext, serverHint } = inputs;
  const resolution = registry ? registry.resolve(rawName, serverHint) : unresolved(rawName, rawName, serverHint);
  const attributes: Attributes = { [MCPAttributes.TOOL]: resolution.tool, [MCPAttributes.TOOL_RAW_NAME]: resolution.rawName };
  if (resolution.prefixStripped) attributes[MCPAttributes.TOOL_PREFIX_STRIPPED] = true;
  if (resolution.server) attributes[MCPAttributes.SERVER] = resolution.server;
  if (resolution.stage) attributes[MCPAttributes.STAGE] = resolution.stage;
  if (resolution.behaviour) attributes[MCPAttributes.BEHAVIOUR] = resolution.behaviour;
  if (resolution.idempotent !== undefined) attributes[MCPAttributes.IDEMPOTENT] = resolution.idempotent;

  const candidateCount = callContext?.candidateCount ?? registry?.candidateCount;
  if (candidateCount) attributes[MCPAttributes.TOOL_SELECTION_CANDIDATE_COUNT] = candidateCount;

  if (callContext) {
    if (callContext.sessionId) {
      attributes[MCPAttributes.SESSION_ID] = callContext.sessionId;
      // The conventional keys too, or the tool calls of a run cannot be joined with its model calls.
      attributes['session.id'] = callContext.sessionId;
      attributes['gen_ai.conversation.id'] = callContext.sessionId;
    }
    if (callContext.expectedTool) {
      // Against the unprefixed name: comparing the raw name silently scores every run 0%.
      attributes[MCPAttributes.TOOL_SELECTION_EXPECTED] = callContext.expectedTool;
      attributes[MCPAttributes.TOOL_SELECTION_CORRECT] = resolution.tool === callContext.expectedTool;
    }
    if (callContext.requestedResolution) attributes[MCPAttributes.TOOL_SELECTION_REQUESTED_CAPABILITY] = callContext.requestedResolution;
    if (callContext.userId) {
      const hashed = hashIdentifier(callContext.userId);
      if (hashed) attributes[MCPAttributes.USER_ID_HASH] = hashed;
    }
  }

  const hasArguments = isMapping(toolArguments) ? Object.keys(toolArguments).length > 0 : Array.isArray(toolArguments) && toolArguments.length > 0;
  if (sessionState && hasArguments) {
    const check = sessionState.checkRequestIdentifiers(toolArguments);
    attributes[MCPAttributes.IDENTIFIER_HALLUCINATED] = check.hallucinated;
    if (check.keys.length > 0) attributes[MCPAttributes.IDENTIFIER_HALLUCINATED_KEYS] = check.keys;
  }

  // Cart drift and duplicate placement.
  if (sessionState) {
    let cartHash = sessionState.cartHash;
    if (hasArguments) {
      const argumentCart = extractCart(toolArguments);
      if (argumentCart !== undefined) cartHash = computeCartHash(argumentCart) ?? cartHash;
    }
    if (cartHash) attributes[CommerceAttributes.CART_HASH] = cartHash;
    if (resolution.placement) attributes[CommerceAttributes.ORDER_PLACEMENT_ATTEMPT] = sessionState.notePlacement(cartHash);
  }
  return { attributes, resolution };
}

/** The post-call attributes; also teaches the session what it has now legitimately seen. */
export function buildResultAttributes(result: unknown, resolution: ToolResolution, sessionState?: MCPSessionState): Attributes {
  const attributes: Attributes = {};
  const payload = extractResultPayload(result);
  if (isErrorResult(result)) return buildErrorAttributes(payload);
  if (sessionState && payload !== undefined && payload !== null) {
    sessionState.observeResponse(payload);
    const cart = extractCart(payload);
    if (cart !== undefined) {
      const cartHash = sessionState.noteCart(cart);
      if (cartHash) attributes[CommerceAttributes.CART_HASH] = cartHash;
    }
  }
  if (resolution.placement) attributes[CommerceAttributes.ORDER_PLACED] = true;
  return attributes;
}

// ---------------------------------------------------------------------------
// Instrumentor
// ---------------------------------------------------------------------------

const CLIENT_PACKAGE = '@modelcontextprotocol/sdk/client/index.js';
const SERVER_PACKAGE = '@modelcontextprotocol/sdk/server/mcp.js';

export class MCPInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'MCP';
  protected readonly packages = [CLIENT_PACKAGE, SERVER_PACKAGE];
  protected override get owner(): string {
    return 'mcp';
  }

  registry: MCPToolRegistry | undefined;
  readonly sessionRegistry: MCPSessionRegistry;

  constructor(options: { registry?: MCPToolRegistry; sessionRegistry?: MCPSessionRegistry } = {}) {
    super();
    this.registry = options.registry;
    this.sessionRegistry = options.sessionRegistry ?? new MCPSessionRegistry();
  }

  /** Attach or replace the tool metadata registry. */
  setRegistry(registry: MCPToolRegistry | undefined): void {
    this.registry = registry;
  }

  /** MCP tool calls carry no tokens: those belong to the span of the model that chose the tool. */
  protected extractUsage(): UsageDict | null {
    return null;
  }

  protected targets(module: unknown, packageName: string): PatchTarget[] {
    if (packageName === SERVER_PACKAGE) {
      const server: unknown = exportedClass(module, 'McpServer');
      if (typeof server !== 'function') return [];
      return [{ holder: (server as { prototype: object }).prototype, method: 'executeToolHandler', wrap: (original) => this.serverWrapper(original) }];
    }
    const client: unknown = exportedClass(module, 'Client');
    if (typeof client !== 'function') return [];
    return [{ holder: (client as { prototype: object }).prototype, method: 'callTool', wrap: (original) => this.clientWrapper(original) }];
  }

  private sessionState(callContext: MCPCallContext | undefined): MCPSessionState | undefined {
    if (!callContext?.sessionId) return undefined;
    return this.sessionRegistry.get(callContext.sessionId, callContext.seedIdentifiers);
  }

  private clientWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const invoke = (): Promise<unknown> => (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      if (!instrumentor.instrumented) return invoke();

      const params = isMapping(args[0]) ? args[0] : {};
      const name = String(params.name ?? '');
      const callContext = getCallContext();
      const sessionState = instrumentor.sessionState(callContext);
      // The name the server announced itself under, when the client is connected.
      let serverHint: string | undefined;
      try {
        const version = isMapping(this) && typeof this.getServerVersion === 'function' ? (this.getServerVersion as () => unknown).call(this) : undefined;
        const announced = isMapping(version) ? version.name : undefined;
        if (typeof announced === 'string' && instrumentor.registry?.servers.includes(announced)) serverHint = announced;
      } catch {
        serverHint = undefined;
      }

      let attributes: Attributes = {};
      let resolution: ToolResolution = unresolved(name);
      try {
        ({ attributes, resolution } = buildCallAttributes(name, params.arguments, {
          registry: instrumentor.registry,
          sessionState,
          context: callContext,
          serverHint,
        }));
      } catch (error) {
        // Instrumentation must never break the call it observes.
        logger.debug(`Failed to build MCP call attributes: ${String(error)}`);
      }

      const span = instrumentor.tracer.startSpan(buildSpanName(resolution, name), { kind: SpanKind.CLIENT, attributes });
      try {
        const result = await context.with(trace.setSpan(context.active(), span), invoke);
        try {
          span.setAttributes(buildResultAttributes(result, resolution, sessionState));
          span.setStatus({ code: isErrorResult(result) ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        } catch (error) {
          logger.debug(`Failed to record MCP result attributes: ${String(error)}`);
        }
        return result;
      } catch (error) {
        try {
          span.setAttributes(buildErrorAttributes(error));
        } catch {
          // never mask the application's error
        }
        if (error instanceof Error) span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    } as unknown as AnyFunction;
  }

  /** `McpServer.executeToolHandler(tool, args, extra)`: the server's side of a tool call. */
  private serverWrapper(original: AnyFunction): AnyFunction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    return async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const invoke = (): Promise<unknown> => (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      if (!instrumentor.instrumented) return invoke();
      const names = isMapping(this) && isMapping(this._registeredTools) ? this._registeredTools : {};
      const toolName = Object.keys(names).find((name) => names[name] === args[0]) ?? 'unknown';
      const attributes: Record<string, AttributeValue> = { [MCPAttributes.TOOL]: toolName };
      const extra = isMapping(args[2]) ? args[2] : {};
      if (typeof extra.sessionId === 'string') attributes[MCPAttributes.SESSION_ID] = extra.sessionId;
      const span = instrumentor.tracer.startSpan(`mcp.server.call_tool ${toolName}`, { kind: SpanKind.SERVER, attributes });
      try {
        const result = await context.with(trace.setSpan(context.active(), span), invoke);
        if (isErrorResult(result)) {
          span.setAttributes(buildErrorAttributes(extractResultPayload(result)));
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        if (error instanceof Error) span.recordException(error);
        span.setAttributes(buildErrorAttributes(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    } as unknown as AnyFunction;
  }
}

/** The MCP instrumentor `instrument()` starts; give it a tool registry with `mcpInstrumentor().setRegistry(...)`. */
export function mcpInstrumentor(): MCPInstrumentor {
  return stateSlot('mcp.instrumentor', () => new MCPInstrumentor());
}
