/**
 * Attribute names for A2UI (Agent-to-UI) spans.
 *
 * A2UI defines no telemetry of its own and OpenTelemetry has no convention for it, so every
 * `a2ui.*` key is an addition of this library and is provisional. The names are generated from
 * the Python reference (`contract/a2a-a2ui.json`, a scoped addition: see
 * `contract/SDK_ADDITIONS.md`); none is typed here.
 */
import { A2UI_NAMES } from '../a2a-a2ui.generated';

export const A2UIAttributes = A2UI_NAMES.attributes;

/** The A2UI extension URI for A2A, at v1.0. Older protocol versions use the same prefix. */
export const EXTENSION_URI: string = A2UI_NAMES.extension_uri;
export const EXTENSION_URI_PREFIX: string = A2UI_NAMES.extension_uri_prefix;

/** Media types of an A2UI part. The second is deprecated and used by v0.8 and v0.9. */
export const MIME_TYPES: ReadonlySet<string> = new Set(A2UI_NAMES.mime_types);

/** Message metadata keys that carry the renderer's capabilities (v1.0 first, v0.8 / v0.9 second). */
export const CAPABILITIES_KEYS: readonly string[] = A2UI_NAMES.capabilities_keys;

/** Span event written once per renderer error or function error. */
export const ERROR_EVENT: string = A2UI_NAMES.error_event;
/** Span event written when the agent SDK dropped a response it could not parse. */
export const VALIDATION_FAILED_EVENT: string = A2UI_NAMES.validation_failed_event;

export const SIDE_AGENT: string = A2UI_NAMES.sides.agent;
export const SIDE_RENDERER: string = A2UI_NAMES.sides.renderer;

export const VALIDATION_VALID: string = A2UI_NAMES.validation.valid;
export const VALIDATION_INVALID: string = A2UI_NAMES.validation.invalid;

/** Every key that can carry business text, user data or the UI itself. */
export const A2UI_CONTENT_KEYS: ReadonlySet<string> = new Set(A2UI_NAMES.content_keys.map((key) => A2UIAttributes[key]));

/** Span names (the `a2ui.process` one is Python-only: no renderer-to-agent processor in `@a2ui/agent` 0.1.0). */
export const SPAN_PARSE_RESPONSE = 'a2ui.parse_response';
export const SPAN_PARSE_STREAM = 'a2ui.parse_stream';
/** The `@a2ui/web_core` adapter's span, one per applied batch. */
export const SPAN_APPLY = 'a2ui.apply';
/** The public API's own short spans, when no span is active. */
export const SPAN_RECEIVE = 'a2ui.receive';
export const SPAN_SEND = 'a2ui.send';
export const SPAN_RENDERER_ERROR = 'a2ui.renderer_error';
