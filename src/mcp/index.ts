/**
 * MCP semantic conventions: attribution for tool calls made through the Model
 * Context Protocol. A port of `genai_otel/mcp_semconv/`.
 *
 * Not ported in this phase: the terminal-state classifier
 * (`terminal_state.py`), which reduces a finished session's spans to one of
 * seven outcomes. It is an analysis of collected spans, not instrumentation,
 * and is planned with the evaluation work.
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
