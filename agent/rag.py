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
    """EmbeddingGemma (768-dim, multilingual) on Cloudflare Workers AI, through its OpenAI-compatible API.

    Free: a question costs a tiny fraction of a neuron (10,000 a day). It replaced Gemini's embedding API, whose free
    tier stops at 1,000 requests a day — one per chat question. Chosen on this site's evals (evals/scope.json):
    same retrieval hit rate as the others tried, and the cleanest split between on-topic and off-topic questions.
    """
    return OpenAIEmbeddings(
        model="@cf/google/embeddinggemma-300m",
        api_key=env("CF_WORKERS_AI_TOKEN", "missing"),
        base_url=f"https://api.cloudflare.com/client/v4/accounts/{env('CF_ACCOUNT_ID')}/ai/v1",
        check_embedding_ctx_length=False,  # not an OpenAI model, so skip OpenAI's token counting
        chunk_size=50,  # texts per request
        timeout=5,  # a slow call mustn't stall the chat: without an embedding, keyword search still answers
        max_retries=1,
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


async def embed(texts: list[str]) -> np.ndarray | None:
    """Unit vectors for the texts in one API call, or None if the embedding API is down (keyword search still works)."""
    try:
        return normalize(await embedder().aembed_documents(texts))
    except Exception as err:
        print(f"[rag] embedding skipped: {err}")
        return None


async def search(query: str, vector: np.ndarray | None = None, k: int = 8) -> tuple[list[dict], float]:
    """Hybrid search: FAISS + BM25, fused with RRF. Returns up to k candidate chunks, and how close the best one is
    in meaning (cosine 0–1; the scope check uses it). Pass `vector` if the query is already embedded."""
    chunks, index, bm25 = load()
    if vector is None and (vectors := await embed([query])) is not None:
        vector = vectors[0]

    dense: list[int] = []
    relevance = 0.0
    if vector is not None:
        scores, ids = index.search(vector.reshape(1, -1).astype("float32"), k)
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
