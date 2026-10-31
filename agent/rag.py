"""Retrieval (the "R" in RAG).

    question ─┬─► FAISS  (meaning: embeddings) ─┐
              └─► BM25   (exact keywords)  ─────┴─► Reciprocal Rank Fusion ─► re-rank ─► top 4 chunks

The FAISS index and chunks are built by `python -m agent.build_index` and saved in agent/data/.
"""

import json
import re
from functools import lru_cache

import faiss
import httpx
import numpy as np
from langchain_openai import OpenAIEmbeddings
from rank_bm25 import BM25Okapi

from .config import DATA_DIR, env

STOPWORDS = set("a an and are about can did do does for from has have he him his how i in is it me of on or "
                "rishabh tell than that the their this to was what when where which who why with would you your".split())


def tokenize(text: str) -> list[str]:
    words = re.sub(r"[^a-z0-9+#.\- ]", " ", text.lower()).split()
    return [w for w in words if len(w) > 1 and w not in STOPWORDS]


@lru_cache
def embedder() -> OpenAIEmbeddings:
    """Gemini's free embedding model, called through its OpenAI-compatible API."""
    return OpenAIEmbeddings(
        model="gemini-embedding-001",
        dimensions=768,
        api_key=env("GOOGLE_GENERATIVE_AI_API_KEY", "missing"),
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        check_embedding_ctx_length=False,  # not an OpenAI model, so skip OpenAI's token counting
    )


def normalize(vectors: np.ndarray) -> np.ndarray:
    """Unit-length vectors, so FAISS inner product = cosine similarity."""
    vectors = np.asarray(vectors, dtype="float32")
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


@lru_cache
def load():
    """Loads chunks + FAISS index once per server instance, and builds the BM25 index in memory."""
    chunks = json.loads((DATA_DIR / "chunks.json").read_text(encoding="utf-8"))
    index = faiss.read_index(str(DATA_DIR / "index.faiss"))
    bm25 = BM25Okapi([tokenize(c["text"] + " " + " ".join(c["keywords"])) for c in chunks])
    return chunks, index, bm25


def reciprocal_rank_fusion(rankings: list[list[int]], k: int = 60) -> list[int]:
    """Merges ranked lists: each item scores sum(1 / (k + rank)). Items ranked high in both lists win."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0) + 1 / (k + rank + 1)
    return sorted(scores, key=scores.get, reverse=True)


async def search(query: str, k: int = 8) -> list[dict]:
    """Hybrid search: FAISS + BM25, fused with RRF. Returns up to k candidate chunks."""
    chunks, index, bm25 = load()

    dense: list[int] = []
    try:
        query_vector = normalize(await embedder().aembed_query(query)).reshape(1, -1)
        _, ids = index.search(query_vector, k)
        dense = [int(i) for i in ids[0] if i >= 0]
    except Exception as err:  # embedding API down → keyword search still works
        print(f"[rag] dense search skipped: {err}")

    scores = bm25.get_scores(tokenize(query))
    sparse = [int(i) for i in np.argsort(-scores)[:k] if scores[i] > 0]

    return [chunks[i] for i in reciprocal_rank_fusion([dense, sparse])[:k]]


async def rerank(query: str, docs: list[dict], top_n: int = 4) -> tuple[list[dict], str]:
    """Second-stage re-ranking with a cross-encoder (bge-reranker-base, free on Cloudflare Workers AI).

    A cross-encoder reads the question and each chunk together, so it judges relevance better than the
    first-stage search. Without Cloudflare keys (or if the call fails) we keep the RRF order.
    """
    account, token = env("CF_ACCOUNT_ID"), env("CF_WORKERS_AI_TOKEN")
    if not (account and token and docs):
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
