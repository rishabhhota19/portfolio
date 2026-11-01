"""Answer cache for repeated first questions (L0): instant, costs no tokens, and still works when every model is busy.

Only a conversation's *first* question is cached (later ones depend on the chat so far), for a day. The key includes
a hash of the site's content, so editing the content starts a fresh cache automatically.
"""

import hashlib
import json
import re
import time

from .prompts import KNOWLEDGE
from .usage import _client as redis_client

TTL = 86_400
VERSION = hashlib.sha1(json.dumps(KNOWLEDGE, sort_keys=True).encode()).hexdigest()[:10]
_memory: dict[str, tuple[str, float]] = {}


def _key(question: str) -> str:
    words = " ".join(re.sub(r"[^a-z0-9 ]+", " ", question.lower()).split())  # "Where did he study??" = "where did he study"
    return f"ans:{VERSION}:{hashlib.sha1(words.encode()).hexdigest()[:16]}"


async def get(question: str) -> str | None:
    key, redis = _key(question), redis_client()
    if redis:
        try:
            return await redis.get(key)
        except Exception as err:
            print(f"[cache] redis read failed: {err}")
    hit = _memory.get(key)
    return hit[0] if hit and hit[1] > time.time() else None


async def put(question: str, answer: str) -> None:
    key, redis = _key(question), redis_client()
    if redis:
        try:
            await redis.set(key, answer, ex=TTL)
            return
        except Exception as err:
            print(f"[cache] redis write failed: {err}")
    _memory[key] = (answer, time.time() + TTL)
