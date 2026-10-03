/**
 * An on-prem HTTP toxicity judge: `GENAI_TOXICITY_JUDGE_URL`
 * (contract/SDK_ADDITIONS.md section 12), the same protocol in every SDK.
 *
 * It is posted `{"text": "...", "categories": ["toxicity", ...]}` and answers
 * `{"scores": {"toxicity": 0.91, ...}}`, or the scores as a flat object as a
 * Detoxify server does (Detoxify's `obscene` is read as `profanity`).
 *
 * The endpoint is the operator's: text goes nowhere it was not told to, so it
 * stays allowed when air-gapped (which forbids downloading models and assets at
 * run time). The call is this SDK's own and is never traced. A judge that fails
 * or answers with no score measured nothing: the scorer throws, and no toxicity
 * attribute is written - never a 0.
 */
import { logger } from '../logger';
import { ownFetch } from '../own-fetch';
import type { ToxicityScorer, ToxicityScores } from './detectors';
import { EVAL_RULES_DATA } from './rules.generated';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Detoxify output name -> category (`obscene` -> `profanity`). */
const CATEGORY_BY_OUTPUT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EVAL_RULES_DATA.toxicity.detoxify_output_by_category as Record<string, string>).map(([category, output]) => [output, category]),
);

/** A scorer posting to `url`, or undefined (logged) when the URL is not http(s). */
export function httpToxicityJudge(url: string, timeoutSeconds: number): ToxicityScorer | undefined {
  const endpoint = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(endpoint)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    logger.warn(`GENAI_TOXICITY_JUDGE_URL: refusing non-http(s) URL '${endpoint}'; toxicity is not measured`);
    return undefined;
  }
  const timeoutMs = Math.max(1, timeoutSeconds * 1000);
  return async (text, categories): Promise<ToxicityScores> => {
    const response = await ownFetch(
      endpoint,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, categories }) },
      timeoutMs,
    );
    if (!response.ok) throw new Error(`toxicity judge answered HTTP ${response.status}`);
    const root: unknown = await response.json();
    const source = isObject(root) && isObject(root.scores) ? root.scores : root;
    const scores: ToxicityScores = {};
    if (isObject(source)) {
      for (const [name, value] of Object.entries(source)) {
        if (typeof value === 'number' && Number.isFinite(value)) scores[CATEGORY_BY_OUTPUT[name] ?? name] = value;
      }
    }
    if (Object.keys(scores).length === 0) throw new Error('toxicity judge answered with no score');
    return scores;
  };
}
