# @traceverse/genai-otel-instrument-onnx

Optional add-on to `@traceverse/genai-otel-instrument`: a toxicity judge that runs a
Detoxify-style classifier with ONNX Runtime, in-process and on-prem
(`GENAI_TOXICITY_ONNX_MODEL`; contract/SDK_ADDITIONS.md section 12). The core package never
depends on ONNX Runtime; install this one next to it only when you want the judge.

```sh
npm install @traceverse/genai-otel-instrument @traceverse/genai-otel-instrument-onnx
export GENAI_ENABLE_TOXICITY_DETECTION=true
export GENAI_TOXICITY_ONNX_MODEL=/models/detoxify-original-onnx
```

The core imports this package on the first score, and only when the variable is set. If it
is not installed, or cannot load the model, one warning says so and toxicity is not measured -
never scored 0. A scorer given in code (`setToxicityScorer`) and `GENAI_TOXICITY_JUDGE_URL`
come first.

## The model directory

| File | |
|---|---|
| `model.onnx` (or one other `.onnx` file) | A sequence classifier taking `input_ids` (and optionally `attention_mask`, `token_type_ids`), int64, returning one row of logits |
| `vocab.txt` | The BERT WordPiece vocabulary |
| `config.json` (optional) | `id2label` names the outputs; `problem_type` `multi_label_classification` (sigmoid, the default) or `single_label_classification` (softmax). Without a label map, Detoxify's output order is assumed: toxicity, severe_toxicity, obscene, threat, insult, identity_attack |
| `tokenizer_config.json` (optional) | `do_lower_case` (default true) |

Output names map to the reference's categories: Detoxify's `obscene` is `profanity`; the
Jigsaw names `toxic`, `severe_toxic`, `identity_hate` are `toxicity`, `severe_toxicity`,
`identity_attack`. Text is truncated to 512 tokens. The same behaviour as the Java, Go and .NET
add-ons.

A local model file is not a download, so the judge works with `GENAI_AIR_GAPPED`. The model is
the operator's to provide; this package downloads nothing at run time.

## Installing without network access

`onnxruntime-node`'s install script may fetch extra binaries. Set
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip` for the CPU runtime only, and install from an offline
npm cache or mirror on air-gapped hosts.

## What was run

- The tokenizer against Hugging Face's `BertTokenizer` (transformers 5.17):
  `tests/fixtures/wordpiece-vectors.json`, 15 cases (accents, case, punctuation, sub-words,
  unknown and over-long words, CJK, control characters, truncation).
- The judge with ONNX Runtime 1.30.0 on a toy model (`tests/fixtures/toy-model`, the Go SDK's
  generator): sigmoid and softmax, label maps, the Detoxify order, refusals.
- The whole path through the core SDK: an instrumented OpenAI client, the variable set, the
  toy model scored, the attributes on the span (`tests/core-integration.test.ts`); and once
  live, with both packages packed and installed into a fresh application, against a local
  Ollama.
- **Not run with a real Detoxify export.**

## Development

```sh
cd onnx && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
npx vitest run --config onnx/vitest.config.mts   # from the repository root
npm run build                                     # in onnx/
```
