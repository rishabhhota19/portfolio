"""Writer bench: is a model good enough to be the one that WRITES the answers? Run before moving it up a pool.

    python -m evals.writer_bench groq-qwen groq-120b      # names from llm.M, compared question by question
    python -m evals.writer_bench nv-nemotron-super --limit 2   # a quick look: 2 recruiter cases and 2 facts

Each named model answers the recruiter cases (evals/advocacy.json) and a spread of the fact questions
(evals/questions.json) through the whole agent: retrieval, the research loop, the prompt and the output guard are the
live ones. Only the answer pools change, to that one model, so every answer is its own. The checks are the real evals'
(advocacy_eval.check, run_evals.check). The models take turns on each question, so no provider's per-minute limit
(Groq: 8,000 tokens a minute per model) is asked for two answers in a row. It reads and writes no baseline.

model_bench.py asks a model the fact questions directly; this one asks it to be Dumbledore.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

os.environ["ANSWER_BANK"] = "off"  # stored answers would hide the model
os.environ["ANSWER_CACHE"] = "off"

from langchain_core.messages import HumanMessage  # noqa: E402

from agent import graph, llm  # noqa: E402
from evals import advocacy_eval, run_evals  # noqa: E402

HERE = Path(__file__).parent
GAP_SECONDS = 22  # between two answers: with two models taking turns, each gets 44 s between its own
FACT_EVERY = 3  # every third fact question: the facts are the easy part, the recruiter cases are the judgement
POOLS = {level: list(tier.pool) for level, tier in llm.TIERS.items()}


def write_with(name: str | None) -> None:
    """Every level's answer pool becomes this one model (None: the real pools again). The planner's pool is untouched."""
    for level, tier in llm.TIERS.items():
        tier.pool[:] = [name] if name else POOLS[level]


async def answer(messages: list) -> tuple[dict, float]:
    started = time.perf_counter()
    state = await graph.agent.ainvoke({"messages": messages})
    if state.get("model") in graph.UNANSWERED:  # the model's minute is full: wait it out once, as run_evals does
        await asyncio.sleep(35)
        started = time.perf_counter()
        state = await graph.agent.ainvoke({"messages": messages})
    return state, time.perf_counter() - started


def judge(kind: str, case: dict, state: dict) -> list[str]:
    """Why this answer fails its case, by the real evals' rules ([] = it passes)."""
    last = state["messages"][-1]
    text = last.content if last.type == "ai" else ""
    if state.get("model") in graph.UNANSWERED or not text:
        return ["no answer"]
    if kind == "fact":
        return run_evals.check(case, state)["why"]
    links = [l for a in state.get("actions", []) if a.get("type") == "links" for l in a.get("links", [])]
    links += [a for a in state.get("actions", []) if a.get("type") == "navigate"]
    return advocacy_eval.check(case, text, links)


async def main() -> int:
    args = sys.argv[1:]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    names = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--limit")]
    if unknown := [n for n in names if n not in llm.M]:
        print(f"Not in agent/llm.py: {', '.join(unknown)}")
        return 1
    if missing := [n for n in names if not llm.M[n].available]:
        print(f"No API key here for: {', '.join(missing)}")
        return 1
    if not names:
        print(__doc__)
        return 1

    recruiter = json.loads((HERE / "advocacy.json").read_text(encoding="utf-8"))[:limit]
    facts = [c for c in json.loads((HERE / "questions.json").read_text(encoding="utf-8")) if c["kind"] == "fact"][::FACT_EVERY][:limit]
    cases = [("recruiter", c, advocacy_eval.conversation(c)) for c in recruiter] + [("fact", c, [HumanMessage(c["q"])]) for c in facts]
    rows: dict[str, list[dict]] = {n: [] for n in names}
    first = True
    try:
        for kind, case, messages in cases:
            for name in names:
                if not first:
                    await asyncio.sleep(GAP_SECONDS)
                first = False
                write_with(name)
                state, seconds = await answer(messages)
                why = judge(kind, case, state)
                last = state["messages"][-1]
                words = len(last.content.split()) if last.type == "ai" else 0
                used = state.get("usage") or {}
                rows[name].append({"kind": kind, "id": case["id"], "ok": not why, "why": why, "seconds": seconds, "words": words,
                                   "by": state.get("model", ""), "tokens": used.get("tokens_in", 0) + used.get("tokens_out", 0)})
                print(f"{'ok  ' if not why else 'FAIL'} {kind:<9} {case['id']:<16} {name:<20} {seconds:4.1f}s {words:>3}w  {'; '.join(why)[:150]}",
                      flush=True)
    finally:
        write_with(None)

    median = lambda values: sorted(values)[len(values) // 2] if values else 0  # noqa: E731
    print(f"\n{'model':<22} {'recruiter':>10} {'facts':>7} {'no answer':>10} {'median s':>9} {'median words':>13} {'tokens':>8}")
    for name, results in rows.items():
        got = [r for r in results if r["why"] != ["no answer"]]
        share = lambda kind: f"{sum(r['ok'] for r in results if r['kind'] == kind)}/{sum(r['kind'] == kind for r in results)}"  # noqa: E731
        print(f"{name:<22} {share('recruiter'):>10} {share('fact'):>7} {len(results) - len(got):>10} {median([r['seconds'] for r in got]):>9.1f} "
              f"{median([r['words'] for r in got]):>13} {sum(r['tokens'] for r in results):>8}")
    stray = sorted({r["by"] for name, results in rows.items() for r in results if r["by"] not in ("none", "", llm.M[name].name)})
    if stray:  # the pools were pinned, so this means a canned or refused reply: worth knowing, not a failure of the bench
        print(f"\nAnswers not written by the named model came from: {', '.join(stray)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
