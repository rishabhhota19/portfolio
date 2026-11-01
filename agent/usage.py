"""Token and request tracking for the free models — shared by every server instance.

For each model we count requests and tokens per minute and per day. The backend checks these counts before
calling a model (to stay inside its free-tier limits) and records them after. With Upstash Redis configured
the counts are shared by all servers, so when every free model is used up the chat pauses for everyone,
and resumes on its own when the limits reset. Without Redis (local dev) the counts live in memory.
"""

import time

from .config import env

TTL = {"min": 120, "day": 2 * 86400}
_memory: dict[str, tuple[int, float]] = {}  # key -> (value, expires_at)
_redis = None


def _client():
    global _redis
    if _redis is None:
        url = env("UPSTASH_REDIS_REST_URL") or env("KV_REST_API_URL")
        token = env("UPSTASH_REDIS_REST_TOKEN") or env("KV_REST_API_TOKEN")
        if url and token:
            from upstash_redis.asyncio import Redis

            _redis = Redis(url=url, token=token)
        else:
            _redis = False
    return _redis or None


def _keys(name: str) -> dict[str, str]:
    minute, day = int(time.time() // 60), time.strftime("%Y-%m-%d", time.gmtime())
    return {
        "req_min": f"use:{name}:req:{minute}",
        "tok_min": f"use:{name}:tok:{minute}",
        "req_day": f"use:{name}:req:{day}",
        "tok_day": f"use:{name}:tok:{day}",
        "paused": f"paused:{name}",
    }


async def get(name: str) -> dict[str, int]:
    """Current usage for a model (or provider): requests/tokens this minute and today, and a pause flag."""
    keys = _keys(name)
    redis = _client()
    if redis:
        try:
            values = await redis.mget(*keys.values())
            return {k: int(v or 0) for k, v in zip(keys, values)}
        except Exception as err:
            print(f"[usage] redis read failed, using memory: {err}")
    now = time.time()
    return {k: (v if exp > now else 0) for k, (v, exp) in ((k, _memory.get(key, (0, 0))) for k, key in keys.items())}


async def record(name: str, tokens: int) -> None:
    """Adds one request and `tokens` tokens to this minute's and today's counters."""
    keys = _keys(name)
    adds = [(keys["req_min"], 1, TTL["min"]), (keys["tok_min"], tokens, TTL["min"]),
            (keys["req_day"], 1, TTL["day"]), (keys["tok_day"], tokens, TTL["day"])]
    redis = _client()
    if redis:
        try:
            pipe = redis.pipeline()
            for key, amount, ttl in adds:
                pipe.incrby(key, amount)
                pipe.expire(key, ttl)
            await pipe.exec()
            return
        except Exception as err:
            print(f"[usage] redis write failed, using memory: {err}")
    now = time.time()
    for key, amount, ttl in adds:
        value, exp = _memory.get(key, (0, 0))
        _memory[key] = (value + amount if exp > now else amount, exp if exp > now else now + ttl)


# ── Per-visit totals (one visit = one browser tab on the site; the Sessions sheet shows them) ──

SESSION_TTL = 2 * 86400
_sessions: dict[str, dict[str, int]] = {}  # memory fallback: "sess:<id>" and "sess:<id>:models" -> counts


async def add_to_session(session_id: str, counts: dict[str, int], model: str = "") -> None:
    """Adds one LLM call's numbers (tokens, latency, switches…) to a visit's running totals."""
    if not session_id:
        return
    key, models = f"sess:{session_id}", f"sess:{session_id}:models"
    redis = _client()
    if redis:
        try:
            pipe = redis.pipeline()
            for field, amount in counts.items():
                pipe.hincrby(key, field, amount)
            if model:
                pipe.hincrby(models, model, 1)
            pipe.expire(key, SESSION_TTL)
            pipe.expire(models, SESSION_TTL)
            await pipe.exec()
            return
        except Exception as err:
            print(f"[usage] redis write failed, using memory: {err}")
    totals = _sessions.setdefault(key, {})
    for field, amount in counts.items():
        totals[field] = totals.get(field, 0) + amount
    if model:
        per_model = _sessions.setdefault(models, {})
        per_model[model] = per_model.get(model, 0) + 1


async def session(session_id: str) -> tuple[dict[str, int], dict[str, int]]:
    """A visit's totals, and how many answers each model gave."""
    key, models = f"sess:{session_id}", f"sess:{session_id}:models"
    redis = _client()
    if redis:
        try:
            totals, per_model = await redis.hgetall(key), await redis.hgetall(models)
            return {k: int(v) for k, v in (totals or {}).items()}, {k: int(v) for k, v in (per_model or {}).items()}
        except Exception as err:
            print(f"[usage] redis read failed, using memory: {err}")
    return dict(_sessions.get(key, {})), dict(_sessions.get(models, {}))


async def pause(name: str, seconds: int) -> None:
    """Skips a model for a while (e.g. after the provider says it's rate-limited)."""
    key = _keys(name)["paused"]
    redis = _client()
    if redis:
        try:
            await redis.set(key, 1, ex=seconds)
            return
        except Exception as err:
            print(f"[usage] redis write failed, using memory: {err}")
    _memory[key] = (1, time.time() + seconds)
