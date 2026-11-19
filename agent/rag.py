"""Retrieval (the "R" in RAG).

    question ─► vectors (meaning: embeddings) ─► the 8 closest chunks ─► second vote (reranker.py) ─► top 6 (the level takes 2 / 4 / 6)
             └► BM25 (exact keywords): the fallback, only when the question could not be embedded at all

The chunks (agent/data/chunks.json) and their vectors (agent/data/embeddings/index.npy) are built by
`python -m agent.build_index`. How a question gets embedded (and what happens if it can't be) is in embeddings.py.

Until 19 Nov 2026 BM25's order was fused with the vectors' on every question (Reciprocal Rank Fusion). Measured on 24
questions — 10 about a whole section, 14 naming one page — at the depth the writer reads: BM25 pulled keyword collisions
up ("research" found the research-to-prototype service and the News Research Tool before the papers) and the fusion
ranked worse than the vectors alone (the right section in the writer's chunks 8/10 against 10/10; MRR on the named pages
0.964 against 1.000). On 17 rare exact names (RBKnee, Nagarbhavi, Unsloth) the two tied. So BM25 is the fallback, not a
voter; the second vote is a cross-encoder's (reranker.py). evals/rerank_ab.py re-measures both.

The vector search is exact cosine similarity in NumPy: one matrix product over the site's chunks. It was a FAISS
flat index (IndexFlatIP), which computes the same thing; evals/index_eval.py checks, on every eval question, that
the two return the same chunks in the same order. FAISS is 66 MB installed, and with it the function was over the
size at which Vercel stopped bundling packages and installed them on every cold start instead (15 Nov 2026).
"""

import json
import re
from functools import lru_cache

import numpy as np
from rank_bm25 import BM25Okapi

from . import embeddings, reranker
from .config import DATA_DIR

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
def index() -> np.ndarray:
    """The chunks' unit vectors, one row each, loaded once (inner product on unit vectors = cosine similarity)."""
    return np.load(embeddings.INDEX)


def nearest(vector: np.ndarray, k: int) -> tuple[list[int], list[float]]:
    """The k chunks closest in meaning to this unit vector, best first, and how close each is."""
    scores = index() @ vector.astype("float32").reshape(-1)
    top = np.argsort(-scores, kind="stable")[:k]
    return [int(i) for i in top], [float(scores[i]) for i in top]


def reciprocal_rank_fusion(rankings: list[list[int]], k: int = 60, weights: tuple[float, ...] | None = None) -> list[int]:
    """Merges ranked lists: each item scores sum(weight / (k + rank)). Items ranked high in both lists win; a weight
    says how much one list's opinion counts (the second vote gives the first stage 2 and the cross-encoder 1)."""
    scores: dict[int, float] = {}
    for n, ranking in enumerate(rankings):
        weight = weights[n] if weights else 1.0
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0) + weight / (k + rank + 1)
    return sorted(scores, key=scores.get, reverse=True)


async def search(query: str, vector: np.ndarray | None = None, k: int = 8) -> tuple[list[dict], float]:
    """The first stage: the k chunks closest in meaning to the question, best first, and how close the best one is
    (cosine 0–1; the scope check uses it). Pass `vector` if the question is already embedded. When it cannot be
    embedded at all (every route in embeddings.py down), keyword search (BM25) answers instead, with closeness 0."""
    chunks, bm25 = load()
    if vector is None:
        _, vectors = await embeddings.embed([query])
        vector = None if vectors is None else vectors[0]
    if vector is not None:
        top, closeness = nearest(vector, k)
        return [chunks[i] for i in top], (closeness[0] if top else 0.0)
    scores = bm25.get_scores(tokenize(query))
    return [chunks[int(i)] for i in np.argsort(-scores)[:k] if scores[i] > 0], 0.0


async def rerank(query: str, docs: list[dict], top_n: int = 6) -> tuple[list[dict], str]:
    """The second vote: the cross-encoder's order of these chunks (reranker.py) fused with the first stage's, the first
    stage counting double — measured, that breaks near-ties without ever costing a rank 1. Returns the top_n chunks and
    whose order it is: "voted", or "first-stage" when the model cannot run."""
    second = await reranker.order(query, [d["text"] for d in docs])
    if second is None:
        return docs[:top_n], "first-stage"
    fused = reciprocal_rank_fusion([list(range(len(docs))), second], weights=(2, 1))
    return [docs[i] for i in fused[:top_n]], "voted"
