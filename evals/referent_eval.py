"""Does Dumbledore take the visitor to what they asked about: ONE thing, or ALL of a kind?

    python -m evals.referent_eval                  # every case in evals/referent.json, 5 at a time (real LLM calls)
    python -m evals.referent_eval best-project     # only these ids

A question names a referent. One thing — a named item, or one picked out of a section ("his best project", "his
current role", "his first job", even "his best projects") — means that item's own page or tile: an object. All of a
kind ("his projects", "what papers has he written", "his work history") means the section. Two scores, kept apart so a
failure says which part went wrong:
  scope   did it go to an object when one was asked for, and to the section when all were (from the path's shape)
  target  is it the right object or section (each case's regex)
"via" says who decided: the keyword shortcut (route) or the model (its hidden SHOW line).
Exit 1 when scope or target is below TARGET. Cases run in parallel, so the whole eval takes a couple of minutes.
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ["ANSWER_BANK"] = "off"   # measure the decision itself, not answers cached from an older prompt
os.environ["ANSWER_CACHE"] = "off"

from langchain_core.messages import HumanMessage  # noqa: E402

from agent import graph  # noqa: E402
from agent.pages import SECTIONS  # noqa: E402
from evals.showing_eval import where_it_went  # noqa: E402

HERE = Path(__file__).parent
PARALLEL = 5
TARGET = 0.85


def scope_of(path: str) -> str:
    """'all' for a section, 'one' for an item (its own page or a #tile on a section), 'none' for stay / the card."""
    if path in SECTIONS:
        return "all"
    base, _, anchor = path.partition("#")
    return "one" if anchor or (base.count("/") >= 2 and base.split("/")[1]) else "none"


async def run(case: dict, gate: asyncio.Semaphore) -> dict:
    async with gate:
        started = time.perf_counter()
        for attempt in range(2):  # one reply is one sample: a miss is asked once more and counts only if it repeats
            state = await graph.agent.ainvoke({"messages": [HumanMessage(case["q"])]})
            went = where_it_went(state)
            row = {"id": case["id"], "want": case["scope"], "went": went, "scope": scope_of(went),
                   "via": "route" if state.get("model") == "router" else state.get("model", "?").split("/")[-1][:24],
                   "said": state.get("scope", ""), "s": round(time.perf_counter() - started)}
            row["scope_ok"] = row["scope"] == case["scope"]
            row["target_ok"] = bool(re.search(case["path"], went))
            if row["scope_ok"] and row["target_ok"]:
                break
        return row


async def main() -> int:
    ids = [a for a in sys.argv[1:] if not a.startswith("--")]
    cases = [c for c in json.loads((HERE / "referent.json").read_text(encoding="utf-8")) if not ids or c["id"] in ids]
    gate = asyncio.Semaphore(PARALLEL)
    started = time.perf_counter()
    rows = await asyncio.gather(*(run(c, gate) for c in cases))
    for r in rows:
        mark = "ok  " if r["scope_ok"] and r["target_ok"] else "FAIL"
        print(f"{mark}  {r['id']:<18} want {r['want']:<3}  went {r['scope']:<4} {r['went']:<44} via {r['via']:<24}"
              f"{(' said ' + r['said']) if r['said'] else ''}  {r['s']}s")
    scope = sum(r["scope_ok"] for r in rows) / max(1, len(rows))
    target = sum(r["target_ok"] for r in rows) / max(1, len(rows))
    by_want = {w: f"{sum(r['scope_ok'] for r in rows if r['want'] == w)}/{sum(r['want'] == w for r in rows)}" for w in ("one", "all")}
    print(f"\nscope {scope:.0%} (one {by_want['one']}, all {by_want['all']})  target {target:.0%}  (target {TARGET:.0%})  "
          f"{len(rows)} cases in {time.perf_counter() - started:.0f}s")
    return 0 if scope >= TARGET and target >= TARGET else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
