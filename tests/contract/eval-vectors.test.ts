/**
 * Every detector vector of contract/eval_vectors.json: the configuration and
 * text the reference was run with, and the full result it returned.
 *
 * The rules file's prose is not what verifies a detector; these are.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BiasDetector,
  HallucinationDetector,
  PIIDetector,
  PromptInjectionDetector,
  RestrictedTopicsDetector,
  ToxicityDetector,
} from '../../src/evaluation';

interface Vector {
  id: string;
  detector: 'pii' | 'toxicity' | 'bias' | 'prompt_injection' | 'restricted_topics' | 'hallucination';
  detector_available: boolean;
  config: Record<string, unknown>;
  text: string;
  context?: string | null;
  detected: boolean;
  categories: string[];
  score: number | null;
  result: Record<string, unknown>;
}

const file = JSON.parse(readFileSync(resolve(__dirname, '../../contract/eval_vectors.json'), 'utf8')) as { vectors: Vector[] };

/** The reference's field names to this SDK's: `block_on_detection` -> `blockOnDetection`. Top level only. */
function camel(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) out[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  return out;
}

/** Run one vector; return the result in the reference's shape, and whether the detector says it is available. */
function run(vector: Vector): { result: Record<string, unknown>; available: boolean } {
  const config = camel(vector.config);
  switch (vector.detector) {
    case 'pii': {
      const detector = new PIIDetector(config);
      const r = detector.detect(vector.text);
      return {
        available: detector.isAvailable(),
        result: {
          has_pii: r.hasPii,
          entities: r.entities,
          entity_counts: r.entityCounts,
          redacted_text: r.redactedText,
          original_text: r.originalText,
          score: r.score,
          blocked: r.blocked,
          model_analyzed_length: r.modelAnalyzedLength,
        },
      };
    }
    case 'toxicity': {
      const detector = new ToxicityDetector(config);
      const r = detector.detect(vector.text);
      return {
        available: detector.isAvailable(),
        result: {
          is_toxic: r.isToxic,
          scores: r.scores,
          max_score: r.maxScore,
          toxic_categories: r.toxicCategories,
          original_text: r.originalText,
          blocked: r.blocked,
        },
      };
    }
    case 'bias': {
      const detector = new BiasDetector(config);
      const r = detector.detect(vector.text);
      return {
        available: detector.isAvailable(),
        result: {
          has_bias: r.hasBias,
          bias_scores: r.biasScores,
          max_score: r.maxScore,
          // The reference's order here is that of a Python set: compared as a set.
          detected_biases: [...r.detectedBiases].sort(),
          patterns_matched: r.patternsMatched,
          original_text: r.originalText,
        },
      };
    }
    case 'prompt_injection': {
      const detector = new PromptInjectionDetector(config);
      const r = detector.detect(vector.text);
      return {
        available: detector.isAvailable(),
        result: {
          is_injection: r.isInjection,
          injection_score: r.injectionScore,
          injection_types: r.injectionTypes,
          patterns_matched: r.patternsMatched,
          original_text: r.originalText,
          blocked: r.blocked,
        },
      };
    }
    case 'restricted_topics': {
      const detector = new RestrictedTopicsDetector(config);
      const r = detector.detect(vector.text);
      return {
        available: detector.isAvailable(),
        result: {
          has_restricted_topic: r.hasRestrictedTopic,
          detected_topics: r.detectedTopics,
          topic_scores: r.topicScores,
          max_score: r.maxScore,
          patterns_matched: r.patternsMatched,
          original_text: r.originalText,
          blocked: r.blocked,
        },
      };
    }
    case 'hallucination': {
      const detector = new HallucinationDetector(config);
      const r = detector.detect(vector.text, vector.context ?? undefined);
      return {
        available: detector.isAvailable(),
        result: {
          has_hallucination: r.hasHallucination,
          hallucination_score: r.hallucinationScore,
          hallucination_indicators: r.hallucinationIndicators,
          factual_claim_count: r.factualClaimCount,
          unsupported_claims: r.unsupportedClaims,
          hedge_words_count: r.hedgeWordsCount,
          citation_count: r.citationCount,
          original_text: r.originalText,
          context_text: r.contextText,
        },
      };
    }
  }
}

function expected(vector: Vector): Record<string, unknown> {
  if (vector.detector !== 'bias') return vector.result;
  return { ...vector.result, detected_biases: [...(vector.result.detected_biases as string[])].sort() };
}

describe('contract: eval_vectors.json', () => {
  it('has the vectors this suite expects', () => {
    const counts: Record<string, number> = {};
    for (const vector of file.vectors) counts[vector.detector] = (counts[vector.detector] ?? 0) + 1;
    expect(counts).toEqual({ pii: 34, toxicity: 24, bias: 32, prompt_injection: 40, restricted_topics: 32, hallucination: 32 });
  });

  for (const vector of file.vectors) {
    it(`${vector.id}: ${JSON.stringify(vector.text).slice(0, 70)}`, () => {
      const outcome = run(vector);
      // Exact, floats included: 0.6000000000000001 is what the same arithmetic gives here.
      expect(outcome.result).toEqual(expected(vector));
      expect(outcome.available).toBe(vector.detector_available);
    });
  }
});
