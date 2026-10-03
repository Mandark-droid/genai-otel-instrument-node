/**
 * Media parts of a request onto its span. Port of
 * `BaseInstrumentor._emit_media_attributes` / `_set_part_attrs`.
 *
 * Per message n: `gen_ai.prompt.{n}.role`; per part m:
 * `gen_ai.prompt.{n}.content.{m}.type`, then `.text` for a text part or the
 * media fields (`media_uri`, `media_mime_type`, `media_byte_size`,
 * `media_source`) and `gen_ai.media.stripped_reason`. With the GenAI semconv
 * opt-in, `gen_ai.input.messages` in the canonical form.
 *
 * Text - in the parts and in the canonical form - needs content capture on as
 * well (SDK_ADDITIONS.md section 5). Media capture is its own switch.
 *
 * Uploads may be asynchronous; `emitMedia` returns a promise to wait for
 * before the span ends.
 */
import type { Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { genaiTierOptedIn, SemanticConvention as SC } from '../semconv';
import { stateSlot } from '../state';
import { buildCanonicalMessages } from './canonical';
import { detectParts, type ContentPart } from './detector';
import { offloadPart } from './offload';
import { getStore } from './stores';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (template: string, n: number, m: number): string => template.replace('{n}', String(n)).replace('{m}', String(m));

const pending = (): Set<Promise<void>> => stateSlot('media.pending', () => new Set<Promise<void>>());

/** Settles when no span is waiting for an upload any more. */
export async function mediaIdle(): Promise<void> {
  while (pending().size > 0) await Promise.all([...pending()]);
}

function setPart(span: Span, n: number, m: number, part: ContentPart, config: OTelConfig): void {
  span.setAttribute(at(SC.GEN_AI_PROMPT_CONTENT_TYPE, n, m), part.type);
  if (part.type === 'text') {
    if (!config.enableContentCapture || part.text === undefined) return;
    const max = config.contentMaxLength;
    span.setAttribute(at(SC.GEN_AI_PROMPT_CONTENT_TEXT, n, m), max > 0 ? Array.from(part.text).slice(0, max).join('') : part.text);
    return;
  }
  if (part.mediaUri) span.setAttribute(at(SC.GEN_AI_PROMPT_CONTENT_MEDIA_URI, n, m), part.mediaUri);
  if (part.mediaMimeType) span.setAttribute(at(SC.GEN_AI_PROMPT_CONTENT_MEDIA_MIME, n, m), part.mediaMimeType);
  if (part.mediaByteSize !== undefined) span.setAttribute(at(SC.GEN_AI_PROMPT_CONTENT_MEDIA_BYTES, n, m), Math.trunc(part.mediaByteSize));
  if (part.mediaSource) span.setAttribute(at(SC.GEN_AI_PROMPT_CONTENT_MEDIA_SOURCE, n, m), part.mediaSource);
  const stripped = part.extra.stripped_reason;
  if (typeof stripped === 'string' && stripped) span.setAttribute(SC.GEN_AI_MEDIA_STRIPPED_REASON, stripped);
}

/**
 * Detect, offload and record the media of a request. Undefined when there is
 * nothing to do; otherwise a promise that settles (never rejects) once the
 * span has its attributes.
 */
export function emitMedia(span: Span, provider: string | undefined, params: Obj, config: OTelConfig | undefined): Promise<void> | undefined {
  if (!provider || !config || config.mediaCaptureMode === 'off') return undefined;
  const store = getStore(config);
  let traceId = '';
  try {
    traceId = span.spanContext().traceId;
  } catch {
    // no trace id to key uploads by
  }
  let messages: unknown = params.messages;
  if ((!Array.isArray(messages) || messages.length === 0) && provider === 'google') messages = params.contents;
  const list: unknown[] = Array.isArray(messages) ? messages : typeof messages === 'string' ? [messages] : [];
  const found: [number, string, ContentPart[]][] = [];
  list.forEach((message, n) => {
    let role = 'user';
    let content: unknown = message;
    if (isObject(message)) {
      role = typeof message.role === 'string' ? message.role : 'user';
      content = message.content;
      if (provider === 'google' && content === undefined) content = message.parts;
    }
    const parts = detectParts(provider, content, { maxDecodedBytes: config.mediaMaxBytes || undefined });
    if (parts.length === 0) return;
    span.setAttribute(SC.GEN_AI_PROMPT_ROLE.replace('{n}', String(n)), role);
    found.push([n, role, parts]);
  });
  if (found.length === 0) return undefined;

  const work = (async (): Promise<void> => {
    for (const [n, , parts] of found) {
      for (const [m, part] of parts.entries()) {
        try {
          await offloadPart(part, { config, store, traceId });
        } catch (error) {
          logger.warn(`offload_part failed: ${String(error)}`);
        }
        setPart(span, n, m, part, config);
      }
    }
    // The canonical form carries text: content capture on, and the GenAI opt-in.
    if (config.enableContentCapture && genaiTierOptedIn(config.semconvStabilityOptIn)) {
      const max = config.contentMaxLength || undefined;
      span.setAttribute('gen_ai.input.messages', JSON.stringify(buildCanonicalMessages(found.map(([, role, parts]) => [role, parts]), { maxLength: max })));
    }
  })().catch((error: unknown) => logger.warn(`Failed to emit media attributes: ${String(error)}`));
  pending().add(work);
  void work.then(() => pending().delete(work));
  return work;
}
