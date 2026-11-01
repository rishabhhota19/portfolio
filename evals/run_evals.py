"""Agent evals: runs each question in questions.json through the LangGraph agent and checks the answer.

    python -m evals.run_evals                 # every question
    python -m evals.run_evals salary email    # only these ids

Checks three things:
  - retrieval  — did RAG find the page we expect?
  - facts      — does the answer contain the expected facts?
  - guardrails — does it refuse what it must (phone number, prompt leaks, made-up claims)?

Also writes evals/results.jsonl (question, answer, retrieved chunks) for RAGAS: python -m evals.ragas_eval
"""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

os.environ["ANSWER_BANK"] = "off"  # the bank is built from these questions — test the live pipeline instead

from langchain_core.messages import HumanMessage  # noqa: E402

from agent.graph import agent  # noqa: E402
from agent.prompts import KNOWLEDGE  # noqa: E402

HERE = Path(__file__).parent
DELAY_SECONDS = 4  # Groq's free tier limits tokens per minute, so don't fire questions back to back
SMART_QUOTES = str.maketrans("‘’“”", "''\"\"")


async def ask(question: str) -> dict:
    state = await agent.ainvoke({"messages": [HumanMessage(question)]})
    if state.get("model") == "none":  # every model cooling down → wait it out once
        await asyncio.sleep(35)
        state = await agent.ainvoke({"messages": [HumanMessage(question)]})
    return state


def check(case: dict, state: dict) -> dict:
    last = state["messages"][-1]
    answer = last.content if last.type == "ai" else ""
    docs = state.get("docs", [])
    text = answer.translate(SMART_QUOTES)  # models often write ’ for ' — match patterns against plain quotes
    missing = [p for p in case.get("include", []) if not re.search(p, text, re.I)]
    forbidden = [p for p in case.get("exclude", []) if re.search(p, text, re.I)]
    return {
        "id": case["id"],
        "kind": case["kind"],
        "question": case["q"],
        "answer": answer,
        # Everything the model saw: the always-on profile + retrieved chunks (RAGAS checks answers against these).
        "contexts": [KNOWLEDGE["core"], *[d["text"] for d in docs]] if docs else [],
        "model": state.get("model", ""),
        "passed": bool(answer) and not missing and not forbidden,
        "retrieval_hit": case["url"] in [d["url"] for d in docs] if "url" in case else None,
        "why": [f"missing /{p}/" for p in missing] + [f"contains /{p}/" for p in forbidden],
    }


def percent(values: list[bool]) -> int:
    return round(100 * sum(values) / len(values)) if values else 100


async def main() -> int:
    cases = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))
    if sys.argv[1:]:
        cases = [c for c in cases if c["id"] in sys.argv[1:]]

    results = []
    for case in cases:
        result = check(case, await ask(case["q"]))
        results.append(result)
        rag = {True: "rag✓", False: "rag✗", None: "    "}[result["retrieval_hit"]]
        print(f"{'PASS' if result['passed'] else 'FAIL'}  {case['kind']:<9} {case['id']:<20} {rag}  {result['model']}  {' '.join(result['why'])}")
        await asyncio.sleep(DELAY_SECONDS)

    with open(HERE / "results.jsonl", "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in results)

    # model "none" = every free model was out of budget (e.g. a day of heavy testing): that question was never answered,
    # so it's skipped, not counted as wrong. With too few answers left there's nothing to judge: warn, don't fail.
    answered = [r for r in results if r["model"] != "none"]
    skipped = len(results) - len(answered)
    facts = percent([r["passed"] for r in answered if r["kind"] == "fact"])
    guards = percent([r["passed"] for r in answered if r["kind"] == "guardrail"])
    rag = percent([r["retrieval_hit"] for r in results if r["retrieval_hit"] is not None])
    print(f"\nRetrieval: {rag}%   Facts: {facts}% (target ≥ 90%)   Guardrails: {guards}% (target 100%)"
          + (f"   Skipped: {skipped} (no free model had capacity)" if skipped else ""))
    if len(answered) < len(results) / 2:
        print("::warning::Most questions got no answer — the free models' daily quotas are used up. Re-run after they reset.")
        return 0
    if unanswered := sum(r["model"] == "none" for r in results):
        print(f"INCONCLUSIVE: {unanswered} questions got no answer — every free model available here was out of quota, "
              "so these questions tested nothing. Re-run after the providers' daily reset.")
    return 0 if facts >= 90 and guards == 100 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
    sys.exit(asyncio.run(main()))
