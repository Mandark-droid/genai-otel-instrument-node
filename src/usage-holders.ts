import { createContextKey } from '@opentelemetry/api';
import { stateSlot } from './state';

/**
 * One model call, one usage record (SDK_ADDITIONS.md section 8).
 *
 * Every span the instrumentor base creates owns a holder, visible to the spans started
 * beneath it. A span that records usage marks the holders above it; a span
 * that starts marks them as having a call in flight until it ends. An
 * enclosing span whose holder says either records no usage of its own: the
 * call is recorded once, where it was made.
 */
export interface UsageHolder {
  descendantRecorded: boolean;
  inFlight: number;
}

export const USAGE_HOLDERS = createContextKey('traceverse.genai-otel-instrument.usage-holders');
/** Not in the contract: an SDK attribute (SDK_ADDITIONS.md section 8). */
export const USAGE_RECORDED_BY = 'gen_ai.usage.recorded_by';

export interface HolderEntry {
  holder: UsageHolder;
  above: UsageHolder[];
}

export const holders = (): WeakMap<object, HolderEntry> => stateSlot('usage-holders', () => new WeakMap<object, HolderEntry>());

/** The usage holder of a span this SDK created; undefined for any other span. */
export function usageHolderOf(span: object): UsageHolder | undefined {
  return holders().get(span)?.holder;
}

/** Whether a span's usage was, or is being, recorded by a span beneath it. */
export function usageRecordedBelow(span: object): boolean {
  const holder = usageHolderOf(span);
  return holder !== undefined && (holder.descendantRecorded || holder.inFlight > 0);
}

