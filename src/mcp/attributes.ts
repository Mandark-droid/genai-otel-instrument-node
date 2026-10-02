/**
 * Attribute names for MCP (Model Context Protocol) client spans.
 *
 * A port of `genai_otel/mcp_semconv/attributes.py`. `mcp.*` is protocol-level
 * and tool-selection attribution; `commerce.*` is the outcome signals of
 * commerce-style tool surfaces. Stable constants, so nothing downstream types a
 * literal.
 */
export const MCPAttributes = Object.freeze({
  /** Upstream MCP server that served the call. */
  SERVER: 'mcp.server',
  /** Tool name with any composite-proxy prefix removed. Ground truth is compared against this, never the raw name. */
  TOOL: 'mcp.tool',
  /** Tool name exactly as it appeared on the wire. */
  TOOL_RAW_NAME: 'mcp.tool.raw_name',
  TOOL_PREFIX_STRIPPED: 'mcp.tool.prefix_stripped',
  /** Journey stage from the tool schema. */
  STAGE: 'mcp.stage',
  /** `read-only` or `mutating`. */
  BEHAVIOUR: 'mcp.behaviour',
  IDEMPOTENT: 'mcp.idempotent',
  /** Support-correlation key. */
  SESSION_ID: 'mcp.session_id',
  /** Verbatim upstream error text. Never parsed or normalised. */
  ERROR_MESSAGE_RAW: 'mcp.error.message_raw',
  ERROR_HTTP_STATUS: 'mcp.error.http_status',
  ERROR_JSONRPC_CODE: 'mcp.error.jsonrpc_code',
  TOOL_SELECTION_CANDIDATE_COUNT: 'mcp.tool_selection.candidate_count',
  /** Only set when ground truth was supplied: absence means "not evaluated", not "incorrect". */
  TOOL_SELECTION_CORRECT: 'mcp.tool_selection.correct',
  TOOL_SELECTION_EXPECTED: 'mcp.tool_selection.expected',
  TOOL_SELECTION_REQUESTED_CAPABILITY: 'mcp.tool_selection.requested_capability',
  /** The request carried an identifier seen in no prior response of the session. */
  IDENTIFIER_HALLUCINATED: 'mcp.identifier.hallucinated',
  /** Which argument keys. Keys only: the values are never recorded. */
  IDENTIFIER_HALLUCINATED_KEYS: 'mcp.identifier.hallucinated_keys',
  /** Salted hash of the end-user identifier. The raw identifier never reaches a span. */
  USER_ID_HASH: 'mcp.user.id_hash',
});

export const CommerceAttributes = Object.freeze({
  CART_HASH: 'commerce.cart_hash',
  /** 1-based ordinal of a placement call against the same cart hash. 2 or more is the duplicate-order signal. */
  ORDER_PLACEMENT_ATTEMPT: 'commerce.order.placement_attempt',
  TERMINAL_STATE: 'commerce.terminal_state',
  TERMINAL_STATE_RESOLUTION: 'commerce.terminal_state.resolution',
  TERMINAL_STATE_REASON: 'commerce.terminal_state.reason',
  REQUESTED_RESOLUTION: 'commerce.requested_resolution',
  ORDER_PLACED: 'commerce.order.placed',
  PRICE_QUOTED: 'commerce.price.quoted',
  PRICE_CHARGED: 'commerce.price.charged',
  COUPON_REQUESTED: 'commerce.coupon.requested',
  COUPON_APPLIED: 'commerce.coupon.applied',
  VARIANT_MATCH: 'commerce.variant.match',
});

/** Read, not written, by a classifier to detect enforcement. */
export const GuardrailAttributes = Object.freeze({
  DECISION: 'traceguard.decision',
  BLOCKED: 'guardrail.blocked',
  RULE: 'traceguard.rule',
});

export const BEHAVIOUR_READ_ONLY = 'read-only';
export const BEHAVIOUR_MUTATING = 'mutating';

export const STAGES: ReadonlySet<string> = new Set(['Discover', 'Cart', 'Order', 'Track', 'Find', 'Reserve', 'Manage', 'Support']);
