# Copied from genai-otel-instrument-go contrib/otelonnxtoxicity/testdata/make_model.py:
# the same toy model, so the Go, Java and Node add-ons are tested against one model.
# Run: python make_model.py toy-model   (requires: pip install onnx numpy)
"""Write a tiny toxicity classifier for the runtime test: model.onnx, vocab.txt
and config.json, in the directory given as the only argument.

The model is not trained. Each token looks up a row of six logits (the
Jigsaw labels) and the model returns the maximum over the tokens: the rows of
"idiot" and "hate" score high on "toxic", every other row scores low. That is
enough to prove the Go judge drives a real ONNX Runtime session end to end:
tokenizer ids in, int64 tensors, a float32 output, the label mapping out.

Requires: pip install onnx numpy
"""

import json
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

LABELS = ["toxic", "severe_toxic", "obscene", "threat", "insult", "identity_hate"]
VOCAB = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "you", "are", "a", "worthless", "idiot",
         "and", "i", "hate", "thank", "for", "the", "lovely", "afternoon", "."]


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    weights = np.full((len(VOCAB), len(LABELS)), -3.0, dtype=np.float32)
    for word in ("idiot", "hate"):
        weights[VOCAB.index(word), LABELS.index("toxic")] = 4.0
        weights[VOCAB.index(word), LABELS.index("insult")] = 2.0

    inputs = [helper.make_tensor_value_info(name, TensorProto.INT64, [1, "sequence"])
              for name in ("input_ids", "attention_mask", "token_type_ids")]
    output = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, len(LABELS)])
    nodes = [
        helper.make_node("Gather", ["weights", "input_ids"], ["per_token"], axis=0),
        helper.make_node("ReduceMax", ["per_token"], ["logits"], axes=[1], keepdims=0),
    ]
    graph = helper.make_graph(nodes, "toy-toxicity", inputs, [output],
                              initializer=[numpy_helper.from_array(weights, "weights")])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, os.path.join(out_dir, "model.onnx"))

    with open(os.path.join(out_dir, "vocab.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(VOCAB) + "\n")
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"id2label": {str(i): label for i, label in enumerate(LABELS)},
                   "problem_type": "multi_label_classification"}, f)


if __name__ == "__main__":
    main(sys.argv[1])
