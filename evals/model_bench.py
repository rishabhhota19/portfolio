"""Model bench: is a free model good enough for the routing tree? Run before adding one to a pool in agent/llm.py.

    python -m evals.model_bench cf-qwen3-a3b cf-granite      # names from llm.M

Asks every fact question in evals/questions.json through the real retrieval and Dumbledore's prompt, with only that
model, and reports the share of answers with the right facts, the median latency and the tokens used. As a rule of
thumb a pool model should score within ~10 points of the model before it.
"""

import asyncio
import json
import re
import sys
import time
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage

from agent import llm
from agent.prompts import system_prompt
from agent.rag import search

SMART_QUOTES = str.maketrans("‘’“”", "''\"\"")


async def bench(name: str, cases: list[dict]) -> None:
    m, passed, times, tokens = llm.M[name], 0, [], 0
    for case in cases:
        docs, _ = await search(case["q"])
        prompt = [SystemMessage(system_prompt(docs[:4])), HumanMessage(case["q"])]
        started = time.perf_counter()
        try:
            reply = await m.client(350, timeout=30).ainvoke(prompt)
        except Exception as err:
            print(f"  error on {case['id']}: {type(err).__name__}")
            continue
        times.append(time.perf_counter() - started)
        tokens += sum(llm.tokens_used(reply)[:2])
        text = reply.text.translate(SMART_QUOTES)
        ok = all(re.search(p, text, re.I) for p in case.get("include", [])) and not any(re.search(p, text, re.I) for p in case.get("exclude", []))
        passed += ok
        await asyncio.sleep(1)
    median = sorted(times)[len(times) // 2] if times else 0
    print(f"{name:<16} facts {passed}/{len(cases)} ({passed / len(cases):.0%})   median {median:.1f}s   {tokens} tokens")


async def main() -> None:
    cases = [c for c in json.loads((Path(__file__).parent / "questions.json").read_text(encoding="utf-8")) if c["kind"] == "fact"]
    for name in sys.argv[1:] or ["cf-qwen3-a3b", "cf-granite"]:
        await bench(name, cases)


if __name__ == "__main__":
    asyncio.run(main())
