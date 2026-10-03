/**
 * The judge, run by the real ONNX Runtime (onnxruntime-node 1.30.0) on the toy
 * model of tests/fixtures/toy-model (make_model.py; the same model as the Go
 * SDK's test). Each token looks up six logits and the model returns the
 * maximum: "idiot" and "hate" score 4.0 on toxic and 2.0 on insult, everything
 * else -3.0. Not a real Detoxify export: that has not been run.
 */
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOnnxToxicityJudge } from '../src';

const TOY = resolve(__dirname, 'fixtures/toy-model');
const ALL = ['identity_attack', 'insult', 'profanity', 'severe_toxicity', 'threat', 'toxicity'];
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A copy of the toy model with some files replaced or removed. */
function variant(files: Record<string, string | undefined>, modelName = 'model.onnx'): string {
  const directory = mkdtempSync(join(tmpdir(), 'onnx-judge-'));
  scratch.push(directory);
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(TOY, 'model.onnx'), join(directory, modelName));
  copyFileSync(join(TOY, 'vocab.txt'), join(directory, 'vocab.txt'));
  copyFileSync(join(TOY, 'config.json'), join(directory, 'config.json'));
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) rmSync(join(directory, name), { force: true });
    else writeFileSync(join(directory, name), content);
  }
  return directory;
}

describe('ONNX toxicity judge', () => {
  it('scores every category with a sigmoid; the Jigsaw output names map to the reference categories', async () => {
    const judge = await createOnnxToxicityJudge(TOY);
    const toxic = await judge('You are a worthless idiot.', ALL);
    expect(Object.keys(toxic).sort()).toEqual(ALL);
    expect(toxic.toxicity).toBeCloseTo(sigmoid(4), 5);
    expect(toxic.insult).toBeCloseTo(sigmoid(2), 5);
    // obscene -> profanity, severe_toxic -> severe_toxicity, identity_hate -> identity_attack
    expect(toxic.profanity).toBeCloseTo(sigmoid(-3), 5);
    expect(toxic.severe_toxicity).toBeCloseTo(sigmoid(-3), 5);
    expect(toxic.identity_attack).toBeCloseTo(sigmoid(-3), 5);
    const polite = await judge('Thank you for the lovely afternoon.', ALL);
    expect(polite.toxicity).toBeCloseTo(sigmoid(-3), 5);
  });

  it('only the categories asked for', async () => {
    const judge = await createOnnxToxicityJudge(TOY);
    expect(Object.keys(await judge('I hate you', ['toxicity', 'threat']))).toEqual(['toxicity', 'threat']);
  });

  it('single_label_classification: a softmax over the outputs', async () => {
    const judge = await createOnnxToxicityJudge(
      variant({ 'config.json': JSON.stringify({ id2label: { 0: 'toxic', 1: 'severe_toxic', 2: 'obscene', 3: 'threat', 4: 'insult', 5: 'identity_hate' }, problem_type: 'single_label_classification' }) }),
    );
    const scores = await judge('idiot', ALL);
    const denominator = Math.exp(4) + Math.exp(2) + 4 * Math.exp(-3);
    expect(scores.toxicity).toBeCloseTo(Math.exp(4) / denominator, 5);
    expect(Object.values(scores).reduce((sum, value) => sum + (value ?? 0), 0)).toBeCloseTo(1, 5);
  });

  it("no config.json: Detoxify's output order is assumed; another .onnx file name is found", async () => {
    const judge = await createOnnxToxicityJudge(variant({ 'config.json': undefined }, 'detoxify-original.onnx'));
    // Detoxify order: toxicity, severe_toxicity, obscene, threat, insult, identity_attack.
    const scores = await judge('idiot', ALL);
    expect(scores.toxicity).toBeCloseTo(sigmoid(4), 5);
    expect(scores.insult).toBeCloseTo(sigmoid(2), 5);
  });

  it('a directory without a model or a vocabulary is refused', async () => {
    await expect(createOnnxToxicityJudge(join(TOY, 'missing'))).rejects.toThrow();
    await expect(createOnnxToxicityJudge(variant({ 'vocab.txt': undefined }))).rejects.toThrow('vocab.txt');
    const empty = mkdtempSync(join(tmpdir(), 'onnx-judge-'));
    scratch.push(empty);
    await expect(createOnnxToxicityJudge(empty)).rejects.toThrow('.onnx');
  });
});
