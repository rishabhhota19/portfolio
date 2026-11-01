"""Groq smoke test (CI): one real question on each Groq model the site leans on — a broken key or code path fails.

    python -m evals.groq_smoke

CI leaves Groq out of the full evals because they share the site's key, and Groq's free tier is 200,000 tokens per
model per day (a full run would spend most of it). Two questions use ~5,000 tokens: ~1% of each model's day.
If Groq is only rate-limited (visitors used today's quota), that's a warning, not a failure.
"""

import asyncio
import re
import sys

from langchain_core.messages import HumanMessage, SystemMessage

from agent import llm
from agent.prompts import system_prompt
from agent.rag import search

CHECKS = {"groq-20b": ("Where did he study?", r"B\.?\s?M\.?\s?S"), "groq-120b": ("What is Rishabh's current role?", r"Simplilearn")}


async def main() -> int:
    if not llm.M["groq-20b"].available:
        print("GROQ_API_KEY is not set")
        return 1
    failed = 0
    for name, (question, expect) in CHECKS.items():
        docs, _ = await search(question)
        try:
            reply = await llm.M[name].client(300, timeout=30).ainvoke([SystemMessage(system_prompt(docs[:4])), HumanMessage(question)])
        except Exception as err:
            status = getattr(err, "status_code", None)
            if status == 429:
                print(f"WARN  {name}: rate-limited (visitors used today's free quota) — the key works")
                continue
            print(f"FAIL  {name}: {status or type(err).__name__}")
            failed += 1
            continue
        ok = bool(re.search(expect, reply.text, re.I))
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {question!r} → {reply.text[:80]!r}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
