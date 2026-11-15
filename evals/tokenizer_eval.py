"""Is the agent's own tokenizer (agent/wordpiece.py) the same as the `tokenizers` library it replaces?

    python -m evals.tokenizer_eval            # needs `tokenizers` (requirements-dev.txt); no model, no network
    python -m evals.tokenizer_eval --write    # first read the library's character classes into unicode_classes.json
    python -m evals.tokenizer_eval --classes  # also check that file against the library, code point by code point

Every text is tokenized both ways and the ids and attention masks must be equal, one text at a time and in batches
(padding). The texts: every chunk of the site, the scope bank's examples, every question in the eval files, the
answer bank's phrasings, hand-picked hard cases, and generated strings from many scripts and character classes
(a fixed seed, so a failure can be run again). One difference fails the run: a different token means a different
vector, and the index, the scope bank and the answer bank were all built with this tokenizer.
"""

import json
import random
import sys
from pathlib import Path

from tokenizers import Tokenizer

from agent.embeddings import FOLDER
from agent.wordpiece import CLASSES, MAX_TOKENS, WordPiece

HERE = Path(__file__).parent
DATA = HERE.parent / "agent" / "data"
SEED = 20261115
GENERATED = 40_000

HARD = [
    "", " ", "\n\t ", "hi", "Hi!!", "What's his notice period?", "wat hav u bilt wit agnts", "kya ye banda agents pe kaam kiya hai",
    "naïve café résumé Zürich São Paulo", "İstanbul ΣΑΣ ΟΔΟΣ ẞ Ǆ ǅ", "full‐width ＡＢＣ １２３", "é ä ô ñ (combining marks)",
    "中文 日本語 한국어 混ぜた text", "हिन्दी में सवाल: क्या वह एजेंट बनाता है?", "العربية עברית mixed with English", "emoji 😀👍🏽 👨‍👩‍👧 🇮🇳 done",
    "zero​width‌join‍er ﻿BOM soft­hyphen", "nbsp thin space　ideographic", "control\x00\x01\x1f\x7f\x85chars � replacement",
    "tabs\tand\r\nnewlines\x0b\x0c\x1c\x1d\x1e\x1f  line  para", "a" * 100, "a" * 101, "x" * 300, "supercalifragilisticexpialidocious" * 4,
    "[CLS] literal [SEP] special [MASK] tokens [PAD] [UNK] in text", "[cls] [Sep] not special", "[SEP][SEP]no spaces[CLS]", "[ SEP ] [SEP", "##prefix ##ing word##piece",
    "C++ C# .NET node.js F1=71.7% IoU 56.8% ₹0/month 7–10 days → 1 day", "email@example.com https://rishabh-hota.vercel.app/projects?x=1#y", "don't can't it's ‘quoted’ “double” ‹a› «b»",
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", "¡¿§¶†‡•…‰′″‹›※‼⁇⁈⁉", "math ∑∏√∞≈≠≤≥ ±×÷ µ Ω °C", "1,234.56 3.14e-10 0x1F 1_000", "ǅ ǈ ǋ ǲ titlecase digraphs",
    "word " * 600, "long, with, punctuation, " * 200, "😀".encode("utf-16", "surrogatepass").decode("utf-16"),
]

RANGES = [  # (first, last, weight): what a generated string is drawn from
    (0x20, 0x7E, 40), (0x00, 0x1F, 2), (0x7F, 0xA0, 2), (0xA1, 0x24F, 10), (0x250, 0x36F, 3), (0x370, 0x3FF, 4), (0x400, 0x4FF, 4),
    (0x590, 0x6FF, 3), (0x900, 0x97F, 4), (0xE00, 0xE7F, 1), (0x1100, 0x11FF, 1), (0x2000, 0x206F, 4), (0x2070, 0x22FF, 3),
    (0x2E80, 0x30FF, 2), (0x3400, 0x4DBF, 1), (0x4E00, 0x9FFF, 3), (0xAC00, 0xD7A3, 1), (0xF900, 0xFAFF, 1), (0xFB00, 0xFFFD, 2),
    (0x1F300, 0x1FAFF, 2), (0x20000, 0x2A6DF, 1), (0xE0000, 0xE007F, 1),
]


def generated(count: int) -> list[str]:
    rng = random.Random(SEED)
    weights = [w for _, _, w in RANGES]
    vocab = list(json.loads((FOLDER / "tokenizer.json").read_text(encoding="utf-8"))["model"]["vocab"])
    out = []
    for i in range(count):
        if i % 3 == 0:  # real pieces of the vocabulary glued and spaced at random: exercises the greedy matching
            parts = [rng.choice(vocab).replace("##", rng.choice(["", "", "##", " "])) for _ in range(rng.randint(1, 12))]
            out.append(rng.choice(["", " ", "-", "'"]).join(parts))
            continue
        chars = []
        for _ in range(rng.randint(1, 60)):
            first, last, _w = rng.choices(RANGES, weights)[0]
            code = rng.randint(first, last)
            if not 0xD800 <= code <= 0xDFFF:  # a lone surrogate is not text
                chars.append(chr(code))
        out.append("".join(chars))
    return out


def site_texts() -> list[str]:
    texts = [c["text"] for c in json.loads((DATA / "chunks.json").read_text(encoding="utf-8"))]
    answers = json.loads((DATA / "answers.json").read_text(encoding="utf-8"))
    for intent in answers.get("intents", []):
        texts += [intent["q"], *intent.get("paraphrases", []), intent.get("text", "")]
    for name in ("scope.json", "questions.json", "advocacy.json", "showing.json", "navigation.json"):
        path = HERE / name
        if path.exists():
            for case in json.loads(path.read_text(encoding="utf-8")):
                texts += [case["q"], *case.get("history", [])] if isinstance(case, dict) and "q" in case else []
    from agent.scope import IN_SCOPE, OUT_OF_SCOPE

    return [t for t in texts + IN_SCOPE + OUT_OF_SCOPE if isinstance(t, str)]


def classes() -> dict[str, list[list[int]]]:
    """How the library treats each of the 1.1 million code points, as ranges: read out of the library itself, so the
    agent's tokenizer uses the library's Unicode tables and not those of whichever Python it runs on."""
    from tokenizers.normalizers import BertNormalizer
    from tokenizers.pre_tokenizers import BertPreTokenizer

    clean = BertNormalizer(clean_text=True, handle_chinese_chars=False, strip_accents=False, lowercase=False)
    strip = BertNormalizer(clean_text=False, handle_chinese_chars=False, strip_accents=True, lowercase=False)
    chinese = BertNormalizer(clean_text=False, handle_chinese_chars=True, strip_accents=False, lowercase=False)
    split = BertPreTokenizer()
    found: dict[str, list[list[int]]] = {name: [] for name in ("dropped", "spaces", "breaks", "punctuation", "accents", "cjk")}

    def add(name: str, code: int) -> None:
        ranges = found[name]
        if ranges and ranges[-1][1] == code - 1:
            ranges[-1][1] = code
        else:
            ranges.append([code, code])

    for code in range(0x110000):
        if 0xD800 <= code <= 0xDFFF:  # surrogates are not characters
            continue
        c = chr(code)
        cleaned = clean.normalize_str("a" + c + "b")
        if cleaned == "ab":
            add("dropped", code)
        elif cleaned == "a b":
            add("spaces", code)
        pieces = [piece for piece, _ in split.pre_tokenize_str("a" + c + "b")]
        if pieces == ["a", "b"]:
            add("breaks", code)
        elif pieces == ["a", c, "b"]:
            add("punctuation", code)
        if strip.normalize_str("a" + c) == "a":
            add("accents", code)
        if chinese.normalize_str("a" + c + "b") == "a " + c + " b":
            add("cjk", code)
    return found


def main() -> int:
    table = FOLDER / CLASSES
    if "--write" in sys.argv:
        table.write_text(json.dumps(classes(), separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"wrote {table.name}: " + ", ".join(f"{name} {len(ranges)} ranges" for name, ranges in json.loads(table.read_text(encoding='utf-8')).items()))
    if "--classes" in sys.argv:  # slow (a minute): every code point against the library again
        same = json.loads(table.read_text(encoding="utf-8")) == classes()
        print(f"{'ok  ' if same else 'FAIL'} {table.name} is what the library does with every code point")
        if not same:
            return 1
    reference = Tokenizer.from_file(str(FOLDER / "tokenizer.json"))
    reference.enable_truncation(MAX_TOKENS)
    reference.enable_padding()
    ours = WordPiece(FOLDER / "tokenizer.json")
    groups = {"site, evals and banks": site_texts(), "hard cases": HARD, "generated": generated(GENERATED)}
    wrong = 0
    for name, texts in groups.items():
        different = [t for t in texts if ours.ids(t) != reference.encode(t).ids]
        wrong += len(different)
        print(f"{'ok  ' if not different else 'FAIL'} {name}: {len(texts)} texts, {len(different)} tokenized differently")
        for t in different[:5]:
            print(f"     text {t[:60]!r}\n     ours {ours.ids(t)[:24]}\n     ref  {reference.encode(t).ids[:24]}")
    batches = 0
    everything = [t for texts in groups.values() for t in texts]
    for start in range(0, len(everything), 7):  # batches of mixed lengths: ids and masks after padding
        batch = everything[start:start + 7]
        ids, mask = ours.batch(batch)
        encoded = reference.encode_batch(batch)
        if ids != [e.ids for e in encoded] or mask != [e.attention_mask for e in encoded]:
            batches += 1
    print(f"{'ok  ' if not batches else 'FAIL'} batches: {len(everything) // 7 + 1} batches of 7, {batches} padded or masked differently")
    print(f"\ntokenizer: {'identical on every text' if not wrong and not batches else 'DIFFERENT'}")
    return 1 if wrong or batches else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.exit(main())
