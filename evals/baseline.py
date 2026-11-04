"""The evals' ratchet: a case that passed before must keep passing.

evals/baseline.json (in git) lists, per eval, the cases that passed on the last fully green run. A run fails when any
of them fails now — a regression — however good the percentages look; a case that has never passed is reported but
doesn't fail the run (a known soft spot). After a run with no regressions and nothing unanswered, the cases that
passed are added (never removed): CI commits the file with the agent data. Only full runs touch it; a subset proves
nothing. Nothing here calls a model.
"""

import json
from pathlib import Path

PATH = Path(__file__).parent / "baseline.json"


def load() -> dict[str, list[str]]:
    return json.loads(PATH.read_text(encoding="utf-8")) if PATH.exists() else {}


def regressions(name: str, failed: set[str]) -> list[str]:
    """The cases of eval `name` that passed on the baseline run and fail now."""
    return sorted(failed & set(load().get(name, [])))


def ratchet(name: str, passed: set[str]) -> int:
    """Adds the cases that passed to eval `name`'s baseline. Returns how many are new."""
    data = load()
    before = set(data.get(name, []))
    after = before | passed
    if after != before:
        data[name] = sorted(after)
        PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return len(after - before)
