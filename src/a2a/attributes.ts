/**
 * Attribute names for A2A (Agent2Agent) spans. Generated from the Python reference
 * (`contract/a2a-a2ui.json`); the `a2a.*` keys beyond the OpenTelemetry A2A conventions are
 * additions of this library and provisional.
 */
import { A2A_NAMES } from '../a2a-a2ui.generated';

export const A2AAttributes = A2A_NAMES.attributes;

/** Every key that can carry prompt, input, output or business text. */
export const A2A_CONTENT_KEYS: ReadonlySet<string> = new Set(A2A_NAMES.content_keys.map((key) => A2AAttributes[key]));

export const BINDING_JSONRPC: string = A2A_NAMES.bindings.jsonrpc;
export const BINDING_GRPC: string = A2A_NAMES.bindings.grpc;
export const BINDING_HTTP_JSON: string = A2A_NAMES.bindings.http_json;

/** `gen_ai.operation.name` on client spans, so a backend can draw an edge from the caller to the called agent. */
export const OPERATION_INVOKE_AGENT: string = A2A_NAMES.operation_invoke_agent;
