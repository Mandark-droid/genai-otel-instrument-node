"""Tokenizer vectors for the add-on's BERT WordPiece port, made by Hugging Face's
BertTokenizer: the tokenizer Detoxify-style models are trained with.

Writes wordpiece-vectors.json next to this file. Requires: pip install transformers
(5.x was used). Run: python make_tokenizer_vectors.py
"""

import json
import os
import tempfile

from transformers import BertTokenizer

VOCAB = [
    "[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]",
    "you", "are", "a", "worthless", "idiot", "and", "i", "hate", "thank", "for", "the",
    "lovely", "afternoon", "un", "##believ", "##able", "##s", "cafe", "naive", "hello",
    "world", "it", "'", "s", ".", ",", "!", "?", "-", "(", ")", "\"", "#", "@", "$", "%",
    "&", "*", "/", ":", ";", "[", "]", "_", "{", "}", "~", "`", "^", "+", "<", "=", ">", "|",
    "中", "文", "¿", "¡", "—", "“", "”", "tok", "##en", "##ize",
    "##r", "Hello", "World", "Cafe",
]

CASES = [
    ("You are a worthless idiot and I hate you.", True, 512),
    ("unbelievable unbelievables", True, 512),
    ("Hello, World! It's lovely.", True, 512),
    ("Café naïve", True, 512),
    ("Café Hello World", False, 512),
    ("tokenizer tokenize tokens", True, 512),
    ("xyzzy plugh", True, 512),
    ("a" * 101 + " hello", True, 512),
    ("中文 hello中world", True, 512),
    ("hello\u0000\u0007world\tthe afternoon\r\nlovely", True, 512),
    ("¿hello? ¡world! — “the”", True, 512),
    ("(a) [b] {c} <d> e_f g-h i/j k:l m;n o@p q#r s$t u%v w&x y*z ~`^+=|", True, 512),
    ("you are a worthless idiot and i hate the lovely afternoon", True, 8),
    ("", True, 512),
    ("   \t\n  ", True, 512),
]


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out = {"generated_by": "transformers BertTokenizer (make_tokenizer_vectors.py)", "vocab": VOCAB, "cases": []}
    with tempfile.TemporaryDirectory() as tmp:
        vocab_file = os.path.join(tmp, "vocab.txt")
        with open(vocab_file, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(VOCAB) + "\n")
        for text, lower, max_length in CASES:
            tokenizer = BertTokenizer(vocab_file, do_lower_case=lower)
            ids = tokenizer(text, truncation=True, max_length=max_length)["input_ids"]
            out["cases"].append({"text": text, "lower": lower, "max_length": max_length, "ids": ids,
                                 "tokens": tokenizer.convert_ids_to_tokens(ids)})
    with open(os.path.join(here, "wordpiece-vectors.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(len(out["cases"]), "cases")


if __name__ == "__main__":
    main()
