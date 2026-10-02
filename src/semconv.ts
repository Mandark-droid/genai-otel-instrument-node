/**
 * Semantic-convention names and the `OTEL_SEMCONV_STABILITY_OPT_IN` policy.
 *
 * The names themselves live in `semconv.generated.ts`, generated from the
 * vendored contract. This file ports the two decisions of
 * `genai_otel/semconv.py`.
 */
export * from './semconv.generated';

const GENAI_CURRENT_ONLY = 'gen_ai';
const GENAI_DUP = 'gen_ai/dup';

export interface SemconvModes {
  /** Emit the current attribute names. Always true today. */
  readonly emitCurrent: boolean;
  /** Also emit the superseded names alongside them. */
  readonly emitSuperseded: boolean;
}

/**
 * The variable is a COMMA-SEPARATED list shared by every instrumentation area
 * ("http/dup", "database/dup", "gen_ai/dup" can all appear together), so it is
 * split into tokens. A substring test would read another area's opt-in as ours:
 * "dup" is inside "http/dup".
 */
function tokens(optIn: string | null | undefined): Set<string> {
  return new Set(
    (optIn ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token !== ''),
  );
}

/**
 * Which attribute spellings to emit for a raw opt-in value.
 *
 * - `gen_ai/dup` -> current and superseded.
 * - `gen_ai`     -> current only; the caller asked to drop the superseded names.
 * - anything else, including unset -> **both**.
 *
 * The last line departs from upstream's "unset means old only" on purpose, as
 * the Python library does: emitting only the current names by default is how a
 * consumer still reading the superseded ones gets a token count of zero that
 * looks measured.
 */
export function genaiSemconvModes(optIn: string | null | undefined): SemconvModes {
  const set = tokens(optIn);
  if (set.has(GENAI_DUP)) return { emitCurrent: true, emitSuperseded: true };
  if (set.has(GENAI_CURRENT_ONLY)) return { emitCurrent: true, emitSuperseded: false };
  return { emitCurrent: true, emitSuperseded: true };
}

/**
 * True when the caller opted into the GenAI semconv tier at all.
 *
 * Not the same question as `genaiSemconvModes`: this gates the much heavier
 * `gen_ai.input.messages` / `gen_ai.output.messages` payload, which carries
 * message content. For naming, an empty value falls back to the safe default;
 * here an empty value means "do not emit that payload" and must be honoured.
 */
export function genaiTierOptedIn(optIn: string | null | undefined): boolean {
  const set = tokens(optIn);
  return set.has(GENAI_CURRENT_ONLY) || set.has(GENAI_DUP);
}
