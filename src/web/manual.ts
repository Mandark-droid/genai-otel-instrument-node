/**
 * A span around a GenAI call the application makes itself.
 *
 * In a browser or a React Native app there are no modules to patch: the model
 * runs on the device, behind whatever library the app chose. `traceGenAiCall`
 * gives such a call the same span, token attributes, cost and metrics a patched
 * provider call gets on Node, through the same base instrumentor.
 */
import type { OTelConfig } from '../config';
import { BaseInstrumentor, type UsageDict } from '../instrumentors/base';
import { ATTR } from '../semconv';
import { stateSlot } from '../state';

export interface GenAiCall {
  /** Span name, e.g. `transformers.generate`. */
  name: string;
  /** What ran the model: `transformers.js`, `cactus`, a provider name. */
  system: string;
  model: string;
  /** `gen_ai.operation.name`; `chat` unless said otherwise. */
  operation?: string;
  /** Cost call type: `chat` (default), `embedding`, `image`, `audio`. */
  callType?: string;
  /** Any further span attributes. */
  attributes?: Record<string, unknown>;
}

/**
 * What the traced function may return for the span to carry usage: token counts
 * under the OpenAI names, and a finish reason. Anything else is passed through
 * untouched and the span simply has no usage - absent, not zero.
 */
export interface GenAiResult {
  usage?: UsageDict | null;
  finish_reason?: string | null;
}

function field(result: unknown, name: string): unknown {
  return typeof result === 'object' && result !== null ? (result as Record<string, unknown>)[name] : undefined;
}

class ManualInstrumentor extends BaseInstrumentor {
  instrument(config: OTelConfig): void {
    this.setupConfig(config);
    this.instrumented = true;
  }

  uninstrument(): void {
    this.instrumented = false;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    const usage = field(result, 'usage');
    return typeof usage === 'object' && usage !== null && !Array.isArray(usage) ? (usage as UsageDict) : null;
  }

  protected override extractFinishReason(result: unknown): string | null | undefined {
    const reason = field(result, 'finish_reason');
    return typeof reason === 'string' ? reason : undefined;
  }

  trace<T>(call: GenAiCall, fn: () => T): T {
    const wrap = this.createSpanWrapper(call.name, () => ({
      [ATTR.GEN_AI_SYSTEM]: call.system,
      [ATTR.GEN_AI_REQUEST_MODEL]: call.model,
      [ATTR.GEN_AI_OPERATION_NAME]: call.operation ?? 'chat',
      ...(call.callType && call.callType !== 'chat' ? { [ATTR.GEN_AI_REQUEST_TYPE]: call.callType } : {}),
      ...call.attributes,
    }));
    const traced = wrap((_params: { model: string }) => fn());
    return traced({ model: call.model });
  }
}

const SLOT = 'web.manual';

export function manualInstrumentor(): ManualInstrumentor {
  return stateSlot(SLOT, () => new ManualInstrumentor());
}

/**
 * Run `fn` inside a GenAI span. Returns exactly what `fn` returns - the same
 * promise if it returns one - and rethrows what it throws, after ending the
 * span with error status. Before `instrument()` it just calls `fn`.
 */
export function traceGenAiCall<T>(call: GenAiCall, fn: () => T): T {
  return manualInstrumentor().trace(call, fn);
}
