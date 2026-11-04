"""Advocacy evals: does Dumbledore represent Rishabh the way a good agent would, and stay honest doing it?

    python -m evals.advocacy_eval                         # every case, the whole agent (real LLM calls)
    python -m evals.advocacy_eval --out answers.jsonl     # also save the answers, to compare two versions
    python -m evals.advocacy_eval jd-agentic why-hire     # only these ids

evals/advocacy.json holds recruiter questions of every kind: job descriptions for several roles (one he only partly
fits, one outside his lane), "why hire him", weaknesses, a seniority doubt, a bio, a comparison, a sceptic and a
follow-up. Each answer is checked by rules (no judge model, no extra quota):
  - grounded   every number in the answer is on the site or in the question
  - no trivia  no invented "gaps" or deficits (unless the case allows them, e.g. "what are his weaknesses?")
  - proof      names the work the case expects and, where asked, links one of his pages
  - next step  hiring questions end with a way to act: his résumé, "Share your details", email
  - honest     a role he doesn't fit isn't sold as a fit
Exit 1 if any case fails. A case no free model could answer is NO MODEL, not a failure. The answer cache is off, so
each run asks the live agent.
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
from agent.config import KNOWLEDGE  # noqa: E402

HERE = Path(__file__).parent
DELAY_SECONDS = 20  # hard questions are ~5k tokens and Groq allows 8k a minute per model: don't spill to paid-for quotas
SITE_TEXT = "\n".join([KNOWLEDGE["core"], *(f"{d['title']}\n{d['text']}" for d in KNOWLEDGE["docs"])])
SMART_QUOTES = str.maketrans("‘’“”", "''\"\"")

TRIVIA = {  # what a neutral reviewer writes and an agent doesn't; a case may allow one by name
    "gap-talk": r"\bgaps?\b|no explicit mention|not explicitly (mentioned|stated|listed|called out)",
    "deficit-talk": r"\blacks?\b|\black of\b|\bweakness(es)?\b|\bunfortunately\b|\bfalls? short\b",
}
NEXT_STEP = (r"r[ée]sum[ée]|Share your details|e-?mail|reach out|get in touch|LinkedIn|contact|talk (to|with) him|"
             r"(set up|book|schedule) a (call|chat)|ask him|interview")


def conversation(case: dict) -> list:
    earlier = [m for q in case.get("history", []) for m in (HumanMessage(q), AIMessage("Here's what the site says about that."))]
    return [*earlier, HumanMessage(case["q"])]


def numbers_not_on_site(answer: str, question: str) -> list[str]:
    """Numbers of two or more digits (or with a decimal point) that neither the site nor the question contains.
    Link targets don't count: "/experience#03-osteosconnect" is a page anchor, not a claim."""
    prose = re.sub(r"\]\([^)\s]+\)", "]", answer)
    found = re.findall(r"\d+(?:\.\d+)?", prose)
    return sorted({n for n in found if (len(n) >= 2 or "." in n) and n not in SITE_TEXT and n not in question})


def check(case: dict, answer: str) -> list[str]:
    text = answer.translate(SMART_QUOTES)
    why = [f"made-up number {n}" for n in numbers_not_on_site(text, case["q"])]
    why += [f"{name}: /{p}/" for name, p in TRIVIA.items() if name not in case.get("allow", []) and re.search(p, text, re.I)]
    why += [f"missing /{p}/" for p in case.get("include", []) if not re.search(p, text, re.I)]
    why += [f"contains /{p}/" for p in case.get("exclude", []) if re.search(p, text, re.I)]
    if case.get("next_step") and not re.search(NEXT_STEP, text, re.I):
        why.append("no next step")
    return why


async def main() -> int:
    ids = [a for a in sys.argv[1:] if not a.startswith("--") and not a.endswith(".jsonl")]
    out = next((Path(a) for a in sys.argv[1:] if a.endswith(".jsonl")), None)
    cases = json.loads((HERE / "advocacy.json").read_text(encoding="utf-8"))
    cases = [c for c in cases if not ids or c["id"] in ids]
    rows = []
    for i, case in enumerate(cases):
        if i:
            await asyncio.sleep(DELAY_SECONDS)
        state = await graph.agent.ainvoke({"messages": conversation(case)})
        last = state["messages"][-1]
        answer = last.content if last.type == "ai" else ""
        no_model = state.get("model") == "none"
        why = [] if no_model else check(case, answer)
        steps = [t for t in state.get("trace", []) if t["step"] in ("research", "respond")]
        rows.append({"id": case["id"], "kind": case["kind"], "q": case["q"], "answer": answer, "ok": not why and not no_model,
                     "why": why, "model": state.get("model", ""), "level": state.get("level", ""),
                     "usage": state.get("usage", {}), "steps": steps})
        mark = "NO MODEL" if no_model else "ok  " if not why else "FAIL"
        print(f"{mark:<5} {case['id']:<12} {state.get('level', ''):<3} {state.get('model', '')[:34]:<34} {'; '.join(why)}")
    if out:
        out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    failed = sum(not r["ok"] and r["model"] != "none" for r in rows)
    unanswered = sum(r["model"] == "none" for r in rows)
    print(f"\nadvocacy: {len(rows) - failed - unanswered}/{len(rows)} passed" + (f", {unanswered} no model" if unanswered else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
