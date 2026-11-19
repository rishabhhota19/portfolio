"""Does the second vote (agent/reranker.py) help or hurt? Retrieval only, no LLM calls, no keys:

    python -m evals.rerank_ab

For every question in questions.json with an expected page, at the depth the writer reads (2 / 4 / 6 chunks by the
question's level), compares the first stage alone (the vectors' order, rag.search) with the vote (rag.rerank):
  hit   is a chunk from the expected page among the chunks the writer reads? (the rule run_evals uses)
  MRR   1 / rank of the first chunk from that page in the 6 kept — rewards putting it first
and times the vote. Fails if the vote leaves the writer fewer hits than the first stage alone — the day the
cross-encoder starts overruling a clear first stage, CI says so — or if the keyword fallback (BM25, what answers when
nothing can embed the question) finds no page at all. MRR is reported, not enforced: the vote may swap two chunks the
writer reads anyway.

19 Nov 2026 (M1, 25 questions: 14 naming a page, 10 about a whole section, one LCSNet cross-check): first stage and vote
both 25/25 at the writer's depth; MRR@6 0.933 and 0.913 — the vote put the research-to-prototype service above the
publications page on "what papers has he published", both of which the writer reads; 37 ms a question; keyword
fallback 21/25.
"""

import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

from agent import embeddings, llm, rag
from agent.difficulty import difficulty

HERE = Path(__file__).parent


def depth(question: str) -> int:
    return min(llm.TIERS[difficulty(question)].chunks, 6)


def rank_of(url: str, docs: list[dict]) -> int | None:
    return next((i + 1 for i, d in enumerate(docs) if d["url"] == url), None)


async def _no_embedding(texts: list[str]):
    return None, None


async def main() -> int:
    cases = [c for c in json.loads((HERE / "questions.json").read_text(encoding="utf-8")) if "url" in c]
    rows, times = [], []
    for case in cases:
        question, n = case["q"], depth(case["q"])
        first, _ = await rag.search(question)  # the vectors' order, 8 chunks
        started = time.perf_counter()
        voted, how = await rag.rerank(question, first)
        times.append((time.perf_counter() - started) * 1000)
        if how != "voted":
            raise SystemExit("The second vote did not run: is agent/data/reranker/model_quantized.onnx there?")
        a, b = rank_of(case["url"], first[:6]), rank_of(case["url"], voted)
        rows.append((n, a, b))
        change = "" if a == b else ("  better" if (b or 9) < (a or 9) else "  worse")
        moved = "" if [d["id"] for d in first[:6]] == [d["id"] for d in voted] else "  (order changed)"
        print(f"{case['id']:<20} reads {n}  first={a or '-'}  vote={b or '-'}{change}{moved}")

    hits = lambda i: sum(1 for n, *r in rows if r[i] and r[i] <= n)  # noqa: E731
    mrr = lambda i: statistics.mean(1 / r[i] if r[i] else 0.0 for _, *r in rows)  # noqa: E731
    print(f"\nat the writer's depth: first stage {hits(0)}/{len(rows)}, vote {hits(1)}/{len(rows)}")
    print(f"MRR@6: first stage {mrr(0):.3f}, vote {mrr(1):.3f}; the vote took {statistics.median(times):.0f} ms a question (median)")

    embed, embeddings.embed = embeddings.embed, _no_embedding  # every embedding route down: keyword search answers
    try:
        fallback = 0
        for case in cases:
            found, _ = await rag.search(case["q"])
            fallback += bool(rank_of(case["url"], found[: depth(case["q"])]))
    finally:
        embeddings.embed = embed
    print(f"keyword fallback (BM25, nothing could embed the question): {fallback}/{len(rows)} at the writer's depth")

    if hits(1) < hits(0):
        print("::error::The second vote leaves the writer fewer right chunks than the first stage alone — re-measure before shipping it (agent/reranker.py)")
        return 1
    if not fallback:
        print("::error::The keyword fallback found no page at all")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
