"""The embedding model's tokenizer (BERT WordPiece, uncased), in plain Python.

It does what the `tokenizers` library does with agent/data/embeddings/tokenizer.json, token for token:
evals/tokenizer_eval.py compares the two on the site's own text, every eval question and tens of thousands of
generated strings, and CI fails on the first difference. The library is not shipped with the agent: with its
dependencies (huggingface-hub, hf-xet) it is 27 MB that pushed the function over the size at which Vercel stops
bundling packages and installs all of them on every cold start instead (about 2 s, measured 15 Nov 2026). The agent
only ever tokenizes short text, which this does in well under a millisecond.

The steps, in the library's order:
  1. the five special tokens ("[SEP]", "[CLS]"…) are cut out of the raw text and keep their own ids;
  2. BertNormalizer: control characters dropped, every whitespace character turned into a space, a space put around
     each CJK character, accents stripped, everything lower-cased;
  3. BertPreTokenizer: split on whitespace, each punctuation character a word of its own;
  4. WordPiece: each word cut greedily into the longest pieces the vocabulary has, later pieces marked "##";
  5. [CLS] in front, [SEP] behind, cut to 512 tokens, padded to the longest text in the batch.
"""

import json
import re
import unicodedata
from bisect import bisect_right
from pathlib import Path

MAX_WORD = 100  # characters: a longer "word" is one unknown token (max_input_chars_per_word)
MAX_TOKENS = 512  # the model's window, special tokens included
SPECIAL = ("[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]")  # the file's added_tokens: matched in the raw text, never split
CLASSES = "unicode_classes.json"  # beside the tokenizer file


class Ranges:
    """A set of characters kept as sorted (first, last) code-point ranges."""

    def __init__(self, ranges: list[list[int]]) -> None:
        self.firsts = [first for first, _ in ranges]
        self.lasts = [last for _, last in ranges]

    def __contains__(self, c: str) -> bool:
        at = bisect_right(self.firsts, ord(c)) - 1
        return at >= 0 and ord(c) <= self.lasts[at]


class WordPiece:
    """Which characters are dropped, turned into a space, split off as punctuation, stripped as accents or treated
    as CJK comes from unicode_classes.json, not from Python's own Unicode tables. The library uses older tables
    (they differ from Python 3.13's on 127 punctuation marks, 419 accents and 20 control characters), and Python's
    change with its version; the file holds the library's, read out of it one code point at a time by
    `python -m evals.tokenizer_eval --write`."""

    def __init__(self, path: Path | str) -> None:
        path = Path(path)
        model = json.loads(path.read_text(encoding="utf-8"))["model"]
        self.vocab: dict[str, int] = model["vocab"]
        self.prefix: str = model["continuing_subword_prefix"]
        self.unknown = self.vocab[model["unk_token"]]
        self.pad, self.cls, self.sep = self.vocab["[PAD]"], self.vocab["[CLS]"], self.vocab["[SEP]"]
        self._special = re.compile("(" + "|".join(re.escape(token) for token in SPECIAL) + ")")
        classes = json.loads((path.parent / CLASSES).read_text(encoding="utf-8"))
        self.dropped, self.spaces, self.breaks = Ranges(classes["dropped"]), Ranges(classes["spaces"]), Ranges(classes["breaks"])
        self.punctuation, self.accents, self.cjk = Ranges(classes["punctuation"]), Ranges(classes["accents"]), Ranges(classes["cjk"])

    def normalize(self, text: str) -> str:
        """BertNormalizer with clean_text, handle_chinese_chars, strip_accents and lowercase all on."""
        out = []
        for c in text:
            if c in self.dropped:
                continue
            if c in self.spaces:
                out.append(" ")
            elif c in self.cjk:
                out.extend((" ", c, " "))
            else:
                out.append(c)
        stripped = "".join(c for c in unicodedata.normalize("NFD", "".join(out)) if c not in self.accents)
        return "".join(c.lower() for c in stripped)  # one character at a time, as the library does: no word-final sigma

    def words(self, text: str) -> list[str]:
        """BertPreTokenizer: whitespace separates words, and every punctuation character is a word."""
        found, word = [], []
        for c in text:
            if c in self.breaks or c in self.punctuation:
                if word:
                    found.append("".join(word))
                    word = []
                if c in self.punctuation:
                    found.append(c)
            else:
                word.append(c)
        if word:
            found.append("".join(word))
        return found

    def _pieces(self, word: str) -> list[int]:
        if len(word) > MAX_WORD:
            return [self.unknown]
        ids, start = [], 0
        while start < len(word):
            end = len(word)
            while end > start:
                piece = word[start:end] if start == 0 else self.prefix + word[start:end]
                if piece in self.vocab:
                    ids.append(self.vocab[piece])
                    break
                end -= 1
            else:
                return [self.unknown]  # one piece the vocabulary lacks makes the whole word unknown
            start = end
        return ids

    def ids(self, text: str) -> list[int]:
        """One text as token ids, [CLS] … [SEP], at most MAX_TOKENS of them."""
        ids: list[int] = []
        for part in self._special.split(text):
            if part in SPECIAL:
                ids.append(self.vocab[part])
            else:
                for word in self.words(self.normalize(part)):
                    ids.extend(self._pieces(word))
        return [self.cls, *ids[: MAX_TOKENS - 2], self.sep]

    def batch(self, texts: list[str]) -> tuple[list[list[int]], list[list[int]]]:
        """(ids, attention mask) for each text, padded on the right to the longest."""
        rows = [self.ids(text) for text in texts]
        width = max((len(row) for row in rows), default=0)
        return ([row + [self.pad] * (width - len(row)) for row in rows],
                [[1] * len(row) + [0] * (width - len(row)) for row in rows])
