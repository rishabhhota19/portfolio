"""Retrieval (the "R" in RAG).

    question ─┬─► FAISS  (meaning: embeddings) ─┐
              └─► BM25   (exact keywords)  ─────┴─► Reciprocal Rank Fusion ─► re-rank ─► top 4 chunks

The chunks (agent/data/chunks.json) and one FAISS index per embedding engine (agent/data/embeddings/<engine>/) are
built by `python -m agent.build_index`. Which engine embeds a question is decided in embeddings.py.
"""

import json
import re
from functools import lru_cache

import faiss
import httpx
import numpy as np
from rank_bm25 import BM25Okapi

from . import embeddings
from .config import DATA_DIR, env
from .embeddings import Engine

STOPWORDS = set("a an and are about can did do does for from has have he him his how i in is it me of on or "
                "rishabh tell than that the their this to was what when where which who why with would you your".split())


def tokenize(text: str) -> list[str]:
    words = re.sub(r"[^a-z0-9+#.\- ]", " ", text.lower()).split()
    return [w for w in words if len(w) > 1 and w not in STOPWORDS]


@lru_cache
def load():
    """Loads the chunks once per server instance, and builds the BM25 index in memory."""
    chunks = json.loads((DATA_DIR / "chunks.json").read_text(encoding="utf-8"))
    bm25 = BM25Okapi([tokenize(c["text"] + " " + " ".join(c["keywords"])) for c in chunks])
    return chunks, bm25


@lru_cache
def index_for(engine: Engine):
    """That engine's FAISS index (inner product on unit vectors = cosine similarity), loaded once."""
    return faiss.read_index(str(engine.folder / "index.faiss"))


def reciprocal_rank_fusion(rankings: list[list[int]], k: int = 60) -> list[int]:
    """Merges ranked lists: each item scores sum(1 / (k + rank)). Items ranked high in both lists win."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0) + 1 / (k + rank + 1)
    return sorted(scores, key=scores.get, reverse=True)


async def search(query: str, engine: Engine | None = None, vector: np.ndarray | None = None, k: int = 8) -> tuple[list[dict], float]:
    """Hybrid search: FAISS + BM25, fused with RRF. Returns up to k candidate chunks, and how close the best one is
    in meaning (cosine 0–1; the scope check uses it). Pass `engine` + `vector` if the query is already embedded;
    with no engine at all (every one down), it's keyword search only."""
    chunks, bm25 = load()
    if vector is None:
        engine, vectors = await embeddings.embed([query])
        vector = None if vectors is None else vectors[0]

    dense: list[int] = []
    relevance = 0.0
    if vector is not None and engine is not None:
        scores, ids = index_for(engine).search(vector.reshape(1, -1).astype("float32"), k)
        dense = [int(i) for i in ids[0] if i >= 0]
        relevance = float(scores[0][0]) if dense else 0.0

    scores = bm25.get_scores(tokenize(query))
    sparse = [int(i) for i in np.argsort(-scores)[:k] if scores[i] > 0]

    return [chunks[i] for i in reciprocal_rank_fusion([dense, sparse])[:k]], relevance


async def rerank(query: str, docs: list[dict], top_n: int = 4) -> tuple[list[dict], str]:
    """Second-stage re-ranking with a cross-encoder (bge-reranker-base, free on Cloudflare Workers AI).

    A cross-encoder reads the question and each chunk together, so it judges relevance better than the
    first-stage search. Unless it's switched on (or if the call fails) we keep the RRF order.
    """
    # Opt-in (RERANKER=bge): on this site's evals it didn't beat RRF, so production keeps the RRF order.
    account, token = env("CF_ACCOUNT_ID"), env("CF_WORKERS_AI_TOKEN")
    if env("RERANKER") != "bge" or not (account and token and docs):
        return docs[:top_n], "rrf"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.post(
                f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/baai/bge-reranker-base",
                headers={"Authorization": f"Bearer {token}"},
                json={"query": query, "contexts": [{"text": d["text"]} for d in docs], "top_k": top_n},
            )
        res.raise_for_status()
        ranked = res.json()["result"]["response"]  # [{"id": position, "score": relevance}, ...]
        return [docs[r["id"]] for r in ranked][:top_n], "bge-reranker"
    except Exception as err:
        print(f"[rag] re-rank skipped: {err}")
        return docs[:top_n], "rrf"
