/**
 * Content on spans, the same way for every provider (contract/SDK_ADDITIONS.md
 * sections 5 to 7).
 *
 * - Content capture off: no attribute that carries what was said reaches a
 *   span, whatever an instrumentor extracted (Python writes `gen_ai.response`
 *   regardless for several providers).
 * - Content capture on: every chat span carries its prompt and its completion,
 *   streamed calls included. An instrumentor that wrote its own content events
 *   keeps them; one that did not gets these.
 *
 * The readers below know the request and response shapes of every provider
 * this SDK instruments: OpenAI and the OpenAI-compatible APIs, Anthropic,
 * Cohere v1 and v2, Ollama, Google Gemini, Bedrock Converse and invoke_model
 * bodies.
 */
import type { AttributeValue, Span } from '@opentelemetry/api';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Attribute keys that carry what was said. */
const CONTENT_KEY =
  /^(gen_ai\.response$|gen_ai\.request\.first_message$|gen_ai\.prompt(\.|$)|gen_ai\.completion(\.|$)|gen_ai\.(input|output)\.messages$|gen_ai\.system_instructions$|llm\.(input|output)_messages\..*\.content$)/;

export function isContentKey(key: string): boolean {
  return CONTENT_KEY.test(key);
}

/** The attributes without the ones that carry content. */
export function withoutContent<T>(attributes: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(attributes)) if (!CONTENT_KEY.test(key)) out[key] = value;
  return out;
}

/** The text of a content value: a string, or text blocks / parts. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.map((block) => (typeof block === 'string' ? block : isObject(block) && typeof block.text === 'string' ? block.text : undefined)).filter((text): text is string => typeof text === 'string');
    return texts.length > 0 ? texts.join('') : undefined;
  }
  return undefined;
}

function parseBody(body: unknown): Obj | undefined {
  try {
    if (typeof body === 'string') return JSON.parse(body) as Obj;
    if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body)) as Obj;
  } catch {
    return undefined;
  }
  return isObject(body) ? body : undefined;
}

export interface Message {
  role: string;
  content: string;
}

/** The messages of a request, in order. Empty when the request has none this can read. */
export function promptMessages(params: Obj): Message[] {
  const out: Message[] = [];
  const push = (role: unknown, content: unknown): void => {
    const text = textOf(content);
    if (text !== undefined) out.push({ role: typeof role === 'string' ? role : 'user', content: text });
  };
  // A system prompt given beside the messages (Anthropic, Bedrock Converse, Cohere v1 preamble).
  if (typeof params.system === 'string') push('system', params.system);
  else if (Array.isArray(params.system)) push('system', params.system);
  const messages = Array.isArray(params.messages) ? params.messages : undefined;
  if (messages) {
    for (const message of messages) {
      if (typeof message === 'string') push('user', message);
      else if (isObject(message)) push(message.role, message.content ?? message.message ?? message.parts);
    }
  }
  // Google: `contents` is a string, a list of strings, or a list of { role, parts }.
  const contents = params.contents;
  if (typeof contents === 'string') push('user', contents);
  else if (Array.isArray(contents)) {
    for (const entry of contents) {
      if (typeof entry === 'string') push('user', entry);
      else if (isObject(entry)) push(entry.role === 'model' ? 'assistant' : entry.role, entry.parts ?? entry.text);
    }
  } else if (isObject(contents)) push(contents.role, contents.parts);
  // Cohere v1 `message`, completion `prompt`, Bedrock invoke_model `inputText`.
  if (out.length === 0 || (out.length === 1 && out[0]?.role === 'system')) {
    if (typeof params.message === 'string') push('user', params.message);
    else if (typeof params.prompt === 'string') push('user', params.prompt);
    else if (typeof params.inputText === 'string') push('user', params.inputText);
  }
  // Bedrock invoke_model: the request is a JSON body.
  if (out.length === 0 && params.body !== undefined) {
    const body = parseBody(params.body);
    if (body) return promptMessages(body);
  }
  return out;
}

/** The completion text of a buffered response. Undefined when it has none this can read. */
export function completionText(result: unknown): string | undefined {
  if (!isObject(result)) return typeof result === 'string' ? result : undefined;
  // OpenAI and the OpenAI-compatible APIs.
  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const first: unknown = result.choices[0];
    if (isObject(first)) {
      if (isObject(first.message)) return textOf(first.message.content);
      if (typeof first.text === 'string') return first.text;
    }
  }
  // OpenAI Responses.
  if (typeof result.output_text === 'string' && result.output_text) return result.output_text;
  // Anthropic, and Anthropic-shaped Bedrock bodies.
  if (Array.isArray(result.content)) return textOf(result.content);
  // Cohere v2 and Ollama chat.
  if (isObject(result.message)) return textOf(result.message.content);
  // Cohere v1, Ollama generate.
  if (typeof result.text === 'string') return result.text;
  if (typeof result.response === 'string') return result.response;
  // Google Gemini.
  if (Array.isArray(result.candidates) && result.candidates.length > 0) {
    const candidate: unknown = result.candidates[0];
    if (isObject(candidate) && isObject(candidate.content)) return textOf(candidate.content.parts);
  }
  // Bedrock Converse.
  if (isObject(result.output) && isObject(result.output.message)) return textOf(result.output.message.content);
  // Bedrock invoke_model: a JSON body (Titan `results`, Llama `generation`, ...).
  if (result.body instanceof Uint8Array) {
    const body = parseBody(result.body);
    if (!body) return undefined;
    if (Array.isArray(body.results) && isObject(body.results[0]) && typeof body.results[0].outputText === 'string') return body.results[0].outputText;
    if (typeof body.generation === 'string') return body.generation;
    if (typeof body.completion === 'string') return body.completion;
    if (Array.isArray(body.outputs) && isObject(body.outputs[0]) && typeof body.outputs[0].text === 'string') return body.outputs[0].text;
    return completionText(body);
  }
  return undefined;
}

/** The text one streamed chunk adds to the completion. */
export function chunkText(chunk: unknown): string | undefined {
  if (!isObject(chunk)) return undefined;
  // OpenAI and the OpenAI-compatible APIs.
  if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
    const first: unknown = chunk.choices[0];
    if (isObject(first) && isObject(first.delta) && typeof first.delta.content === 'string') return first.delta.content;
    if (isObject(first) && typeof first.text === 'string') return first.text;
    return undefined;
  }
  // OpenAI Responses.
  if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') return chunk.delta;
  // Anthropic.
  if (chunk.type === 'content_block_delta' && isObject(chunk.delta) && typeof chunk.delta.text === 'string') return chunk.delta.text;
  // Cohere v2.
  if (chunk.type === 'content-delta' && isObject(chunk.delta) && isObject(chunk.delta.message) && isObject(chunk.delta.message.content)) {
    const text = chunk.delta.message.content.text;
    return typeof text === 'string' ? text : undefined;
  }
  // Cohere v1.
  if (chunk.eventType === 'text-generation' && typeof chunk.text === 'string') return chunk.text;
  // Ollama.
  if (isObject(chunk.message) && typeof chunk.message.content === 'string') return chunk.message.content;
  if (typeof chunk.response === 'string') return chunk.response;
  // Mistral wraps the OpenAI shape in `data`.
  if (isObject(chunk.data)) return chunkText(chunk.data);
  // Google Gemini.
  if (Array.isArray(chunk.candidates)) return completionText(chunk);
  // Bedrock ConverseStream.
  if (isObject(chunk.contentBlockDelta) && isObject(chunk.contentBlockDelta.delta) && typeof chunk.contentBlockDelta.delta.text === 'string') {
    return chunk.contentBlockDelta.delta.text;
  }
  return undefined;
}

function events(span: Span): { name: string }[] {
  return ((span as unknown as { events?: { name: string }[] }).events ?? []) as { name: string }[];
}

function attributes(span: Span): Record<string, unknown> {
  return ((span as unknown as { attributes?: Record<string, unknown> }).attributes ?? {}) as Record<string, unknown>;
}

/**
 * With content capture on: give the span its prompt and completion events and
 * `gen_ai.response` where the instrumentor did not. `cap` bounds each text.
 */
export function ensureContent(span: Span, params: Obj, completion: string | undefined, cap: (text: string) => string): void {
  const written = attributes(span);
  const names = events(span).map((event) => event.name);
  const hasPrompt = names.some((name) => name.startsWith('gen_ai.prompt')) || Object.keys(written).some((key) => key.startsWith('gen_ai.prompt.'));
  if (!hasPrompt) {
    promptMessages(params).forEach((message, index) => {
      span.addEvent(`gen_ai.prompt.${index}`, { 'gen_ai.prompt.role': message.role, 'gen_ai.prompt.content': cap(message.content) });
    });
  }
  if (completion === undefined || completion === '') return;
  const hasCompletion = 'gen_ai.response' in written || names.some((name) => name.startsWith('gen_ai.completion'));
  if (hasCompletion) return;
  const text = cap(completion);
  span.addEvent('gen_ai.completion.0', { 'gen_ai.completion.role': 'assistant', 'gen_ai.completion.content': text });
  span.setAttribute('gen_ai.response', text as AttributeValue);
}

/** Text assembled from a stream, kept only up to the content limit. */
export class StreamText {
  private text = '';
  private full = false;

  constructor(private readonly limit: number) {}

  add(piece: string | undefined): void {
    if (this.full || !piece) return;
    this.text += piece;
    if (this.limit > 0 && [...this.text].length >= this.limit) {
      this.text = [...this.text].slice(0, this.limit).join('');
      this.full = true;
    }
  }

  get value(): string {
    return this.text;
  }
}

