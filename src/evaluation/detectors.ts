/**
 * The evaluation detectors: PII, bias, prompt injection, restricted topics,
 * hallucination and toxicity. Ports of `genai_otel/evaluation/*_detector.py`.
 *
 * Patterns, keyword lists, scores and configuration defaults come from the
 * vendored contract (`rules.generated.ts`). What is written here is the order
 * of operations, checked result for result against `contract/eval_vectors.json`.
 *
 * These are the reference's rule-based paths. Where the reference would use a
 * model when one is installed (Presidio, Detoxify), a `Judge` supplied by the
 * application takes that place - see `judge.ts`.
 */
import { logger } from '../logger';
import { findIter, pyEscape, pySplit, pyStrip, search, sliceCodePoints } from './pyre';
import { EVAL_RULES_DATA } from './rules.generated';

interface PatternEntry {
  regex: string;
  flags: string;
}
interface PatternGroup {
  keywords: readonly string[];
  patterns: readonly PatternEntry[];
}
interface Scoring {
  base_score: number;
  per_unique_match: number;
  match_score_cap: number;
  total_score_cap: number;
}

const RULES = EVAL_RULES_DATA;
const ignoreCase = (entry: PatternEntry): boolean => entry.flags === 'IGNORECASE';

/** `0.0` when nothing matched, else base + capped count of distinct matched strings, capped. */
function scoreOf(matched: readonly string[], scoring: Scoring): number {
  if (matched.length === 0) return 0.0;
  const distinct = new Set(matched).size;
  return Math.min(scoring.base_score + Math.min(distinct * scoring.per_unique_match, scoring.match_score_cap), scoring.total_score_cap);
}

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

const maxOf = (values: number[]): number => values.reduce((max, value) => (value > max ? value : max), 0.0);

// ---------------------------------------------------------------- PII -------

export type PIIMode = 'detect' | 'redact' | 'block';

export interface PIIConfig {
  enabled: boolean;
  mode: PIIMode;
  entityTypes: string[];
  redactionChar: string;
  /** Not applied by the pattern path; kept for a judge. */
  threshold: number;
  gdprMode: boolean;
  hipaaMode: boolean;
  pciDssMode: boolean;
  /** Entity name -> a pattern, or `{ regex, score }`. Python `re` syntax. */
  customPatterns: Record<string, string | { regex: string; score?: number }> | null;
  /** Not applied by the pattern path; kept for a judge. */
  allowList: string[] | null;
  airGapped: boolean;
  /** Upper bound for redacted text, in characters; 0 is unlimited. */
  contentMaxLength: number;
}

export interface PIIEntity {
  type: string;
  /** Offsets in Unicode code points, end exclusive. */
  start: number;
  end: number;
  score: number;
  text: string;
}

export interface PIIDetectionResult {
  hasPii: boolean;
  entities: PIIEntity[];
  entityCounts: Record<string, number>;
  redactedText: string | null;
  /** Null when PII was found and the mode is not `detect`. */
  originalText: string | null;
  score: number;
  blocked: boolean;
}

function piiDefaults(): PIIConfig {
  const d = RULES.pii.config_defaults;
  return {
    enabled: d.enabled,
    mode: d.mode as PIIMode,
    entityTypes: [...d.entity_types],
    redactionChar: d.redaction_char,
    threshold: d.threshold,
    gdprMode: d.gdpr_mode,
    hipaaMode: d.hipaa_mode,
    pciDssMode: d.pci_dss_mode,
    customPatterns: d.custom_patterns,
    allowList: d.allow_list,
    airGapped: d.air_gapped,
    contentMaxLength: d.content_max_length,
  };
}

export class PIIDetector {
  readonly config: PIIConfig;

  constructor(config: Partial<PIIConfig> = {}) {
    const merged = { ...piiDefaults(), ...config };
    if (!(merged.threshold >= 0.0 && merged.threshold <= 1.0)) throw new RangeError('threshold must be between 0.0 and 1.0');
    const types = new Set(merged.entityTypes);
    // The compliance modes add entity types; none of the added ones has a pattern here.
    if (merged.gdprMode) for (const type of ['IBAN_CODE', 'UK_NHS', 'NRP']) types.add(type);
    if (merged.hipaaMode) for (const type of ['MEDICAL_LICENSE', 'US_PASSPORT', 'DATE_TIME']) types.add(type);
    if (merged.pciDssMode) for (const type of ['CREDIT_CARD', 'US_BANK_NUMBER']) types.add(type);
    merged.entityTypes = [...types];
    this.config = merged;
  }

  /** Whether a model backs the detector. The pattern path does not count: this is the reference's meaning. */
  isAvailable(): boolean {
    return false;
  }

  detect(text: string): PIIDetectionResult {
    if (!this.config.enabled) return { hasPii: false, entities: [], entityCounts: {}, redactedText: null, originalText: text, score: 0.0, blocked: false };

    const entities: PIIEntity[] = [];
    const entityCounts: Record<string, number> = {};
    const add = (type: string, pattern: string, score: number): void => {
      for (const match of findIter(pattern, text)) {
        entities.push({ type, start: match.start, end: match.end, score, text: match.text });
        entityCounts[type] = (entityCounts[type] ?? 0) + 1;
      }
    };
    for (const entry of RULES.pii.fallback_patterns) {
      if (this.config.entityTypes.includes(entry.entity_type)) add(entry.entity_type, entry.regex, entry.score);
    }
    for (const [name, spec] of Object.entries(this.config.customPatterns ?? {})) {
      const custom = typeof spec === 'string' ? { regex: spec } : spec;
      add(name, custom.regex, custom.score ?? RULES.pii.custom_pattern_default_score);
    }

    const hasPii = entities.length > 0;
    const { mode } = this.config;
    let redactedText: string | null = null;
    if (mode === 'redact' && hasPii) {
      let points = Array.from(text);
      // By start, descending; equal starts keep their order, as Python's stable sort does.
      const ordered = entities.map((entity, index) => ({ entity, index })).sort((a, b) => b.entity.start - a.entity.start || a.index - b.index);
      for (const { entity } of ordered) {
        const replacement = Array.from(this.config.redactionChar.repeat(entity.end - entity.start));
        points = [...points.slice(0, entity.start), ...replacement, ...points.slice(entity.end)];
      }
      redactedText = points.join('');
      if (this.config.contentMaxLength > 0) redactedText = sliceCodePoints(redactedText, 0, this.config.contentMaxLength);
    }
    return {
      hasPii,
      entities,
      entityCounts,
      redactedText,
      originalText: hasPii && mode !== 'detect' ? null : text,
      score: maxOf(entities.map((entity) => entity.score)),
      blocked: mode === 'block' && hasPii,
    };
  }
}

// ----------------------------------------------------------- Toxicity -------

export interface ToxicityConfig {
  enabled: boolean;
  threshold: number;
  usePerspectiveApi: boolean;
  perspectiveApiKey: string | null;
  useLocalModel: boolean;
  categories: string[];
  blockOnDetection: boolean;
  airGapped: boolean;
  allowExternalEgress: boolean;
  apiTimeout: number;
}

export interface ToxicityDetectionResult {
  isToxic: boolean;
  scores: Record<string, number>;
  maxScore: number;
  toxicCategories: string[];
  originalText: string | null;
  blocked: boolean;
}

/** Scores per category, 0 to 1, from whatever the application uses to measure toxicity. */
export type ToxicityScores = Record<string, number | undefined>;
/**
 * May answer at once or with a promise (a local model, an on-prem endpoint).
 * A promise can only be waited for on an instrumented call; see `EvaluationEngine.prepare`.
 */
export type ToxicityScorer = (text: string, categories: readonly string[]) => ToxicityScores | PromiseLike<ToxicityScores>;

function toxicityDefaults(): ToxicityConfig {
  const d = RULES.toxicity.config_defaults;
  return {
    enabled: d.enabled,
    threshold: d.threshold,
    usePerspectiveApi: d.use_perspective_api,
    perspectiveApiKey: d.perspective_api_key,
    useLocalModel: d.use_local_model,
    categories: [...d.categories],
    blockOnDetection: d.block_on_detection,
    airGapped: d.air_gapped,
    allowExternalEgress: d.allow_external_egress,
    apiTimeout: d.api_timeout,
  };
}

/**
 * Toxicity has no rules: the reference measures it with a model (Detoxify) or
 * a service (Perspective) and, with neither, answers "not toxic" to everything.
 * Here the measurement is a scorer the application supplies. Without one the
 * detector is not available, and nothing downstream may read its answer as a
 * measurement.
 */
export class ToxicityDetector {
  readonly config: ToxicityConfig;
  private readonly scorer: ToxicityScorer | undefined;

  constructor(config: Partial<ToxicityConfig> = {}, scorer?: ToxicityScorer) {
    this.config = { ...toxicityDefaults(), ...config };
    if (!(this.config.threshold >= 0.0 && this.config.threshold <= 1.0)) throw new RangeError('threshold must be between 0.0 and 1.0');
    this.scorer = scorer;
  }

  isAvailable(): boolean {
    return this.scorer !== undefined;
  }

  /** The reference's `detect`: "not toxic" when nothing measured it. Prefer `measure`, which says so. */
  detect(text: string): ToxicityDetectionResult {
    return this.measure(text) ?? { isToxic: false, scores: {}, maxScore: 0.0, toxicCategories: [], originalText: text, blocked: false };
  }

  /** The measured result, or `undefined` when there is no measurement: disabled, no scorer, or the scorer failed. */
  measure(text: string): ToxicityDetectionResult | undefined {
    const outcome = this.score(text);
    if (isPromiseLike(outcome)) {
      // Nobody can wait here. The answer is dropped, and so is its failure.
      void Promise.resolve(outcome).catch(() => undefined);
      return undefined;
    }
    return outcome;
  }

  /** As `measure`, waiting for a scorer that answers with a promise. Never rejects. */
  async measureAsync(text: string): Promise<ToxicityDetectionResult | undefined> {
    try {
      return await this.score(text);
    } catch (error) {
      logger.error(`Error detecting toxicity: ${String(error)}`);
      return undefined;
    }
  }

  /** The result at once, or a promise of it when the scorer answers with one. */
  score(text: string): ToxicityDetectionResult | undefined | Promise<ToxicityDetectionResult | undefined> {
    if (!this.config.enabled || !this.scorer) return undefined;
    try {
      const measured = this.scorer(text, this.config.categories);
      if (isPromiseLike(measured)) {
        return Promise.resolve(measured).then(
          (scores) => this.resultOf(text, scores),
          (error: unknown) => {
            logger.error(`Error detecting toxicity: ${String(error)}`);
            return undefined;
          },
        );
      }
      return this.resultOf(text, measured);
    } catch (error) {
      logger.error(`Error detecting toxicity: ${String(error)}`);
      return undefined;
    }
  }

  private resultOf(text: string, measured: ToxicityScores): ToxicityDetectionResult | undefined {
    try {
      const scores: Record<string, number> = {};
      for (const category of this.config.categories) {
        const value = measured[category];
        if (typeof value === 'number' && Number.isFinite(value)) scores[category] = value;
      }
      const toxicCategories = Object.keys(scores).filter((category) => (scores[category] as number) >= this.config.threshold);
      const isToxic = toxicCategories.length > 0;
      return { isToxic, scores, maxScore: maxOf(Object.values(scores)), toxicCategories, originalText: text, blocked: this.config.blockOnDetection && isToxic };
    } catch (error) {
      logger.error(`Error detecting toxicity: ${String(error)}`);
      return undefined;
    }
  }
}

// --------------------------------------------------------------- Bias -------

export interface BiasConfig {
  enabled: boolean;
  threshold: number;
  biasTypes: string[];
  useFairlearn: boolean;
  sensitiveAttributes: string[] | null;
  checkPrompts: boolean;
  checkResponses: boolean;
  blockOnDetection: boolean;
}

export interface BiasDetectionResult {
  hasBias: boolean;
  biasScores: Record<string, number>;
  maxScore: number;
  detectedBiases: string[];
  patternsMatched: Record<string, string[]>;
  originalText: string | null;
}

function biasDefaults(): BiasConfig {
  const d = RULES.bias.config_defaults;
  return {
    enabled: d.enabled,
    threshold: d.threshold,
    biasTypes: [...d.bias_types],
    useFairlearn: d.use_fairlearn,
    sensitiveAttributes: d.sensitive_attributes,
    checkPrompts: d.check_prompts,
    checkResponses: d.check_responses,
    blockOnDetection: d.block_on_detection,
  };
}

export class BiasDetector {
  readonly config: BiasConfig;

  constructor(config: Partial<BiasConfig> = {}) {
    this.config = { ...biasDefaults(), ...config };
    if (!(this.config.threshold >= 0.0 && this.config.threshold <= 1.0)) throw new RangeError('threshold must be between 0.0 and 1.0');
  }

  isAvailable(): boolean {
    return true;
  }

  detect(text: string): BiasDetectionResult {
    if (!this.config.enabled) return { hasBias: false, biasScores: {}, maxScore: 0.0, detectedBiases: [], patternsMatched: {}, originalText: text };
    try {
      const biasScores: Record<string, number> = {};
      const patternsMatched: Record<string, string[]> = {};
      const groups = RULES.bias.patterns as Record<string, PatternGroup>;
      for (const type of this.config.biasTypes) {
        const group = groups[type];
        if (!group) continue;
        const matched = this.check(text, group);
        biasScores[type] = scoreOf(matched, RULES.bias.scoring);
        if (matched.length > 0) patternsMatched[type] = matched;
      }
      const detectedBiases = Object.keys(biasScores).filter((type) => (biasScores[type] as number) >= this.config.threshold);
      return { hasBias: detectedBiases.length > 0, biasScores, maxScore: maxOf(Object.values(biasScores)), detectedBiases, patternsMatched, originalText: text };
    } catch (error) {
      logger.error(`Error detecting bias: ${String(error)}`);
      return { hasBias: false, biasScores: {}, maxScore: 0.0, detectedBiases: [], patternsMatched: {}, originalText: text };
    }
  }

  private check(text: string, group: PatternGroup): string[] {
    const matched: string[] = [];
    // Leetspeak undone, then punctuation turned into spaces: tried in that order.
    let deobfuscated = text;
    for (const [char, replacement] of Object.entries(RULES.bias.deobfuscation_substitutions)) deobfuscated = deobfuscated.split(char).join(replacement);
    const normalised = findIterReplace(RULES.bias.normalisation_regex, deobfuscated, ' ');
    for (const pattern of group.patterns) {
      let matches = findIter(pattern.regex, text, ignoreCase(pattern));
      if (matches.length === 0) matches = findIter(pattern.regex, deobfuscated, ignoreCase(pattern));
      if (matches.length === 0) matches = findIter(pattern.regex, normalised, ignoreCase(pattern));
      for (const match of matches) matched.push(match.text);
    }
    const lower = text.toLowerCase();
    for (const keyword of group.keywords) {
      if (search(`\\b${pyEscape(keyword)}\\b`, lower)) matched.push(keyword);
    }
    return matched;
  }
}

/** `re.sub(pattern, replacement, text)` for a literal replacement. */
function findIterReplace(pattern: string, text: string, replacement: string): string {
  const points = Array.from(text);
  let out = '';
  let at = 0;
  for (const match of findIter(pattern, text)) {
    out += points.slice(at, match.start).join('') + replacement;
    at = match.end;
  }
  return out + points.slice(at).join('');
}

// --------------------------------------------------- Prompt injection -------

export interface PromptInjectionConfig {
  enabled: boolean;
  threshold: number;
  /** Ignored, as in the reference. */
  useMlModel: boolean;
  /** Ignored, as in the reference. */
  checkPatterns: boolean;
  /** Ignored, as in the reference. */
  patterns: string[] | null;
  blockOnDetection: boolean;
  /** Ignored, as in the reference. */
  logAttempts: boolean;
}

export interface PromptInjectionResult {
  isInjection: boolean;
  injectionScore: number;
  injectionTypes: string[];
  patternsMatched: Record<string, string[]>;
  originalText: string | null;
  blocked: boolean;
}

function promptInjectionDefaults(): PromptInjectionConfig {
  const d = RULES.prompt_injection.config_defaults;
  return {
    enabled: d.enabled,
    threshold: d.threshold,
    useMlModel: d.use_ml_model,
    checkPatterns: d.check_patterns,
    patterns: d.patterns,
    blockOnDetection: d.block_on_detection,
    logAttempts: d.log_attempts,
  };
}

export class PromptInjectionDetector {
  readonly config: PromptInjectionConfig;

  constructor(config: Partial<PromptInjectionConfig> = {}) {
    this.config = { ...promptInjectionDefaults(), ...config };
    if (!(this.config.threshold >= 0.0 && this.config.threshold <= 1.0)) throw new RangeError('threshold must be between 0.0 and 1.0');
  }

  isAvailable(): boolean {
    return true;
  }

  detect(text: string): PromptInjectionResult {
    const none: PromptInjectionResult = { isInjection: false, injectionScore: 0.0, injectionTypes: [], patternsMatched: {}, originalText: text, blocked: false };
    if (!this.config.enabled) return none;
    try {
      const scores: Record<string, number> = {};
      const patternsMatched: Record<string, string[]> = {};
      const groups = RULES.prompt_injection.patterns as Record<string, PatternGroup>;
      for (const type of RULES.prompt_injection.type_order) {
        const matched: string[] = [];
        for (const pattern of groups[type]?.patterns ?? []) {
          for (const match of findIter(pattern.regex, text, ignoreCase(pattern))) matched.push(match.text);
        }
        scores[type] = scoreOf(matched, RULES.prompt_injection.scoring);
        if (matched.length > 0) patternsMatched[type] = matched;
      }
      const injectionTypes = Object.keys(scores).filter((type) => (scores[type] as number) >= this.config.threshold);
      const isInjection = injectionTypes.length > 0;
      return {
        isInjection,
        injectionScore: maxOf(Object.values(scores)),
        injectionTypes,
        patternsMatched,
        originalText: text,
        blocked: this.config.blockOnDetection && isInjection,
      };
    } catch (error) {
      logger.error(`Error detecting prompt injection: ${String(error)}`);
      return none;
    }
  }
}

// -------------------------------------------------- Restricted topics -------

export interface RestrictedTopicsConfig {
  enabled: boolean;
  threshold: number;
  /** Null or empty: every topic. An unknown name is skipped. */
  restrictedTopics: string[] | null;
  blockOnDetection: boolean;
}

export interface RestrictedTopicsResult {
  hasRestrictedTopic: boolean;
  detectedTopics: string[];
  topicScores: Record<string, number>;
  maxScore: number;
  patternsMatched: Record<string, string[]>;
  originalText: string | null;
  blocked: boolean;
}

function restrictedTopicsDefaults(): RestrictedTopicsConfig {
  const d = RULES.restricted_topics.config_defaults;
  return { enabled: d.enabled, threshold: d.threshold, restrictedTopics: d.restricted_topics, blockOnDetection: d.block_on_detection };
}

export class RestrictedTopicsDetector {
  readonly config: RestrictedTopicsConfig;

  constructor(config: Partial<RestrictedTopicsConfig> = {}) {
    this.config = { ...restrictedTopicsDefaults(), ...config };
    if (!(this.config.threshold >= 0.0 && this.config.threshold <= 1.0)) throw new RangeError('threshold must be between 0.0 and 1.0');
  }

  isAvailable(): boolean {
    return true;
  }

  detect(text: string): RestrictedTopicsResult {
    const none: RestrictedTopicsResult = {
      hasRestrictedTopic: false,
      detectedTopics: [],
      topicScores: {},
      maxScore: 0.0,
      patternsMatched: {},
      originalText: text,
      blocked: false,
    };
    if (!this.config.enabled) return none;
    try {
      const topicScores: Record<string, number> = {};
      const patternsMatched: Record<string, string[]> = {};
      const groups = RULES.restricted_topics.patterns as Record<string, PatternGroup>;
      const configured = this.config.restrictedTopics;
      const topics = configured && configured.length > 0 ? configured : RULES.restricted_topics.topic_order;
      const lower = text.toLowerCase();
      for (const topic of topics) {
        const group = groups[topic];
        if (!group) {
          logger.warn(`Unknown topic: ${topic}`);
          continue;
        }
        const matched: string[] = [];
        for (const pattern of group.patterns) for (const match of findIter(pattern.regex, text, ignoreCase(pattern))) matched.push(match.text);
        // Keywords match as substrings: `harm` is found in "pharmacy". That is the reference.
        for (const keyword of group.keywords) if (lower.includes(keyword)) matched.push(keyword);
        topicScores[topic] = scoreOf(matched, RULES.restricted_topics.scoring);
        if (matched.length > 0) patternsMatched[topic] = matched;
      }
      const detectedTopics = Object.keys(topicScores).filter((topic) => (topicScores[topic] as number) >= this.config.threshold);
      const hasRestrictedTopic = detectedTopics.length > 0;
      return {
        hasRestrictedTopic,
        detectedTopics,
        topicScores,
        maxScore: maxOf(Object.values(topicScores)),
        patternsMatched,
        originalText: text,
        blocked: this.config.blockOnDetection && hasRestrictedTopic,
      };
    } catch (error) {
      logger.error(`Error detecting restricted topics: ${String(error)}`);
      return none;
    }
  }
}

// ------------------------------------------------------ Hallucination -------

export interface HallucinationConfig {
  enabled: boolean;
  threshold: number;
  checkCitations: boolean;
  checkHedging: boolean;
}

export interface HallucinationResult {
  hasHallucination: boolean;
  hallucinationScore: number;
  hallucinationIndicators: string[];
  factualClaimCount: number;
  unsupportedClaims: string[];
  hedgeWordsCount: number;
  citationCount: number;
  originalText: string | null;
  contextText: string | null;
}

function hallucinationDefaults(): HallucinationConfig {
  const d = RULES.hallucination.config_defaults;
  return { enabled: d.enabled, threshold: d.threshold, checkCitations: d.check_citations, checkHedging: d.check_hedging };
}

const HALLUCINATION = RULES.hallucination;
const INLINE = HALLUCINATION.inline_rule_data;
const groupsOf = (table: Record<string, readonly PatternEntry[]>): PatternEntry[] => Object.values(table).flat();

/**
 * The bare number pattern of `_check_internal_contradiction`. In the reference
 * it is a second literal; it is the second capture group of the subject-value
 * pattern, and is taken from there rather than typed again.
 */
const NUMBER_ONLY = ((): string => {
  const pattern = INLINE._check_internal_contradiction.number_pattern;
  const start = pattern.lastIndexOf('(\\d+');
  if (start < 0 || !pattern.endsWith(')')) throw new Error('eval rules: the number pattern has changed shape');
  return pattern.slice(start + 1, -1);
})();

export class HallucinationDetector {
  readonly config: HallucinationConfig;

  constructor(config: Partial<HallucinationConfig> = {}) {
    this.config = { ...hallucinationDefaults(), ...config };
    if (!(this.config.threshold >= 0.0 && this.config.threshold <= 1.0)) throw new RangeError('threshold must be between 0.0 and 1.0');
  }

  isAvailable(): boolean {
    return true;
  }

  /** `context` is what the text should agree with: on a span, the prompt. */
  detect(text: string, context?: string | null): HallucinationResult {
    const contextText = context ?? null;
    const none: HallucinationResult = {
      hasHallucination: false,
      hallucinationScore: 0.0,
      hallucinationIndicators: [],
      factualClaimCount: 0,
      unsupportedClaims: [],
      hedgeWordsCount: 0,
      citationCount: 0,
      originalText: text,
      contextText,
    };
    if (!this.config.enabled) return none;
    try {
      const indicators: string[] = [];
      const unsupportedClaims: string[] = [];
      const claims = groupsOf(HALLUCINATION.factual_claim_patterns);
      const factualClaimCount = claims.reduce((count, pattern) => count + findIter(pattern.regex, text, true).length, 0);
      const hedgeWordsCount = this.config.checkHedging ? this.countWords(text, HALLUCINATION.hedge_words) : 0;
      const citationCount = this.config.checkCitations
        ? groupsOf(HALLUCINATION.confidence_markers).reduce((count, pattern) => count + findIter(pattern.regex, text, true).length, 0)
        : 0;

      let score = this.score(text, factualClaimCount, hedgeWordsCount, citationCount);
      if (factualClaimCount > 0 && citationCount === 0) {
        indicators.push('specific_claims_without_citations');
        unsupportedClaims.push(...this.extractClaims(text, claims).slice(0, 3));
      }
      if (hedgeWordsCount > 3) indicators.push('high_uncertainty_language');
      if (citationCount === 0 && this.countWords(text, HALLUCINATION.absolute_words, true) > 0) indicators.push('absolute_statements');
      if (this.internalContradiction(text)) {
        indicators.push('context_contradiction');
        score = Math.min(score + 0.3, 1.0);
      }
      if (context && this.contextContradiction(text, context)) {
        if (!indicators.includes('context_contradiction')) indicators.push('context_contradiction');
        score = Math.min(score + 0.3, 1.0);
      }
      return {
        hasHallucination: score >= this.config.threshold,
        hallucinationScore: score,
        hallucinationIndicators: indicators,
        factualClaimCount,
        unsupportedClaims,
        hedgeWordsCount,
        citationCount,
        originalText: text,
        contextText,
      };
    } catch (error) {
      logger.error(`Error detecting hallucinations: ${String(error)}`);
      return none;
    }
  }

  /** Whole-word occurrences in the lower-cased text; `firstOnly` stops at the first word found. */
  private countWords(text: string, words: readonly string[], firstOnly = false): number {
    const lower = text.toLowerCase();
    let count = 0;
    for (const word of words) {
      const pattern = `\\b${pyEscape(word)}\\b`;
      if (firstOnly) {
        if (search(pattern, lower)) return 1;
      } else {
        count += findIter(pattern, lower).length;
      }
    }
    return count;
  }

  /** The sentence around each claim. A sentence ends at the first `.`, `!` or `?` - a decimal point included. */
  private extractClaims(text: string, patterns: readonly PatternEntry[]): string[] {
    const claims: string[] = [];
    for (const pattern of patterns) {
      for (const match of findIter(pattern.regex, text, true)) {
        const sentence = search(`[^.!?]*${pyEscape(match.text)}[^.!?]*[.!?]`, text, true);
        if (sentence) claims.push(pyStrip(sentence.text));
      }
    }
    return claims;
  }

  private score(text: string, factualClaims: number, hedges: number, citations: number): number {
    let score = 0.0;
    if (factualClaims > 0) {
      const ratio = citations / factualClaims;
      if (ratio === 0) score += 0.4;
      else if (ratio < 0.3) score += 0.2;
    }
    const words = pySplit(text).length;
    if (words > 0 && hedges / words > 0.1) score += 0.3;
    for (const pattern of INLINE._calculate_hallucination_score.specific_patterns) {
      if (search(pattern, text, true)) score += 0.1;
    }
    return Math.min(score, 1.0);
  }

  /** One subject given two values; or a "however"/"but" with two different numbers in the text. */
  private internalContradiction(text: string): boolean {
    const sentences = splitSentences(text);
    if (sentences.length < 2) return false;
    const rules = INLINE._check_internal_contradiction;
    const values = new Map<string, string>();
    for (const sentence of sentences) {
      for (const match of findIter(rules.number_pattern, sentence.toLowerCase())) {
        const [subject, value] = match.groups as [string, string];
        const seen = values.get(subject);
        if (seen === undefined) values.set(subject, value);
        else if (seen !== value) return true;
      }
    }
    const lower = text.toLowerCase();
    if (rules.contradiction_markers.some((marker) => search(marker, lower))) {
      const numbers = new Set(findIter(NUMBER_ONLY, text).map((match) => match.text));
      if (numbers.size >= 2) return true;
    }
    return false;
  }

  private contextContradiction(text: string, context: string): boolean {
    const rules = INLINE._check_context_contradiction;
    const contextLower = context.toLowerCase();
    const textLower = text.toLowerCase();
    const numbers = (source: string): Map<string, string> => {
      const found = new Map<string, string>();
      for (const match of findIter(rules.number_pattern, source)) found.set(match.groups[0] as string, pyStrip(match.groups[1] as string));
      return found;
    };
    const inContext = numbers(contextLower);
    const inText = numbers(textLower);
    for (const [subject, value] of inContext) {
      const other = inText.get(subject);
      if (other !== undefined && other !== value) return true;
    }
    const negated = (source: string): boolean => rules.negation_patterns.some((pattern) => search(pattern, source) !== undefined);
    if (negated(contextLower) !== negated(textLower)) {
      const words = (source: string): Set<string> => new Set(findIter('\\b[a-z]{4,}\\b', source).map((match) => match.text));
      const contextWords = words(contextLower);
      let common = 0;
      for (const word of words(textLower)) if (contextWords.has(word)) common += 1;
      if (common > 2) return true;
    }
    return false;
  }
}

/** `re.split(r"[.!?]+", text)`: empty strings at the ends included. */
function splitSentences(text: string): string[] {
  return text.split(/[.!?]+/u);
}
