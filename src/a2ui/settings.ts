/**
 * The settings the A2A and A2UI code reads: whether A2UI is on (`GENAI_A2UI_ENABLED`), whether trace
 * context travels between agents (`GENAI_A2A_PROPAGATE`), and the content-capture rule. The
 * instrumentors take them from the configuration they are started with; the public API
 * (`recordA2uiReceived` and friends) has no instrumentor, so `instrument()` hands it the same
 * configuration here. Before anyone does, A2UI is on, nothing propagates beyond the default, and no
 * content is captured.
 */
import type { AttributeValue, Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { pyTruncate } from '../pycompat';
import { stateSlot } from '../state';

export interface A2uiSettings {
  a2uiEnabled: boolean;
  a2aPropagate: boolean;
  enableContentCapture: boolean;
  contentMaxLength: number;
}

const DEFAULTS: A2uiSettings = { a2uiEnabled: true, a2aPropagate: true, enableContentCapture: false, contentMaxLength: 200 };

const slot = (): { current: A2uiSettings } => stateSlot('a2ui.settings', () => ({ current: { ...DEFAULTS } }));

/** Called by `instrument()` on every entry. */
export function configureA2ui(config: Pick<OTelConfig, 'a2uiEnabled' | 'a2aPropagate' | 'enableContentCapture' | 'contentMaxLength'> | undefined): void {
  slot().current = config
    ? {
        a2uiEnabled: config.a2uiEnabled,
        a2aPropagate: config.a2aPropagate,
        enableContentCapture: config.enableContentCapture,
        contentMaxLength: config.contentMaxLength,
      }
    : { ...DEFAULTS };
}

export function a2uiSettings(): A2uiSettings {
  return slot().current;
}

/** Settings of an instrumentor's own configuration, else the shared ones. */
export function settingsOf(config: Partial<OTelConfig> | undefined): A2uiSettings {
  const shared = a2uiSettings();
  return {
    a2uiEnabled: config?.a2uiEnabled ?? shared.a2uiEnabled,
    a2aPropagate: config?.a2aPropagate ?? shared.a2aPropagate,
    enableContentCapture: config?.enableContentCapture ?? shared.enableContentCapture,
    contentMaxLength: config?.contentMaxLength ?? shared.contentMaxLength,
  };
}

/**
 * A writer for content attributes: nothing without capture, strings cut to the content limit
 * (0 or less is no limit), lists of strings cut item by item. Never throws.
 */
export function contentWriter(settings: () => A2uiSettings): (span: Span, key: string, value: AttributeValue) => void {
  return (span, key, value) => {
    const { enableContentCapture, contentMaxLength } = settings();
    if (!enableContentCapture) return;
    const limit = Number.isInteger(contentMaxLength) && contentMaxLength > 0 ? contentMaxLength : 0;
    const cut = (item: unknown): string => {
      const textValue = String(item);
      return limit ? pyTruncate(textValue, limit) : textValue;
    };
    try {
      span.setAttribute(key, Array.isArray(value) ? value.map(cut) : cut(value));
    } catch (error) {
      logger.debug(`Could not set content attribute ${key}: ${String(error)}`);
    }
  };
}

