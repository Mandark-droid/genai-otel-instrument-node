/**
 * MCP semantic conventions: attribution for tool calls made through the Model
 * Context Protocol. A port of `genai_otel/mcp_semconv/`.
 *
 * Also the terminal-state classifier (`terminal_state.py`): a finished
 * session's spans reduced to one of seven outcomes, with the evidence.
 */
export { BEHAVIOUR_MUTATING, BEHAVIOUR_READ_ONLY, CommerceAttributes, GuardrailAttributes, MCPAttributes, STAGES } from './attributes';
export {
  buildCallAttributes,
  buildErrorAttributes,
  buildResultAttributes,
  buildSpanName,
  extractCart,
  extractResultPayload,
  getCallContext,
  MCPInstrumentor,
  mcpInstrumentor,
  withExpectedTool,
  withMcpSession,
  type CallAttributeInputs,
  type MCPCallContext,
} from './client-instrumentor';
export { DEFAULT_HASH_LENGTH, HASH_SALT_ENV, hashIdentifier, hashUserFields, resetSaltCache } from './privacy';
export {
  canonicaliseCart,
  computeCartHash,
  DEFAULT_IDENTIFIER_KEY_PATTERN,
  MCPSessionRegistry,
  MCPSessionState,
  type SessionStateOptions,
} from './session-tracker';
export {
  DEFAULT_CAPABILITY_PATTERNS,
  DEFAULT_PREFIX_SEPARATORS,
  KNOWN_CAPABILITIES,
  MCPToolRegistry,
  type RegistryOptions,
  type ToolMetadata,
  type ToolResolution,
} from './tool-registry';
export {
  CART_MUTATION_STAGES,
  classifySession,
  GUARDRAIL_BLOCK_DECISIONS,
  NoToolResolution,
  PLATFORM_HTTP_STATUSES,
  TerminalState,
  TerminalStateClassifier,
  type Classification,
  type ClassifierOptions,
  type Evidence,
} from './terminal-state';
