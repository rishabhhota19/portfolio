"""Navigation evals: does "take me to …" land on the right page, and do ordinary questions stay put? Rules only.

    python -m evals.navigation_eval
"""

import json
import sys
from pathlib import Path

from agent.pages import navigation


def main() -> int:
    cases = json.loads((Path(__file__).parent / "navigation.json").read_text(encoding="utf-8"))
    wrong = 0
    for c in cases:
        nav = navigation(c["q"])
        got = nav["path"] if nav else None
        ok = got == c["path"] and (nav is None or nav["pure"] == c.get("pure", nav["pure"]))
        wrong += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {c['q']:<62} → {got}{'' if ok else '  (expected ' + str(c['path']) + ')'}")
    print(f"\nnavigation: {len(cases) - wrong}/{len(cases)} correct")
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(main())
