/**
 * The BERT WordPiece port against Hugging Face's BertTokenizer
 * (tests/fixtures/wordpiece-vectors.json, made by make_tokenizer_vectors.py):
 * lower-casing and accent stripping, punctuation, sub-words, unknown and
 * over-long words, CJK characters, control characters, truncation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BertWordPiece } from '../src/wordpiece';

interface Vectors {
  vocab: string[];
  cases: { text: string; lower: boolean; max_length: number; ids: number[]; tokens: string[] }[];
}

const vectors = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/wordpiece-vectors.json'), 'utf8')) as Vectors;

describe('BertWordPiece: Hugging Face BertTokenizer vectors', () => {
  for (const vector of vectors.cases) {
    it(`${JSON.stringify(vector.text).slice(0, 60)} (lower=${vector.lower}, max=${vector.max_length})`, () => {
      const tokenizer = BertWordPiece.fromVocabulary(vectors.vocab, vector.lower);
      expect(tokenizer.encode(vector.text, vector.max_length)).toEqual(vector.ids);
    });
  }
});
