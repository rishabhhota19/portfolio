"""Checks the difficulty rules (agent/difficulty.py) against hand-labelled questions. No API calls.

    python -m evals.difficulty_eval
"""

import json
import sys
from pathlib import Path

from agent.difficulty import difficulty

TARGET = 0.85  # a wrong guess is cheap (the router spills to the next level), but most should be right


def main() -> int:
    cases = json.loads((Path(__file__).parent / "difficulty.json").read_text(encoding="utf-8"))
    wrong = [(c["q"], c["level"], got) for c in cases if (got := difficulty(c["q"])) != c["level"]]
    for q, want, got in wrong:
        print(f"  {want} → got {got}: {q}")
    accuracy = 1 - len(wrong) / len(cases)
    print(f"Difficulty: {accuracy:.0%} of {len(cases)} correct (target ≥ {TARGET:.0%})")
    return 0 if accuracy >= TARGET else 1


if __name__ == "__main__":
    sys.exit(main())
