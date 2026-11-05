"""Is Dumbledore selling? Does it take the visitor to the right proof unasked, and keep the reply short enough to read?

    python -m evals.showing_eval                    # every case, the whole agent (real LLM calls)
    python -m evals.showing_eval why-hire jd-fde    # only these ids

The agent chooses the page itself (the BRIEF line in prompts.py); this measures how well, on real answers:
  - moved     it went to a page that proves the answer (evals/showing.json lists what counts for each question)
  - stayed    it left the page alone where no page proves anything (salary, visa, a bio, off-topic, "stay here")
  - brief     every model wrote the line, and none of it reached the visitor
  - crisp     replies stay short (WORD_LIMIT; bios and job descriptions have more to carry)
Exit 1 below MOVED_TARGET, on more than STAY_MISSES wrong "stay"s, on a leaked line, or on a reply over the limit.
"""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

os.environ["ANSWER_BANK"] = "off"
os.environ["ANSWER_CACHE"] = "off"

from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402

from agent import graph  # noqa: E402

HERE = Path(__file__).parent
DELAY_SECONDS = 4
MOVED_TARGET = 0.85  # real answers vary run to run: this is what it reliably does, so a bad prompt fails and a bad day doesn't
STAY_MISSES = 1
WORD_LIMIT = 125  # the prompt asks for under 80 (under 110 for a role fit): this catches a model ignoring it


def words(answer: str) -> int:
    """What the visitor reads: link targets aren't words."""
    return len(re.sub(r"\]\([^)]*\)", "]", answer).split())


def where_it_went(state: dict) -> str:
    """The page the visitor ends up on: the agent's choice, or a page the answer named if it didn't choose ("stay" if none)."""
    actions = state.get("actions", [])
    if nav := next((a for a in actions if a["type"] == "navigate"), None):
        return nav["path"]
    links = next((a for a in actions if a["type"] == "links"), None)
    return links["links"][0]["path"] if links and links.get("auto", True) else "stay"


async def main() -> int:
    ids = [a for a in sys.argv[1:] if not a.startswith("--")]
    cases = json.loads((HERE / "showing.json").read_text(encoding="utf-8"))
    cases = [c for c in cases if not ids or c["id"] in ids]
    rows = []
    for i, case in enumerate(cases):
        if i:
            await asyncio.sleep(DELAY_SECONDS)
        earlier = [m for q in case.get("history", []) for m in (HumanMessage(q), AIMessage("Sure."))]
        state = await graph.agent.ainvoke({"messages": [*earlier, HumanMessage(case["q"])]})
        last = state["messages"][-1]
        answer = last.content if last.type == "ai" else ""
        went = where_it_went(state)
        want = case["show"]
        right = went == "stay" if want == "stay" else bool(re.search(want, went))
        no_model = state.get("model") in ("none", "fallback")
        wrote_it = bool(state.get("show")) or state.get("model") in ("router", "cache", "bank") or state.get("intent") == "refused"
        leak = bool(re.search(r"\bBRIEF\b|\bSHOW:", answer))
        long = words(answer) > WORD_LIMIT
        rows.append({"id": case["id"], "stay": want == "stay", "right": right, "no_model": no_model, "wrote": wrote_it,
                     "leak": leak, "long": long, "words": words(answer)})
        if leak:
            print("      leaked: " + re.search(r".{0,60}(?:\bBRIEF\b|\bSHOW:).{0,60}", answer)[0])
        mark = "NO MODEL" if no_model else "ok  " if right and not leak and not long else "FAIL"
        print(f"{mark:<5} {case['id']:<17} {state.get('level', ''):<3} {state.get('model', '')[:22]:<22} {words(answer):>3}w  "
              f"{went:<44} {'' if wrote_it else 'NO BRIEF  '}{state.get('brief', '')[:60]}")
        if os.environ.get("SHOW_ANSWERS"):
            print("      " + answer.replace("\n", "\n      "))
    rows = [r for r in rows if not r["no_model"]]
    moving, staying = [r for r in rows if not r["stay"]], [r for r in rows if r["stay"]]
    moved = sum(r["right"] for r in moving) / max(1, len(moving))
    stayed = sum(r["right"] for r in staying)
    count = sorted(r["words"] for r in rows) or [0]
    print(f"\nmoved {moved:.0%} of {len(moving)} (target {MOVED_TARGET:.0%})  stayed {stayed}/{len(staying)}  "
          f"wrote the brief {sum(r['wrote'] for r in rows)}/{len(rows)}  leaks {sum(r['leak'] for r in rows)}  "
          f"words median {count[len(count) // 2]}, max {count[-1]}, over {WORD_LIMIT}: {sum(r['long'] for r in rows)}")
    bad = moved < MOVED_TARGET or len(staying) - stayed > STAY_MISSES or any(r["leak"] or r["long"] for r in rows)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
