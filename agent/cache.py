"""L0 answers — instant, no LLM tokens, and still working when every model is busy. Two kinds, first questions only
(later ones depend on the chat so far):

  - exact cache (Redis, a day): the same question again, word for word. Only answers that passed every gate are put
    here (graph.py, Gate 5), so a bad answer can't be repeated to the next visitor.
  - answer bank (agent/data/answers.*, built by `python -m agent.build_answers`): common questions asked any way at
    all. Each canonical question has paraphrases; a new question whose embedding is clearly nearest one intent gets
    its answer — written by the agent and checked against the evals before it went in.

Both are keyed to a hash of the site's content, so editing the content retires old answers automatically.
"""

import hashlib
import json
import re
import time
from functools import lru_cache

import numpy as np

from .config import DATA_DIR, KNOWLEDGE, env
from .embeddings import MODEL
from .usage import _client as redis_client

TTL = 86_400
VERSION = hashlib.sha1(json.dumps(KNOWLEDGE, sort_keys=True).encode()).hexdigest()[:10]
_memory: dict[str, tuple[str, float]] = {}

# ── exact cache ─────────────────────────────────────────────────────────────


def _key(question: str) -> str:
    words = " ".join(re.sub(r"[^a-z0-9 ]+", " ", question.lower()).split())  # "Where did he study??" = "where did he study"
    return f"ans:v2:{VERSION}:{hashlib.sha1(words.encode()).hexdigest()[:16]}"


async def get(question: str) -> dict | None:
    """{"text": answer, "links": [...]} or None."""
    key, redis, raw = _key(question), redis_client(), None
    if redis:
        try:
            raw = await redis.get(key)
        except Exception as err:
            print(f"[cache] redis read failed: {err}")
    if raw is None and (hit := _memory.get(key)) and hit[1] > time.time():
        raw = hit[0]
    return json.loads(raw) if raw else None


async def put(question: str, text: str, links: list[dict]) -> None:
    key, redis, raw = _key(question), redis_client(), json.dumps({"text": text, "links": links})
    if redis:
        try:
            await redis.set(key, raw, ex=TTL)
            return
        except Exception as err:
            print(f"[cache] redis write failed: {err}")
    _memory[key] = (raw, time.time() + TTL)


# ── answer bank ─────────────────────────────────────────────────────────────

MIN_SCORE = 0.90  # nearest paraphrase must be this similar (cosine) …
MIN_LEAD = 0.05  # … and this much closer than any other intent (bge-small: 56% of unseen paraphrases served, 0 wrong)


@lru_cache
def bank() -> tuple[np.ndarray, np.ndarray, list[dict]] | None:
    meta, vecs = DATA_DIR / "answers.json", DATA_DIR / "answers.npz"
    if env("ANSWER_BANK") == "off" or not (meta.exists() and vecs.exists()):
        return None
    info = json.loads(meta.read_text(encoding="utf-8"))
    if info["version"] != VERSION or info.get("model") != MODEL:
        return None  # built for older content, or with another embedding model: don't serve it
    with np.load(vecs) as data:
        return data["vectors"], data["intent"], info["intents"]


def from_bank(vector: np.ndarray | None) -> dict | None:
    """The bank's answer if the question is clearly one of its intents, else None."""
    loaded = bank()
    if vector is None or loaded is None:
        return None
    vectors, owner, intents = loaded
    sims = vectors @ vector
    best = np.full(len(intents), -1.0)
    np.maximum.at(best, owner, sims)  # each intent's closest paraphrase
    first, second = np.argsort(-best)[:2]
    if best[first] >= MIN_SCORE and best[first] - best[second] >= MIN_LEAD:
        return {**intents[first], "score": round(float(best[first]), 3)}
    return None
