/**
 * Read A2UI messages into span attributes. A port of `genai_otel/a2ui_semconv/extract.py`.
 *
 * One accumulator, `A2uiObservation`, is shared by the A2A path (parts found in an A2A message or
 * stream), by the agent-SDK wrappers (what `parseResponse` produced), by the `@a2ui/web_core`
 * adapter and by the public API. It reads plain objects in the wire format, so it imports no A2A or
 * A2UI package and can neither be the reason an import fails nor depend on a version of either.
 *
 * What is recorded follows one rule (decision A2UI-D3). Message types, protocol version, surface and
 * catalog ids, counts, action and function names and error codes are always recorded: they describe
 * the exchange, not what was said. The messages themselves, the data-model values, an action's
 * context, an error's path and message and component type names are recorded only with content
 * capture on, truncated to the content limit. The content of image or file URLs inside components is
 * never recorded.
 *
 * v0.8 messages are recognised (they have no `version` field) and counted, and nothing more is read
 * from them: the version is deprecated and its shapes differ.
 */
import type { Attributes, AttributeValue, Span } from '@opentelemetry/api';
import { logger } from '../logger';
import {
  A2UIAttributes,
  CAPABILITIES_KEYS,
  ERROR_EVENT,
  EXTENSION_URI_PREFIX,
  MIME_TYPES,
  SIDE_AGENT,
  SIDE_RENDERER,
  VALIDATION_INVALID,
} from './attributes';
import { jsonCompactSorted, jsonSorted } from './json';

type Obj = Record<string, unknown>;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Agent-to-renderer message keys, and renderer-to-agent ones. */
export const AGENT_KINDS: ReadonlySet<string> = new Set([
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
  'callFunction', // v0.9
]);
export const RENDERER_KINDS: ReadonlySet<string> = new Set(['action', 'callAgentFunction', 'rendererFunctionResponse', 'error']);

const REDACTED = '[redacted]';
const URL_KEY = /^(url|src|uri)$|(Url|URL|Uri|URI)$/;

/** `updateComponents` as `update_components`. */
export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (char, index: number) => (index === 0 ? char : `_${char}`)).toLowerCase();
}

/** `"1.0"`, `"v0.9"` and `"v0.9.1"` as `1.0`, `0.9` and `0.9`. */
export function normaliseVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let text = value.trim();
  if (text[0] === 'v' || text[0] === 'V') text = text.slice(1);
  const pieces = text.split('.');
  if (pieces.length < 2 || !pieces.slice(0, 2).every((piece) => /^\d+$/.test(piece))) return undefined;
  return `${Number(pieces[0])}.${Number(pieces[1])}`;
}

/** True for the A2UI extension URI, at any protocol version. */
export function isExtensionUri(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith(EXTENSION_URI_PREFIX);
}

/** True when any of `values` (a header's comma-separated URIs included) is A2UI's. */
export function hasExtension(values: Iterable<unknown> | undefined): boolean {
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue;
    for (const item of value.split(',')) if (isExtensionUri(item)) return true;
  }
  return false;
}

// --- Redaction ------------------------------------------------------------------------------

/** A data binding (`{"@path": ...}`) names where a value lives, not the value. */
function isBinding(value: unknown): boolean {
  return isMapping(value) && '@path' in value && Object.keys(value).length === 1;
}

/**
 * A copy of `value` with media URLs and `data:` URIs replaced. `urls` also replaces the value of
 * keys that name a URL; it is set inside components, where those keys are image, video and audio
 * sources.
 */
function scrub(value: unknown, urls: boolean): unknown {
  if (isMapping(value)) {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = urls && URL_KEY.test(key) && !isBinding(item) ? REDACTED : scrub(item, urls);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, urls));
  if (typeof value === 'string' && value.slice(0, 5).toLowerCase() === 'data:') return REDACTED;
  return value;
}

/** A copy of one wire-format message that is safe to record under content capture. */
export function scrubMessage(message: Obj): Obj {
  const out: Obj = {};
  for (const [key, item] of Object.entries(message)) {
    if ((key === 'createSurface' || key === 'updateComponents') && isMapping(item)) {
      const body: Obj = {};
      for (const [k, v] of Object.entries(item)) body[k] = scrub(v, k === 'components');
      out[key] = body;
    } else {
      out[key] = scrub(item, false);
    }
  }
  return out;
}

/** `scrubMessage` over one message or a list of them. */
export function scrubPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((message) => (isMapping(message) ? scrubMessage(message) : message));
  return isMapping(payload) ? scrubMessage(payload) : payload;
}

// --- The accumulator -------------------------------------------------------------------------

/** What this reader accepts as one message: a plain object, or a value with `toJSON()`. */
function messageToObject(message: unknown): Obj | undefined {
  if (isMapping(message)) return message;
  return undefined;
}

/**
 * The messages of a payload that may be a `{ messages: [...] }` wrapper (the message-list wrapper
 * `@a2ui/web_core` accepts): the list, or the payload itself. Applied only where a wrapper can
 * occur; the A2A path reads a data part as Python does, one message or a list.
 */
export function unwrapMessageList(payload: unknown): unknown {
  if (isMapping(payload) && Array.isArray(payload.messages) && !Object.keys(payload).some((key) => AGENT_KINDS.has(key) || RENDERER_KINDS.has(key))) {
    return payload.messages;
  }
  return payload;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export interface ObservedError {
  code?: string;
  surface?: string;
  path?: string;
  message?: string;
}

/** One value, or `undefined` when there are none or several. */
const only = (values: Set<string>): string | undefined => (values.size === 1 ? [...values][0] : undefined);

/**
 * What one operation put on the wire as A2UI, accumulated across messages. `capture` says whether
 * the content lists are kept at all: with it off nothing of the payload is held.
 */
export class A2uiObservation {
  readonly versions = new Set<string>();
  readonly counts: Record<string, number> = { [SIDE_AGENT]: 0, [SIDE_RENDERER]: 0 };
  readonly sidesSeen = new Set<string>();
  readonly types = new Set<string>();
  readonly surfaceIds = new Set<string>();
  readonly catalogIds = new Set<string>();
  componentCount = 0;
  componentsSeen = false;
  readonly supportedCatalogIds = new Set<string>();
  readonly actionNames = new Set<string>();
  readonly functionNames = new Set<string>();
  readonly errors: ObservedError[] = [];
  outcome: string | undefined;
  extensionActive = false;
  // Content, kept only under capture.
  readonly componentTypes = new Set<string>();
  readonly messages: unknown[] = [];
  readonly dataModel: unknown[] = [];
  readonly actionContexts: unknown[] = [];

  constructor(readonly capture = false) {}

  /** True when anything A2UI was seen, so a span has something to carry. */
  get hasData(): boolean {
    return this.sidesSeen.size > 0 || this.supportedCatalogIds.size > 0 || this.extensionActive || this.outcome !== undefined;
  }

  /** Read one message, or a list of them, from the `side` that sent it. */
  addPayload(payload: unknown, side: string): void {
    this.sidesSeen.add(side);
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      const message = messageToObject(item);
      if (message) this.addMessage(message, side);
    }
  }

  /** Read a sequence of messages from `side`. */
  addMessages(messages: Iterable<unknown>, side: string): void {
    this.addPayload([...messages], side);
  }

  /** Read one wire-format message from `side`. Never throws. */
  addMessage(message: Obj, side: string): void {
    try {
      this.readMessage(message, side);
    } catch (error) {
      logger.debug(`Could not read an A2UI message: ${String(error)}`);
    }
  }

  private readMessage(message: Obj, side: string): void {
    this.sidesSeen.add(side);
    this.counts[side] = (this.counts[side] ?? 0) + 1;
    const version = 'version' in message ? normaliseVersion(message.version) : '0.8';
    if (version) this.versions.add(version);
    if (version === '0.8') return; // counted and recognised, not parsed
    const known = side === SIDE_AGENT ? AGENT_KINDS : RENDERER_KINDS;
    const kind = Object.keys(message).find((key) => known.has(key));
    if (kind === undefined) return;
    this.types.add(snake(kind));
    const body = isMapping(message[kind]) ? (message[kind] as Obj) : {};
    const surface = text(body.surfaceId);
    if (surface) this.surfaceIds.add(surface);
    if (this.capture) this.messages.push(scrubMessage(message));

    if (kind === 'createSurface' || kind === 'updateComponents') {
      this.readSurfaceMessage(kind, body);
    } else if (kind === 'updateDataModel') {
      if (this.capture && 'value' in body) this.dataModel.push(scrub(body.value, false));
    } else if (kind === 'callRendererFunction' || kind === 'callAgentFunction') {
      const call = body.callFunction;
      if (isMapping(call)) {
        const name = text(call['@call']) ?? text(call.call);
        if (name) this.functionNames.add(name);
        const catalog = text(call.catalogId);
        if (catalog) this.catalogIds.add(catalog);
      }
    } else if (kind === 'action') {
      const name = text(body.name);
      if (name) this.actionNames.add(name);
      if (this.capture && 'context' in body) this.actionContexts.push(scrub(body.context, false));
    } else if (kind === 'error') {
      this.addError(body, surface);
    } else if (kind === 'agentFunctionResponse' || kind === 'rendererFunctionResponse') {
      if (isMapping(body.error)) this.addError(body.error, surface);
    }
  }

  private readSurfaceMessage(kind: string, body: Obj): void {
    const catalog = text(body.catalogId);
    if (catalog) this.catalogIds.add(catalog);
    if (kind === 'updateComponents') this.componentsSeen = true;
    const components = body.components;
    if (!Array.isArray(components)) return;
    this.componentsSeen = true;
    this.componentCount += components.length;
    for (const component of components) {
      if (!isMapping(component)) continue;
      const override = text(component.catalogId) ?? text(component['@catalogId']);
      if (override) this.catalogIds.add(override);
      const name = text(component.component);
      if (this.capture && name) this.componentTypes.add(name);
    }
  }

  /**
   * A renderer error the app knows only as an error, with no message envelope and so no protocol
   * version (a thrown error, a bare `{ code, message }`). Counted as a renderer message of type
   * `error`; the version is left alone rather than guessed.
   */
  addRendererError(body: Obj): void {
    try {
      this.sidesSeen.add(SIDE_RENDERER);
      this.counts[SIDE_RENDERER] = (this.counts[SIDE_RENDERER] ?? 0) + 1;
      this.types.add('error');
      const surface = text(body.surfaceId);
      if (surface) this.surfaceIds.add(surface);
      if (this.capture) this.messages.push({ error: scrub(body, false) });
      this.addError(body, surface);
    } catch (error) {
      logger.debug(`Could not read an A2UI error: ${String(error)}`);
    }
  }

  private addError(body: Obj, surface: string | undefined): void {
    const errorSurface = text(body.surfaceId);
    this.errors.push({
      code: text(body.code),
      surface: errorSurface ?? surface,
      path: text(body.path),
      message: text(body.message),
    });
    if (errorSurface) this.surfaceIds.add(errorSurface);
  }

  /** Read the renderer's catalogs from message metadata (either key, any version). */
  addCapabilities(metadata: Obj): void {
    for (const key of CAPABILITIES_KEYS) {
      const value = metadata[key];
      if (!isMapping(value)) continue;
      const bodies: Obj[] = [value, ...Object.values(value).filter(isMapping)];
      for (const body of bodies) {
        const ids = body.supportedCatalogIds;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && id) this.supportedCatalogIds.add(id);
      }
    }
  }

  /** Note that the A2UI extension URI is among `values` (header values or a list). */
  markExtension(values: Iterable<unknown> | undefined): void {
    if (hasExtension(values)) this.extensionActive = true;
  }

  /** `valid` or `invalid`. Invalid is never overwritten by a later valid. */
  setOutcome(outcome: string): void {
    if (outcome === VALIDATION_INVALID || this.outcome !== VALIDATION_INVALID) this.outcome = outcome;
  }

  /** `[always, content]` attributes. `content` is empty unless capture is on. */
  attributes(): [Attributes, Attributes] {
    const always: Attributes = {};
    const content: Attributes = {};
    const A = A2UIAttributes;

    // A single-valued identifier seen as several values in one operation is left off: it would
    // mislabel the span. Lists are sorted and de-duplicated.
    const version = only(this.versions);
    if (version !== undefined) always[A.PROTOCOL_VERSION] = version;
    if (this.sidesSeen.has(SIDE_AGENT)) always[A.AGENT_MESSAGE_COUNT] = this.counts[SIDE_AGENT] ?? 0;
    if (this.sidesSeen.has(SIDE_RENDERER)) always[A.RENDERER_MESSAGE_COUNT] = this.counts[SIDE_RENDERER] ?? 0;
    if (this.types.size > 0) always[A.MESSAGE_TYPES] = [...this.types].sort();
    const surface = only(this.surfaceIds);
    if (surface !== undefined) always[A.SURFACE_ID] = surface;
    if (this.surfaceIds.size > 0) always[A.SURFACE_COUNT] = this.surfaceIds.size;
    const catalog = only(this.catalogIds);
    if (catalog !== undefined) always[A.CATALOG_ID] = catalog;
    if (this.catalogIds.size > 0) always[A.CATALOG_IDS] = [...this.catalogIds].sort();
    if (this.componentsSeen) always[A.COMPONENT_COUNT] = this.componentCount;
    if (this.supportedCatalogIds.size > 0) always[A.RENDERER_SUPPORTED_CATALOG_IDS] = [...this.supportedCatalogIds].sort();
    const action = only(this.actionNames);
    if (action !== undefined) always[A.ACTION_NAME] = action;
    const fn = only(this.functionNames);
    if (fn !== undefined) always[A.FUNCTION_NAME] = fn;
    if (this.errors.length > 0) {
      always[A.ERROR_COUNT] = this.errors.length;
      const codes = [...new Set(this.errors.map((error) => error.code).filter((code): code is string => Boolean(code)))].sort();
      if (codes.length > 0) always[A.ERROR_CODES] = codes;
    }
    if (this.outcome) always[A.VALIDATION_OUTCOME] = this.outcome;
    if (this.extensionActive) always[A.EXTENSION_ACTIVE] = true;

    if (this.capture) {
      if (this.messages.length > 0) content[A.MESSAGES] = jsonCompactSorted(this.messages);
      if (this.dataModel.length > 0) content[A.DATA_MODEL] = jsonCompactSorted(this.dataModel);
      if (this.actionContexts.length > 0) content[A.ACTION_CONTEXT] = jsonCompactSorted(this.actionContexts);
      const paths = this.errors.map((error) => error.path).filter((path): path is string => Boolean(path));
      if (paths.length > 0) content[A.ERROR_PATHS] = paths;
      const texts = this.errors.map((error) => error.message).filter((message): message is string => Boolean(message));
      if (texts.length > 0) content[A.ERROR_MESSAGES] = texts;
      if (this.componentTypes.size > 0) content[A.COMPONENT_TYPES] = [...this.componentTypes].sort();
    }
    return [always, content];
  }

  /** One `a2ui.error` event per error, so each is visible when several share a span. */
  events(): [string, Attributes][] {
    return this.errors.map((error): [string, Attributes] => {
      const attributes: Attributes = {};
      if (error.code) attributes[A2UIAttributes.EVENT_ERROR_CODE] = error.code;
      if (error.surface) attributes[A2UIAttributes.SURFACE_ID] = error.surface;
      return [ERROR_EVENT, attributes];
    });
  }
}

/** Writes one content attribute; where capture and the length limit are enforced. */
export type PutContent = (span: Span, key: string, value: AttributeValue) => void;

/**
 * Write an observation's attributes and events on `span`. `putContent` writes one content attribute
 * and is where capture and the length limit are enforced. `skipEvents` leaves the first n events
 * out (an observation written more than once). Never throws: a span that cannot be written is not
 * worth the call.
 */
export function applyToSpan(span: Span, observation: A2uiObservation, putContent: PutContent, skipEvents = 0): void {
  try {
    const [always, content] = observation.attributes();
    for (const [key, value] of Object.entries(always)) if (value !== undefined) span.setAttribute(key, value);
    for (const [key, value] of Object.entries(content)) if (value !== undefined) putContent(span, key, value);
    for (const [name, attributes] of observation.events().slice(skipEvents)) span.addEvent(name, attributes);
  } catch (error) {
    logger.debug(`Could not write A2UI attributes: ${String(error)}`);
  }
}

/** The A2A `data` content, with media URLs left out (see `A2uiObservation`). */
export function scrubbedDataText(payload: unknown): string {
  return jsonSorted(scrubPayload(payload));
}

/** Read the A2UI payload of one A2A data part. See `readA2aPart` in `src/a2a/extract.ts`. */
export function isA2uiMediaType(value: unknown): boolean {
  return typeof value === 'string' && MIME_TYPES.has(value);
}

/** A metadata object, only when it names renderer capabilities. */
export function capabilitiesMetadata(metadata: unknown): Obj | undefined {
  if (!isMapping(metadata)) return undefined;
  return CAPABILITIES_KEYS.some((key) => key in metadata) ? metadata : undefined;
}
