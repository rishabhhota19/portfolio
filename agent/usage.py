"""Free-tier budgets, shared by every server instance (Upstash Redis; process memory when running locally).

The key idea: *reserve, then call*. Before calling a model, one atomic Redis script checks every limit that applies
(requests and tokens per minute, per hour and per day, plus the provider's shared pool) and — only if all of them
have room — counts the call. Ten visitors asking in the same second therefore each get a model that really has
room, instead of all hitting the same one and getting rate-limited. After the call, the reservation is corrected
to the real token count the provider reported (or refunded if the call failed).
"""

import math
import time
from dataclasses import dataclass

from .config import env
from .llm import PACE, PROVIDER_LIMITS, FreeModel

DAY_TTL, HOUR_TTL, MINUTE_TTL, SESSION_TTL = 2 * 86400, 7200, 120, 2 * 86400

# Reserve: KEYS[1] model pause flag, KEYS[2] provider pause flag, KEYS[3..] counters; ARGV = amount, limit, ttl per counter.
# Returns 1 = reserved, 0 = paused, n >= 3 = the counter (1-based key index) that had no room.
RESERVE = """
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
for i = 3, #KEYS do
  local amount, limit = tonumber(ARGV[(i - 3) * 3 + 1]), tonumber(ARGV[(i - 3) * 3 + 2])
  if limit > 0 and tonumber(redis.call('GET', KEYS[i]) or '0') + amount > limit then return i end
end
for i = 3, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[(i - 3) * 3 + 1])
  redis.call('EXPIRE', KEYS[i], ARGV[(i - 3) * 3 + 3])
end
return 1
"""
# Adjust: add ARGV[i] (may be negative) to KEYS[i] — corrects a reservation to the real usage, or refunds it.
# Counters that already expired are left alone (so nothing is re-created without an expiry).
ADJUST = "for i = 1, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], ARGV[i]) end end return 1"
# Raise: KEYS[i] = max(KEYS[i], value) — syncs a counter to the provider's own count (never lowers it).
# ARGV = value, ttl for each key.
RAISE = """
for i = 1, #KEYS do
  local cur, want = tonumber(redis.call('GET', KEYS[i]) or '0'), tonumber(ARGV[i * 2 - 1])
  if cur < want then redis.call('INCRBY', KEYS[i], want - cur) redis.call('EXPIRE', KEYS[i], ARGV[i * 2]) end
end
return 1
"""
# Session: HINCRBY KEYS[1] for each field/amount pair; one answer per model in KEYS[2]. ARGV = ttl, model, f1, a1, ...
SESSION = """
for i = 3, #ARGV, 2 do redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1]) end
if ARGV[2] ~= '' then redis.call('HINCRBY', KEYS[2], ARGV[2], 1) end
redis.call('EXPIRE', KEYS[1], ARGV[1]) redis.call('EXPIRE', KEYS[2], ARGV[1])
return 1
"""

_memory: dict[str, tuple[int, float]] = {}  # key -> (value, expires_at)
_hashes: dict[str, dict[str, int]] = {}
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


async def _run(script: str, keys: list[str], args: list) -> int | None:
    """Runs a script on Redis; None if Redis isn't configured or failed (the caller falls back to memory)."""
    redis = _client()
    if not redis:
        return None
    try:
        return int(await redis.eval(script, keys=keys, args=[str(a) for a in args]))
    except Exception as err:
        print(f"[usage] redis failed, using memory: {err}")
        return None


def _get(key: str) -> int:
    value, expires = _memory.get(key, (0, 0))
    return value if expires > time.time() else 0


def _add(key: str, amount: int, ttl: int = DAY_TTL, create: bool = True) -> None:
    value, expires = _memory.get(key, (0, 0))
    alive = expires > time.time()
    if alive or create:
        _memory[key] = ((value if alive else 0) + amount, expires if alive else time.time() + ttl)


# ── reserve → call → settle ─────────────────────────────────────────────────

@dataclass
class Reservation:
    keys: list[str]
    amounts: list[int]
    token_keys: list[int]  # positions of the token counters (corrected after the call)
    neuron_keys: list[int]


def _counters(m: FreeModel, tokens: int, neurons: int, paced: bool = True) -> tuple[list[tuple[str, int, int, int, str]], list[int], list[int]]:
    """Every counter this call touches: (key, amount, limit, ttl, window). Limit 0 = just count it.
    paced=False still counts the hourly use but doesn't enforce it (pacing only decides the order of models)."""
    now = time.time()
    minute, hour, day = int(now // 60), int(now // 3600), time.strftime("%Y-%m-%d", time.gmtime(now))
    hourly = lambda daily: math.ceil(daily / 24 * PACE) if daily and paced else 0  # noqa: E731 — pacing
    n = m.name
    c = [
        (f"use:{n}:req:{minute}", 1, m.rpm, MINUTE_TTL, "minute"),
        (f"use:{n}:tok:{minute}", tokens, m.tpm, MINUTE_TTL, "minute"),
        (f"use:{n}:req:h{hour}", 1, hourly(m.rpd), HOUR_TTL, "hour"),
        (f"use:{n}:tok:h{hour}", tokens, hourly(m.tpd), HOUR_TTL, "hour"),
        (f"use:{n}:req:{day}", 1, m.rpd, DAY_TTL, "day"),
        (f"use:{n}:tok:{day}", tokens, m.tpd, DAY_TTL, "day"),
    ]
    pool = PROVIDER_LIMITS.get(m.provider, {})
    if "rpd" in pool:
        c += [(f"use:{m.provider}:req:{day}", 1, pool["rpd"], DAY_TTL, "day"),
              (f"use:{m.provider}:req:h{hour}", 1, hourly(pool["rpd"]), HOUR_TTL, "hour")]
    if "neurons_day" in pool:
        daily = int(pool["neurons_day"] * 0.97)  # keep a small safety margin
        c += [(f"use:{m.provider}:neu:{day}", neurons, daily, DAY_TTL, "day"),
              (f"use:{m.provider}:neu:h{hour}", neurons, hourly(daily), HOUR_TTL, "hour")]
    tokens_at = [i for i, x in enumerate(c) if ":tok:" in x[0]]
    neurons_at = [i for i, x in enumerate(c) if ":neu:" in x[0]]
    return c, tokens_at, neurons_at


async def reserve(m: FreeModel, tokens: int, neurons: int = 0, paced: bool = True) -> tuple[Reservation | None, str]:
    """Atomically books one call of ~`tokens` tokens. Returns (reservation, "") or (None, why: paused/minute/hour/day)."""
    counters, tokens_at, neurons_at = _counters(m, tokens, neurons, paced)
    pauses = [f"paused:{m.name}", f"paused:provider:{m.provider}"]
    keys = [k for k, *_ in counters]
    args = [v for _, amount, limit, ttl, _ in counters for v in (amount, limit, ttl)]
    result = await _run(RESERVE, pauses + keys, args)
    if result is None:  # memory: same logic (no await between the check and the update, so it's atomic too)
        if any(_get(p) for p in pauses):
            result = 0
        else:
            blocked = next((i for i, (k, amount, limit, *_) in enumerate(counters) if limit and _get(k) + amount > limit), None)
            if blocked is None:
                for k, amount, _, ttl, _ in counters:
                    _add(k, amount, ttl)
                result = 1
            else:
                result = blocked + 3
    if result == 1:
        return Reservation(keys, [x[1] for x in counters], tokens_at, neurons_at), ""
    return None, "paused" if result == 0 else counters[result - 3][4]


async def _adjust(keys: list[str], deltas: list[int]) -> None:
    pairs = [(k, d) for k, d in zip(keys, deltas) if d]
    if pairs and await _run(ADJUST, [k for k, _ in pairs], [d for _, d in pairs]) is None:
        for k, d in pairs:
            _add(k, d, create=False)


async def settle(r: Reservation, tokens: int, neurons: int = 0) -> None:
    """Corrects the booked tokens/neurons to what the provider actually counted."""
    deltas = [0] * len(r.keys)
    for i in r.token_keys:
        deltas[i] = tokens - r.amounts[i]
    for i in r.neuron_keys:
        deltas[i] = neurons - r.amounts[i]
    await _adjust(r.keys, deltas)


async def refund(r: Reservation) -> None:
    """Gives the whole booking back (the call failed before using anything)."""
    await _adjust(r.keys, [-a for a in r.amounts])


async def sync_groq(m: FreeModel, headers: dict) -> None:
    """Groq reports its exact remaining quota in response headers; raise our counters to match (never lower them)."""
    try:
        used_today = int(headers["x-ratelimit-limit-requests"]) - int(headers["x-ratelimit-remaining-requests"])
        used_minute = int(headers["x-ratelimit-limit-tokens"]) - int(headers["x-ratelimit-remaining-tokens"])
    except (KeyError, ValueError):
        return
    counters, *_ = _counters(m, 0, 0)
    keys = [counters[4][0], counters[1][0]]  # requests today, tokens this minute
    if await _run(RAISE, keys, [used_today, DAY_TTL, used_minute, MINUTE_TTL]) is None:
        for k, v in zip(keys, (used_today, used_minute)):
            if _get(k) < v:
                _add(k, v - _get(k))


# ── pauses and circuit breaker ──────────────────────────────────────────────

async def pause(key: str, seconds: int) -> None:
    redis = _client()
    if redis:
        try:
            await redis.set(key, 1, ex=max(1, seconds))
            return
        except Exception as err:
            print(f"[usage] redis write failed, using memory: {err}")
    _memory[key] = (1, time.time() + seconds)


async def provider_failed(provider: str) -> bool:
    """Circuit breaker: 3 failures in a minute pause the whole provider for 60s. True if it just tripped."""
    key = f"fail:{provider}:{int(time.time() // 60)}"
    count = await _run("local n = redis.call('INCR', KEYS[1]) redis.call('EXPIRE', KEYS[1], 120) return n", [key], [])
    if count is None:
        _add(key, 1, MINUTE_TTL)
        count = _get(key)
    if count >= 3:
        await pause(f"paused:provider:{provider}", 60)
        return True
    return False


async def get(name: str) -> dict[str, int]:
    """Today's and this minute's usage for a model (for the health endpoint)."""
    now = time.time()
    minute, day = int(now // 60), time.strftime("%Y-%m-%d", time.gmtime(now))
    keys = {"req_day": f"use:{name}:req:{day}", "tok_day": f"use:{name}:tok:{day}", "tok_min": f"use:{name}:tok:{minute}",
            "paused": f"paused:{name}"}
    redis = _client()
    if redis:
        try:
            values = await redis.mget(*keys.values())
            return {k: int(v or 0) for k, v in zip(keys, values)}
        except Exception as err:
            print(f"[usage] redis read failed, using memory: {err}")
    return {k: _get(key) for k, key in keys.items()}


async def pools() -> dict[str, str]:
    """Today's use of the providers' shared free pools, e.g. {"cloudflare neurons": "1840/10000"}."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    shown = {"openrouter requests": (f"use:openrouter:req:{day}", PROVIDER_LIMITS["openrouter"]["rpd"]),
             "cloudflare neurons": (f"use:cloudflare:neu:{day}", PROVIDER_LIMITS["cloudflare"]["neurons_day"])}
    redis = _client()
    values = None
    if redis:
        try:
            values = await redis.mget(*[k for k, _ in shown.values()])
        except Exception as err:
            print(f"[usage] redis read failed, using memory: {err}")
    values = values or [_get(k) for k, _ in shown.values()]
    return {name: f"{int(v or 0)}/{limit}" for (name, (_, limit)), v in zip(shown.items(), values)}


# ── per-visit totals (one visit = one browser tab; shown in the Sessions sheet) ──

async def add_to_session(session_id: str, counts: dict[str, int], model: str = "") -> None:
    """Adds one LLM call's numbers (tokens, latency, level…) to a visit's running totals."""
    if not session_id:
        return
    key, models = f"sess:{session_id}", f"sess:{session_id}:models"
    args = [SESSION_TTL, model, *[v for field, amount in counts.items() for v in (field, amount)]]
    if await _run(SESSION, [key, models], args) is None:
        totals = _hashes.setdefault(key, {})
        for field, amount in counts.items():
            totals[field] = totals.get(field, 0) + amount
        if model:
            per_model = _hashes.setdefault(models, {})
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
    return dict(_hashes.get(key, {})), dict(_hashes.get(models, {}))
