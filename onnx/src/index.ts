/**
 * A toxicity judge that runs a Detoxify-style classifier with ONNX Runtime,
 * in-process and on-prem: the counterpart of the reference's Detoxify backend
 * (`GENAI_TOXICITY_ONNX_MODEL`; contract/SDK_ADDITIONS.md section 12). An
 * optional add-on: `@traceverse/genai-otel-instrument` never depends on ONNX
 * Runtime, and loads this package only when the variable is set.
 *
 * The model directory holds `model.onnx` (or one other `.onnx` file) and the
 * BERT vocabulary `vocab.txt`. `config.json` may name the outputs (`id2label`)
 * and say whether they are independent (`multi_label_classification`, sigmoid,
 * the default) or one choice (`single_label_classification`, softmax);
 * `tokenizer_config.json` whether text is lower-cased (`do_lower_case`, default
 * true). With no label map Detoxify's output order is assumed: toxicity,
 * severe_toxicity, obscene, threat, insult, identity_attack.
 *
 * Output names map to the reference's categories: Detoxify's `obscene` is
 * `profanity`; the Jigsaw names `toxic`, `severe_toxic` and `identity_hate` are
 * `toxicity`, `severe_toxicity` and `identity_attack`. Text is truncated to 512
 * tokens. The same behaviour as the Java, Go and .NET judges.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { BertWordPiece } from './wordpiece';

export { BertWordPiece } from './wordpiece';

/** The core package's `ToxicityScorer`: text and categories in, a 0..1 score per category out. */
export type ToxicityScorer = (text: string, categories: readonly string[]) => Promise<Record<string, number>>;

const MAX_TOKENS = 512;
const DETOXIFY_ORDER = ['toxicity', 'severe_toxicity', 'obscene', 'threat', 'insult', 'identity_attack'];
const CATEGORY_BY_OUTPUT: Readonly<Record<string, string>> = {
  toxicity: 'toxicity',
  toxic: 'toxicity',
  severe_toxicity: 'severe_toxicity',
  severe_toxic: 'severe_toxicity',
  obscene: 'profanity',
  profanity: 'profanity',
  threat: 'threat',
  insult: 'insult',
  identity_attack: 'identity_attack',
  identity_hate: 'identity_attack',
};

const readJson = (path: string): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const sigmoid = (logits: ArrayLike<number>): number[] => Array.from(logits, (logit) => 1 / (1 + Math.exp(-logit)));

function softmax(logits: ArrayLike<number>): number[] {
  const values = Array.from(logits);
  const max = Math.max(...values);
  const exps = values.map((logit) => Math.exp(logit - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/** Load the model in `directory` and answer with a scorer for it. Rejects when the directory has no model or no vocabulary. */
export async function createOnnxToxicityJudge(directory: string): Promise<ToxicityScorer> {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`ONNX toxicity model: '${directory}' is not a directory`);
  let model = join(directory, 'model.onnx');
  if (!existsSync(model)) {
    const other = readdirSync(directory)
      .filter((name) => name.endsWith('.onnx'))
      .sort()[0];
    if (!other) throw new Error(`ONNX toxicity model: no .onnx model in '${directory}'`);
    model = join(directory, other);
  }
  const vocabulary = join(directory, 'vocab.txt');
  if (!existsSync(vocabulary)) throw new Error(`ONNX toxicity model: no vocab.txt in '${directory}'`);

  let labels = DETOXIFY_ORDER;
  let useSoftmax = false;
  const config = readJson(join(directory, 'config.json'));
  if (isObject(config)) {
    useSoftmax = config.problem_type === 'single_label_classification';
    if (isObject(config.id2label)) {
      const ordered = Object.entries(config.id2label)
        .map(([index, label]) => [Number(index), String(label)] as const)
        .filter(([index]) => Number.isInteger(index))
        .sort(([a], [b]) => a - b);
      if (ordered.length > 0) labels = ordered.map(([, label]) => label);
    }
  }
  const tokenizerConfig = readJson(join(directory, 'tokenizer_config.json'));
  const lowerCase = !(isObject(tokenizerConfig) && tokenizerConfig.do_lower_case === false);

  const tokenizer = BertWordPiece.fromVocabularyText(readFileSync(vocabulary, 'utf8'), lowerCase);
  const session = await ort.InferenceSession.create(model);
  const output = session.outputNames[0];
  if (output === undefined) throw new Error('ONNX toxicity model: the model has no output');

  return async (text, categories) => {
    const ids = tokenizer.encode(text, MAX_TOKENS);
    const shape = [1, ids.length];
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of session.inputNames) {
      let values: bigint[];
      if (name === 'input_ids') values = ids.map(BigInt);
      else if (name === 'attention_mask') values = ids.map(() => 1n);
      else if (name === 'token_type_ids') values = ids.map(() => 0n);
      // An input this judge cannot fill: no score rather than a wrong one.
      else throw new Error(`ONNX toxicity model: unsupported input '${name}'`);
      feeds[name] = new ort.Tensor('int64', BigInt64Array.from(values), shape);
    }
    const result = await session.run(feeds, [output]);
    const logits = result[output]?.data as ArrayLike<number> | undefined;
    if (!logits) throw new Error('ONNX toxicity model: no output');
    const probabilities = useSoftmax ? softmax(logits) : sigmoid(logits);
    const scores: Record<string, number> = {};
    for (let index = 0; index < probabilities.length && index < labels.length; index += 1) {
      const category = CATEGORY_BY_OUTPUT[(labels[index] as string).toLowerCase()];
      if (category !== undefined && categories.includes(category)) scores[category] = probabilities[index] as number;
    }
    return scores;
  };
}
