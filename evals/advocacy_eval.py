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
Exit 1 on more than one failing case, on any case that passed on the last green full run and fails now (the baseline
in evals/baseline.json, which a green full run extends), or on a question no model answered (EVALS_ALLOW_UNANSWERED=1
makes that a warning locally). The answer cache is off, so each run asks the live agent. A miss of form (too long,
no next step, a missing name) is asked once more and fails only if it fails twice; an invented number or a role
sold dishonestly fails on the first answer.
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
from evals import baseline  # noqa: E402

HERE = Path(__file__).parent
WORD_LIMIT = 125  # the prompt asks for under 110: this catches a model ignoring it
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


def check(case: dict, answer: str, links: list[dict] = ()) -> list[str]:
    """links: the "Take me to …" chips the visitor gets under the answer — they are links too, so a case that wants a
    page link is satisfied by them as much as by a link in the text."""
    text = answer.translate(SMART_QUOTES)
    shown = text + "\n" + "\n".join(f"[{l['label']}]({l['path']})" for l in links)  # what the visitor actually sees
    why = [f"made-up number {n}" for n in numbers_not_on_site(text, case["q"])]
    why += [f"{name}: /{p}/" for name, p in TRIVIA.items() if name not in case.get("allow", []) and re.search(p, text, re.I)]
    why += [f"missing /{p}/" for p in case.get("include", []) if not re.search(p, shown, re.I)]
    for p in case.get("exclude", []):
        if m := re.search(p, text, re.I):
            why.append(f"contains \"{text[max(0, m.start() - 40):m.end() + 40]}\"".replace("\n", " "))
    if case.get("next_step") and not re.search(NEXT_STEP, text, re.I):
        why.append("no next step")
    if (count := len(re.sub(r"\]\([^)]*\)", "]", text).split())) > WORD_LIMIT:
        why.append(f"{count} words: nobody reads that")
    return why


NEVER_ONCE = ("made-up number", "contains ")  # what must not happen even once: these fail on the first answer


async def answered(case: dict) -> dict:
    """The case through the whole agent, and why its answer fails ([] when it passes or when no model answered)."""
    state = await graph.agent.ainvoke({"messages": conversation(case)})
    last = state["messages"][-1]
    answer = last.content if last.type == "ai" else ""
    no_model = state.get("model") in graph.UNANSWERED
    links = [l for a in state.get("actions", []) if a.get("type") == "links" for l in a.get("links", [])]
    links += [a for a in state.get("actions", []) if a.get("type") == "navigate"]  # the page it took them to
    why = [] if no_model else check(case, answer, links)
    steps = [t for t in state.get("trace", []) if t["step"] in ("research", "respond")]
    return {"id": case["id"], "kind": case["kind"], "q": case["q"], "answer": answer, "ok": not why and not no_model,
            "why": why, "model": state.get("model", ""), "level": state.get("level", ""),
            "usage": state.get("usage", {}), "steps": steps}


async def main() -> int:
    ids = [a for a in sys.argv[1:] if not a.startswith("--") and not a.endswith(".jsonl")]
    out = next((Path(a) for a in sys.argv[1:] if a.endswith(".jsonl")), None)
    cases = json.loads((HERE / "advocacy.json").read_text(encoding="utf-8"))
    cases = [c for c in cases if not ids or c["id"] in ids]
    rows = []
    for i, case in enumerate(cases):
        if i:
            await asyncio.sleep(DELAY_SECONDS)
        row = await answered(case)
        if row["why"] and not any(reason.startswith(NEVER_ONCE) for reason in row["why"]):
            # One answer is one sample from a model that words things differently every time: the same job description
            # ran 136 to 163 words in 4 of 20 asks on an unchanged agent (14 Nov 2026), and each one failed the run. A
            # miss of form (too long, no next step, a missing name) is asked once more and fails only if it fails
            # twice. An invented number or a role sold dishonestly gets no second ask.
            print(f"again {case['id']:<12} first answer: {'; '.join(row['why'])}")
            await asyncio.sleep(DELAY_SECONDS)
            row = {**await answered(case), "first_why": row["why"]}
        rows.append(row)
        mark = "NO MODEL" if row["model"] in graph.UNANSWERED else "ok  " if not row["why"] else "FAIL"
        print(f"{mark:<5} {case['id']:<12} {row['level']:<3} {row['model'][:34]:<34} {'; '.join(row['why'])}")
    if out:
        out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    failed = sum(not r["ok"] and r["model"] not in graph.UNANSWERED for r in rows)
    unanswered = sum(r["model"] in graph.UNANSWERED for r in rows)
    print(f"\nadvocacy: {len(rows) - failed - unanswered}/{len(rows)} passed" + (f", {unanswered} no model" if unanswered else ""))
    # Same bar as the other evals (baseline.py): at most one miss, never a case that passed on the last green run.
    regressed = baseline.regressions("advocacy", {r["id"] for r in rows if not r["ok"] and r["model"] not in graph.UNANSWERED}) if not ids else []
    if regressed:
        print(f"::error::Regression — passed before, fail now: {', '.join(regressed)}")
    if unanswered:
        print(f"::{'warning' if os.environ.get('EVALS_ALLOW_UNANSWERED') else 'error'}::{unanswered} questions got no answer — they tested nothing.")
    bad = bool(regressed) or failed > 1 or (unanswered and not os.environ.get("EVALS_ALLOW_UNANSWERED"))
    if not bad and not ids and not unanswered:
        if new := baseline.ratchet("advocacy", {r["id"] for r in rows if r["ok"]}):
            print(f"baseline: {new} more case(s) must keep passing from now on")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
