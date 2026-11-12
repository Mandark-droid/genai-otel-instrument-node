/**
 * Read A2A protocol objects into span attributes. A port of `genai_otel/a2a_semconv/extract.py`
 * for the shapes `@a2a-js/sdk` 1.x hands out.
 *
 * Everything here is duck-typed and imports no A2A package, so it can be tested without the SDK and
 * cannot be the reason an import fails. Each reader tolerates a missing or odd field and returns
 * what it could read.
 *
 * What is recorded follows one rule. Ids, task states, counts of parts by kind, the artifact count
 * and the Agent Card's name, description and version are always recorded: they describe the call,
 * not what was said. Message and artifact text, data parts and skill names are recorded only when
 * content capture is on. File parts are counted and their media type recorded; their bytes, URL and
 * file name never are.
 */
import type { Attributes } from '@opentelemetry/api';
import { logger } from '../logger';
import { A2uiObservation, capabilitiesMetadata, isA2uiMediaType, scrubbedDataText } from '../a2ui/extract';
import { jsonSorted } from '../a2ui/json';
import { A2AAttributes, BINDING_GRPC, BINDING_HTTP_JSON, BINDING_JSONRPC } from './attributes';

type Obj = Record<string, unknown>;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const TASK_STATES: Record<number, string> = {
  1: 'submitted',
  2: 'working',
  3: 'completed',
  4: 'failed',
  5: 'canceled',
  6: 'input_required',
  7: 'rejected',
  8: 'auth_required',
};

/** Method names on the wire, by the client method of `@a2a-js/sdk`. */
export const CLIENT_METHODS: Readonly<Record<string, string>> = {
  sendMessage: 'SendMessage',
  sendMessageStream: 'SendMessage', // becomes SendStreamingMessage when the card says the agent streams
  getTask: 'GetTask',
  listTasks: 'ListTasks',
  cancelTask: 'CancelTask',
  createTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
  getTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
  listTaskPushNotificationConfig: 'ListTaskPushNotificationConfigs',
  deleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
  resubscribeTask: 'SubscribeToTask',
  getAgentCard: 'GetExtendedAgentCard',
};
export const STREAMING_SEND_METHOD = 'SendStreamingMessage';

/** Client methods whose result is a stream of events. */
export const STREAMING_CLIENT_METHODS: ReadonlySet<string> = new Set(['sendMessageStream', 'resubscribeTask']);

/** `TASK_STATE_INPUT_REQUIRED` (or its number) as `input_required`. */
export function stateName(state: unknown): string | undefined {
  if (typeof state === 'boolean') return undefined;
  if (typeof state === 'number') return TASK_STATES[state];
  if (typeof state === 'string') {
    let name = state.toUpperCase();
    if (name.startsWith('TASK_STATE_')) name = name.slice('TASK_STATE_'.length);
    if (name === '' || name === 'UNSPECIFIED' || name === 'UNRECOGNIZED') return undefined;
    return name.toLowerCase();
  }
  return undefined;
}

/** An Agent Card `protocolBinding` string (`JSONRPC`, `GRPC`, `HTTP+JSON`). */
export function bindingFromCardValue(value: unknown): string | undefined {
  const text = String(value ?? '')
    .toUpperCase()
    .replace(/[-_+]/g, '');
  if (text === 'JSONRPC') return BINDING_JSONRPC;
  if (text === 'GRPC') return BINDING_GRPC;
  if (text === 'HTTPJSON' || text === 'REST') return BINDING_HTTP_JSON;
  return undefined;
}

/** Which binding a client's transport speaks (`transport.protocolName`). */
export function bindingFromTransport(transport: unknown): string | undefined {
  if (!isMapping(transport)) return undefined;
  const named = bindingFromCardValue(transport.protocolName);
  if (named) return named;
  // A tenant decorator wraps the real transport.
  for (const key of ['base', '_base', 'delegate', '_delegate']) {
    const inner: unknown = transport[key];
    if (inner !== undefined && inner !== transport) {
      const found: string | undefined = bindingFromTransport(inner);
      if (found) return found;
    }
  }
  return undefined;
}

/** The Agent Card interface for `binding`, else the first one. */
export function pickInterface(card: unknown, binding: string | undefined): Obj | undefined {
  if (!isMapping(card)) return undefined;
  const interfaces = asList(card.supportedInterfaces).filter(isMapping);
  if (interfaces.length === 0) return undefined;
  if (binding) {
    const match = interfaces.find((entry) => bindingFromCardValue(entry.protocolBinding) === binding);
    if (match) return match;
  }
  return interfaces[0];
}

/** `[always, content]` attributes for an Agent Card. `content` (skill names) is empty unless `capture`. */
export function cardAttributes(card: unknown, capture = false): [Attributes, Attributes] {
  const always: Attributes = {};
  const content: Attributes = {};
  if (!isMapping(card)) return [always, content];
  try {
    for (const [key, field] of [
      [A2AAttributes.AGENT_NAME, 'name'],
      [A2AAttributes.AGENT_DESCRIPTION, 'description'],
      [A2AAttributes.AGENT_VERSION, 'version'],
    ] as const) {
      const value = nonEmpty(card[field]);
      if (value !== undefined) always[key] = value;
    }
    const skills = asList(card.skills);
    always[A2AAttributes.AGENT_SKILL_COUNT] = skills.length;
    if (capture) {
      const names = skills.map((skill) => (isMapping(skill) ? nonEmpty(skill.name) : undefined)).filter((name): name is string => name !== undefined);
      if (names.length > 0) content[A2AAttributes.AGENT_SKILL_NAMES] = names;
    }
  } catch (error) {
    logger.debug(`Could not read the Agent Card: ${String(error)}`);
  }
  return [always, content];
}

/** `server.address` / `server.port` from an interface URL. */
export function serverAddress(url: unknown): Attributes {
  const attributes: Attributes = {};
  if (typeof url !== 'string' || !url) return attributes;
  const target = url.includes('://') ? url : `//${url}`;
  const match = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]*)(?::(\d+))?/.exec(target);
  if (!match) return attributes;
  const scheme = (match[1] ?? '').toLowerCase();
  const host = (match[2] || '').replace(/^\[|\]$/g, '');
  if (!host) return attributes;
  attributes[A2AAttributes.SERVER_ADDRESS] = host.toLowerCase();
  let port = match[3] ? Number(match[3]) : undefined;
  if (port === undefined) port = scheme === 'https' ? 443 : scheme === 'http' ? 80 : undefined;
  if (port !== undefined) attributes[A2AAttributes.SERVER_PORT] = port;
  return attributes;
}

/**
 * `error.type` for a failed call: the class of the error (`TaskNotFoundError`). A JSON-RPC, REST or
 * gRPC error twin keeps its class name, so the A2A error name is what a backend sees.
 */
export function errorType(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const constructorName = (error as { constructor?: { name?: string } }).constructor?.name;
  const ownName = (error as { name?: unknown }).name;
  if (constructorName && constructorName !== 'Error') return constructorName;
  if (typeof ownName === 'string' && ownName) return ownName;
  return constructorName || 'Error';
}

// --- Reading messages ----------------------------------------------------------------------

/** `text`, `file` or `data` for an A2A part, from the protobuf-style oneof or the older `kind` field. */
function partKind(part: Obj): string | undefined {
  const content = part.content;
  const which = isMapping(content) ? content.$case : part.kind;
  if (which === 'text') return 'text';
  if (which === 'raw' || which === 'url' || which === 'file') return 'file';
  if (which === 'data') return 'data';
  if (which === undefined) {
    for (const candidate of ['text', 'raw', 'url', 'data'] as const) {
      if (part[candidate] !== undefined) return candidate === 'text' ? 'text' : candidate === 'data' ? 'data' : 'file';
    }
  }
  return undefined;
}

function partValue(part: Obj): unknown {
  const content = part.content;
  if (isMapping(content)) return content.value;
  return part.text ?? part.data;
}

/**
 * The decoded payload of an A2A data part when it is an A2UI part, else `undefined`. A part is A2UI
 * when `metadata.mimeType` or the part's own `mediaType` is one of the two A2UI media types. The
 * payload is one message or a list of messages: the specification says an array, the agent SDKs
 * write one message per part, and both must be read.
 */
export function readA2aPart(part: unknown): unknown {
  if (!isMapping(part)) return undefined;
  let mime = false;
  try {
    mime = isA2uiMediaType(part.mediaType);
    if (!mime && isMapping(part.metadata)) mime = isA2uiMediaType(part.metadata.mimeType);
  } catch {
    return undefined;
  }
  if (!mime) return undefined;
  const payload = partValue(part);
  return Array.isArray(payload) || isMapping(payload) ? payload : undefined;
}

/** What a call put on the wire, or got back, accumulated across stream events. */
export class A2aObservation {
  readonly taskIds = new Set<string>();
  readonly contextIds = new Set<string>();
  readonly states = new Set<string>();
  /** The latest state seen, in event order: a stream's final state. */
  lastState: string | undefined;
  readonly artifactIds = new Set<string>();
  messageId: string | undefined;
  referenceTaskIds: string[] = [];
  tenant: string | undefined;
  readonly partCounts: Record<string, number> = { text: 0, file: 0, data: 0 };
  readonly fileMediaTypes = new Set<string>();
  readonly texts: string[] = [];
  readonly datas: string[] = [];
  hasParts = false;

  /**
   * `a2ui`, when set, also receives A2UI data parts, from `a2uiSide`. The request and the response
   * of one call share one, so an identifier seen as two values across them is omitted. Without it no
   * A2UI is read at all.
   */
  constructor(
    readonly capture = false,
    readonly a2ui?: A2uiObservation,
    readonly a2uiSide?: string,
  ) {}

  private addParts(parts: unknown): void {
    for (const raw of asList(parts)) {
      if (!isMapping(raw)) continue;
      const kind = partKind(raw);
      if (kind === undefined) continue;
      this.hasParts = true;
      this.partCounts[kind] = (this.partCounts[kind] ?? 0) + 1;
      if (kind === 'file') {
        // Counted and typed. The bytes, the URL and the file name are never read.
        const mediaType = nonEmpty(raw.mediaType);
        if (mediaType) this.fileMediaTypes.add(mediaType);
      } else if (kind === 'data' && this.a2ui && this.addA2uiPart(raw)) {
        continue;
      } else if (!this.capture) {
        continue;
      } else if (kind === 'text') {
        this.texts.push(String(partValue(raw) ?? ''));
      } else {
        this.datas.push(jsonSorted(partValue(raw)));
      }
    }
  }

  /** Read an A2UI data part. True when it was one (its data is then handled here). */
  private addA2uiPart(part: Obj): boolean {
    const payload = readA2aPart(part);
    if (payload === undefined || !this.a2ui || !this.a2uiSide) return false;
    this.a2ui.addPayload(payload, this.a2uiSide);
    // The same data, with media URLs left out, so the A2A data attribute does not carry what the
    // A2UI content rule never records.
    if (this.capture) this.datas.push(scrubbedDataText(payload));
    return true;
  }

  /** Note the A2UI extension among `values` (header values, URIs from a context). */
  observeExtensions(values: Iterable<unknown>): void {
    this.a2ui?.markExtension(values);
  }

  private addMetadata(metadata: unknown): void {
    if (!this.a2ui) return;
    const data = capabilitiesMetadata(metadata);
    if (data) this.a2ui.addCapabilities(data);
  }

  private addArtifact(artifact: unknown): void {
    if (!isMapping(artifact)) return;
    this.artifactIds.add(nonEmpty(artifact.artifactId) ?? `#${this.artifactIds.size}`);
    this.addParts(artifact.parts);
    this.observeExtensions(asList(artifact.extensions));
  }

  private addIds(taskId?: unknown, contextId?: unknown): void {
    const task = nonEmpty(taskId);
    if (task) this.taskIds.add(task);
    const context = nonEmpty(contextId);
    if (context) this.contextIds.add(context);
  }

  private addStatus(status: unknown): void {
    if (!isMapping(status)) return;
    const name = stateName(status.state);
    if (name) {
      this.states.add(name);
      this.lastState = name;
    }
    if (isMapping(status.message)) this.addParts(status.message.parts);
  }

  // -- what was sent -------------------------------------------------------------------------

  /** Read the request object (the first argument of a client call), given the client method. */
  observeRequest(method: string, request: unknown): void {
    try {
      if (!isMapping(request)) return;
      const tenant = nonEmpty(request.tenant);
      if (tenant) this.tenant = tenant;
      if (method === 'sendMessage' || method === 'sendMessageStream') {
        const message = isMapping(request.message) ? request.message : {};
        this.addIds(message.taskId, message.contextId);
        this.messageId = nonEmpty(message.messageId);
        this.referenceTaskIds = asList(message.referenceTaskIds).filter((id): id is string => typeof id === 'string');
        this.addParts(message.parts);
        this.observeExtensions(asList(message.extensions));
        this.addMetadata(message.metadata);
        this.addMetadata(request.metadata);
      } else if (method === 'getTask' || method === 'cancelTask' || method === 'resubscribeTask') {
        this.addIds(request.id);
      } else if (method === 'listTasks') {
        this.addIds(undefined, request.contextId);
      } else if (
        method === 'createTaskPushNotificationConfig' ||
        method === 'getTaskPushNotificationConfig' ||
        method === 'listTaskPushNotificationConfig' ||
        method === 'deleteTaskPushNotificationConfig'
      ) {
        this.addIds(request.taskId);
      }
    } catch (error) {
      logger.debug(`Could not read an A2A request: ${String(error)}`);
    }
  }

  // -- what came back ------------------------------------------------------------------------

  /** Read a response, a stream event, a Task or a Message. */
  observeResult(result: unknown): void {
    try {
      this.readResult(result);
    } catch (error) {
      logger.debug(`Could not read an A2A result: ${String(error)}`);
    }
  }

  private readResult(result: unknown): void {
    if (!isMapping(result)) return;
    const payload = result.payload;
    if (isMapping(payload) && typeof payload.$case === 'string') {
      // StreamResponse / SendMessageResponse: a protobuf-style oneof.
      this.readEvent(payload.$case, payload.value);
      return;
    }
    if ('messageId' in result) this.readEvent('message', result);
    else if ('status' in result && 'id' in result) this.readEvent('task', result);
  }

  private readEvent(kind: string, value: unknown): void {
    if (!isMapping(value)) return;
    if (kind === 'task') {
      this.addIds(value.id, value.contextId);
      this.addStatus(value.status);
      for (const artifact of asList(value.artifacts)) this.addArtifact(artifact);
    } else if (kind === 'message') {
      this.addIds(value.taskId, value.contextId);
      this.addParts(value.parts);
      this.observeExtensions(asList(value.extensions));
    } else if (kind === 'statusUpdate') {
      this.addIds(value.taskId, value.contextId);
      this.addStatus(value.status);
    } else if (kind === 'artifactUpdate') {
      this.addIds(value.taskId, value.contextId);
      this.addArtifact(value.artifact);
    }
  }
}

const single = (values: Set<string>): string | undefined => (values.size === 1 ? [...values][0] : undefined);

/** `[always, content]` attributes from what a call sent and received. */
export function buildAttributes(request: A2aObservation, response: A2aObservation): [Attributes, Attributes] {
  const always: Attributes = {};
  const content: Attributes = {};
  const put = (key: string, value: string | number | undefined): void => {
    if (value !== undefined && value !== '') always[key] = value;
  };

  // An id seen as several distinct values across the operation is left off: it would mislabel the
  // span. A task's state, by contrast, legitimately moves through a stream (submitted -> working ->
  // completed), so the FINAL state is recorded, but only when the operation concerned at most one task.
  const taskIds = new Set([...request.taskIds, ...response.taskIds]);
  put(A2AAttributes.TASK_ID, single(taskIds));
  put(A2AAttributes.CONVERSATION_ID, single(new Set([...request.contextIds, ...response.contextIds])));
  if (taskIds.size <= 1) put(A2AAttributes.TASK_STATE, response.lastState);
  put(A2AAttributes.TENANT, request.tenant);
  put(A2AAttributes.MESSAGE_ID, request.messageId);
  if (request.referenceTaskIds.length > 0) always[A2AAttributes.MESSAGE_REFERENCE_TASK_IDS] = [...request.referenceTaskIds];

  if (request.hasParts) {
    always[A2AAttributes.MESSAGE_TEXT_PART_COUNT] = request.partCounts.text ?? 0;
    always[A2AAttributes.MESSAGE_FILE_PART_COUNT] = request.partCounts.file ?? 0;
    always[A2AAttributes.MESSAGE_DATA_PART_COUNT] = request.partCounts.data ?? 0;
    if (request.fileMediaTypes.size > 0) always[A2AAttributes.MESSAGE_FILE_MEDIA_TYPES] = [...request.fileMediaTypes].sort();
  }
  if (response.hasParts) {
    always[A2AAttributes.RESPONSE_TEXT_PART_COUNT] = response.partCounts.text ?? 0;
    always[A2AAttributes.RESPONSE_FILE_PART_COUNT] = response.partCounts.file ?? 0;
    always[A2AAttributes.RESPONSE_DATA_PART_COUNT] = response.partCounts.data ?? 0;
    if (response.fileMediaTypes.size > 0) always[A2AAttributes.RESPONSE_FILE_MEDIA_TYPES] = [...response.fileMediaTypes].sort();
  }
  if (response.artifactIds.size > 0) always[A2AAttributes.ARTIFACT_COUNT] = response.artifactIds.size;

  if (request.texts.length > 0) content[A2AAttributes.MESSAGE_TEXT] = request.texts.join('\n');
  if (request.datas.length > 0) content[A2AAttributes.MESSAGE_DATA] = request.datas.join('\n');
  if (response.texts.length > 0) content[A2AAttributes.RESPONSE_TEXT] = response.texts.join('\n');
  if (response.datas.length > 0) content[A2AAttributes.RESPONSE_DATA] = response.datas.join('\n');
  return [always, content];
}
