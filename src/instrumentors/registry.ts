/**
 * The instrumentors this SDK ships, by the name used in `GENAI_ENABLED_INSTRUMENTORS`.
 *
 * Names follow the Python library so one configuration works for both. A name
 * the Python library knows but this SDK has not ported is in
 * `REFERENCE_ONLY_INSTRUMENTORS`: asking for it is reported as "not available
 * here", which is a different statement from "unknown name".
 */
import type { OTelConfig } from '../config';
import { DEFAULT_INSTRUMENTORS, OPT_IN_INSTRUMENTORS } from '../config';

export interface Instrumentor {
  /** Patch the target library. Must never throw into the host unless `config.failOnError`. */
  instrument(config: OTelConfig): void | Promise<void>;
  /** Remove the patches. */
  uninstrument(): void;
}

export type InstrumentorFactory = () => Instrumentor;

const REGISTRY = new Map<string, InstrumentorFactory>();

export function registerInstrumentor(name: string, factory: InstrumentorFactory): void {
  REGISTRY.set(name, factory);
}

export function instrumentorFactory(name: string): InstrumentorFactory | undefined {
  return REGISTRY.get(name);
}

export function availableInstrumentors(): string[] {
  return [...REGISTRY.keys()];
}

/** Every name the reference implementation's `INSTRUMENTORS` table resolves. */
const REFERENCE_NAMES = new Set<string>([
  ...DEFAULT_INSTRUMENTORS,
  ...OPT_IN_INSTRUMENTORS,
  'agents',
  'dspy',
  'guardrails',
  'haystack',
  'instructor',
  'hyperbolic',
  'mcp',
  'mcp_client',
]);

/** True for a name the Python library resolves and this SDK does not (yet). */
export function isReferenceOnlyInstrumentor(name: string): boolean {
  return REFERENCE_NAMES.has(name) && !REGISTRY.has(name);
}
