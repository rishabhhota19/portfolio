"""Does the cross-encoder re-ranker beat plain RRF order? Retrieval only, no LLM calls:

    python -m evals.rerank_ab      (needs CF_ACCOUNT_ID + CF_WORKERS_AI_TOKEN)

For every question in questions.json with an expected page, compares the top 4 chunks (what the LLM sees):
  hit@4   is a chunk from the expected page in the top 4? (same rule as run_evals)
  MRR@4   1 / rank of the first chunk from that page — rewards putting it first

Last run (Nov 2026, 13 questions): hit@4 100% for both, MRR@4 RRF 0.962 vs bge-reranker 0.885,
so production keeps the RRF order (the re-ranker switches on only when the Cloudflare keys are set).
"""

import asyncio
import json
from pathlib import Path

from agent.rag import rerank, search

HERE = Path(__file__).parent


def rank_of(url: str, docs: list[dict]) -> int | None:
    return next((i + 1 for i, d in enumerate(docs) if d["url"] == url), None)


async def main() -> None:
    cases = [c for c in json.loads((HERE / "questions.json").read_text(encoding="utf-8")) if "url" in c]
    rows = []
    for case in cases:
        docs = await search(case["q"])
        reranked, how = await rerank(case["q"], docs)
        if how != "bge-reranker":
            raise SystemExit("Re-ranker unavailable: set CF_ACCOUNT_ID and CF_WORKERS_AI_TOKEN.")
        rrf, bge = rank_of(case["url"], docs[:4]), rank_of(case["url"], reranked)
        rows.append((rrf, bge))
        change = "" if rrf == bge else ("  better" if (bge or 9) < (rrf or 9) else "  worse")
        print(f"{case['id']:<20} rrf={rrf or '-'}  bge={bge or '-'}{change}")

    hit = lambda i: sum(1 for r in rows if r[i]) / len(rows)
    mrr = lambda i: sum(1 / r[i] for r in rows if r[i]) / len(rows)
    print(f"\nhit@4  rrf={hit(0):.0%}  bge={hit(1):.0%}")
    print(f"MRR@4  rrf={mrr(0):.3f}  bge={mrr(1):.3f}   ({len(rows)} questions)")


if __name__ == "__main__":
    asyncio.run(main())
