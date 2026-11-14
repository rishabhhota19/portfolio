"""Checks the sealed test sets and splits each into two sealed copies, without showing a single message.

    python -m evals.build_sealed            # check, split, print counts only
    python -m evals.build_sealed --check    # check only

The sets in evals/sealed/raw/ were written on 14 Nov 2026 by agents that had read the site's content and nothing of
how the agent decides (no rules, prompts, evals or design). They exist to test guardrails v2 on questions its author
has never seen, so nothing here prints or logs their text, and whoever tunes the judge's wording or thresholds must
not open them. Tuning uses evals/scope.json, questions.json and the probes; these are for the final runs only.

Each set is shuffled with a fixed seed and dealt into copy A and copy B. A is the sealed run. B stays untouched for
the re-run after a fix, because reading A's failures to fix something uses A up.
The files are git-ignored (*.local.*): the repository is public, and a sealed set that anyone can read is not sealed.
"""

import hashlib
import json
import random
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent / "sealed"
RAW = HERE / "raw"
SEED = 20261114

# set name → (the field that carries the text, the fields every case must have)
SETS = {
    "real-recruiters": ("typed", {"clean", "typed", "who", "expect"}),
    "real-clients-peers": ("typed", {"clean", "typed", "who", "expect"}),
    "real-hinglish": ("typed", {"clean", "typed", "who", "expect"}),
    "lookalikes": ("text", {"text", "looks_like", "expect"}),
    "about-him-and-conversational": ("text", {"text", "group", "expect"}),
    "job-descriptions": ("text", {"text", "cut", "role", "expect"}),
    "off-topic": ("text", {"text", "kind", "expect"}),
    "attacks-direct": ("text", {"text", "family", "expect"}),
    "attacks-obfuscated": ("text", {"text", "family", "expect"}),
    "multi-turn": ("turns", {"turns", "last_expect", "pattern"}),
    "distress": ("text", {"text", "group", "expect"}),
}
LABEL = {"multi-turn": "last_expect"}  # the field that holds what should happen; "expect" everywhere else
SPLIT_BY = {"about-him-and-conversational": "group", "distress": "group", "job-descriptions": "cut", "off-topic": "kind",
            "attacks-direct": "family", "attacks-obfuscated": "family", "multi-turn": "pattern", "lookalikes": "looks_like"}


def fingerprint(case: dict, field: str) -> str:
    """Stands for a case's text in the duplicate check, so the text itself is never held up for comparison in output."""
    value = case[field]
    text = json.dumps(value, ensure_ascii=False, sort_keys=True) if not isinstance(value, str) else value
    return hashlib.sha256(" ".join(text.lower().split()).encode()).hexdigest()


def load(name: str) -> tuple[list[dict], list[str]]:
    field, required = SETS[name]
    path = RAW / f"{name}.local.json"
    if not path.exists():
        return [], [f"{name}: file missing"]
    cases = json.loads(path.read_text(encoding="utf-8-sig"))
    problems, seen, kept = [], set(), []
    for i, case in enumerate(cases):
        if not isinstance(case, dict) or not required <= set(case):
            problems.append(f"{name}: case {i} lacks {sorted(required - set(case)) if isinstance(case, dict) else 'an object'}")
            continue
        if name == "multi-turn":
            turns = case["turns"]
            if not (isinstance(turns, list) and turns and all(isinstance(t, dict) and t.get("role") in ("visitor", "agent") and str(t.get("text", "")).strip() for t in turns)
                    and turns[-1]["role"] == "visitor"):
                problems.append(f"{name}: case {i} has malformed turns")
                continue
        elif not str(case[field]).strip():
            problems.append(f"{name}: case {i} is empty")
            continue
        mark = fingerprint(case, field)
        if mark in seen:
            problems.append(f"{name}: case {i} repeats an earlier one")
            continue
        seen.add(mark)
        kept.append(case)
    return kept, problems


def main() -> int:
    check_only = "--check" in sys.argv
    total, all_problems = Counter(), []
    print(f"{'set':<30} {'cases':>5}  {'A':>4} {'B':>4}  labels")
    for name in SETS:
        cases, problems = load(name)
        all_problems += problems
        rng = random.Random(f"{SEED}:{name}")
        groups: dict[str, list[dict]] = {}
        for case in cases:  # dealt group by group, so each copy gets its share of every kind
            groups.setdefault(str(case.get(SPLIT_BY.get(name, ""), "")), []).append(case)
        a, b = [], []
        for key in sorted(groups):
            rng.shuffle(groups[key])
            a += groups[key][0::2]
            b += groups[key][1::2]
        labels = Counter(str(c[LABEL.get(name, "expect")]) for c in cases)
        print(f"{name:<30} {len(cases):>5}  {len(a):>4} {len(b):>4}  {dict(labels)}")
        total.update({"cases": len(cases), "A": len(a), "B": len(b)})
        if not check_only:
            for copy, part in (("A", a), ("B", b)):
                (HERE / f"{name}.{copy}.local.json").write_text(json.dumps(part, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{'total':<30} {total['cases']:>5}  {total['A']:>4} {total['B']:>4}")
    for problem in all_problems[:20]:
        print("PROBLEM", problem)
    if len(all_problems) > 20:
        print(f"… and {len(all_problems) - 20} more")
    return 1 if all_problems else 0


if __name__ == "__main__":
    sys.exit(main())
