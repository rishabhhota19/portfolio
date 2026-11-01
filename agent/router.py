"""Runs one LLM call on the free-model web: pick → reserve → call → settle, falling through until one answers.

For each candidate model (best first, see llm.py):
  1. build the prompt that fits it (fewer chunks / older turns dropped if needed — context shifting),
  2. reserve its budget atomically (usage.py) — skip it if it has no room,
  3. call it with a timeout, streaming the tokens,
  4. correct the reservation to the real token count (and sync to Groq's own count).
Errors never reach the visitor: a rate limit pauses that model (for as long as the provider says), and repeated
outages trip a breaker that skips the whole provider for a minute. If every model is only out of *per-minute*
budget, wait for the next minute once. Only when everything is out for the day does it give up.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Callable

from . import llm, usage
from .llm import FreeModel, Tier

MAX_WAIT = 20  # seconds we'll wait for per-minute limits to reset before giving up


@dataclass
class Answer:
    text: str
    model: str
    tokens_in: int
    tokens_out: int
    depth: int  # how many models were skipped or failed before this one (0 = first choice)
    trimmed: bool  # context had to be shortened to fit
    tried: list[str]


async def on_error(m: FreeModel, err: Exception) -> None:
    """Pauses a failing model (rate limit: as long as the provider asks; bad key/model: an hour; outage: 30s + breaker)."""
    status = getattr(err, "status_code", None)
    response = getattr(err, "response", None)
    retry_after = response.headers.get("retry-after") if response is not None else None
    if status == 429:
        seconds = 60
        if any(w in str(err).lower() for w in ("per day", "daily", "perday")):
            seconds = 3600  # daily quota gone: look again in an hour
        elif retry_after:
            try:
                seconds = int(float(retry_after)) + 1  # the provider says exactly when to come back
            except ValueError:
                pass
        await usage.pause(f"paused:{m.name}", min(seconds, 3600))
    elif status in (401, 403, 404):
        await usage.pause(f"paused:{m.name}", 3600)
    else:  # 5xx, timeout, connection error
        await usage.pause(f"paused:{m.name}", 30)
        if await usage.provider_failed(m.provider):
            print(f"[router] breaker: skipping {m.provider} for 60s")
    print(f"[router] {m.name} failed ({status or type(err).__name__})")


async def run(models: list[FreeModel], tier: Tier, prompt_for: Callable[[FreeModel], tuple[list, bool] | None]) -> Answer | None:
    """Tries `models` in order; returns the first real answer, or None if every free model is out of budget."""
    tried: list[str] = []
    # Pass 1 keeps every model within its hourly pace (so the best ones last all day); pass 2 ignores the pace
    # (still within the real per-minute and per-day limits); pass 3 waits for the per-minute limits to reset.
    for attempt, paced in enumerate((True, False, False)):
        if attempt == 2:
            wait = 60 - time.time() % 60 + 0.5
            if not minute_limited or wait > MAX_WAIT:
                break
            print(f"[router] every model is at its per-minute limit — waiting {wait:.0f}s")
            await asyncio.sleep(wait)
        minute_limited = False
        for depth, m in enumerate(models):
            built = prompt_for(m)
            if built is None:
                continue  # the conversation can't fit this model at all
            prompt, trimmed = built
            prompt_tokens = llm.estimate_tokens(prompt)
            booked = prompt_tokens + tier.max_tokens + (250 if m.reasoning else 0)
            reservation, why = await usage.reserve(m, booked, m.neurons_for(prompt_tokens, tier.max_tokens), paced)
            if reservation is None:
                minute_limited |= why == "minute"
                continue
            tried.append(m.name)
            reply = None  # chunks added up: the text and the response headers
            tokens_in = tokens_out = 0  # largest count seen: providers repeat or accumulate usage across chunks
            try:
                async for chunk in m.client(tier.max_tokens, tier.effort, tier.timeout).astream(prompt):
                    reply = chunk if reply is None else reply + chunk
                    chunk_in, chunk_out = llm.tokens_used(chunk)
                    tokens_in, tokens_out = max(tokens_in, chunk_in), max(tokens_out, chunk_out)
            except Exception as err:
                if reply is None or not reply.text.strip():  # failed before answering: give the budget back, move on
                    await usage.refund(reservation)
                    await on_error(m, err)
                    continue
            if reply is None:  # the stream ended without a single chunk
                await usage.refund(reservation)
                continue
            used = tokens_in + tokens_out or booked
            await usage.settle(reservation, used, m.neurons_for(tokens_in or prompt_tokens, tokens_out))
            if m.provider == "groq":
                await usage.sync_groq(m, (reply.response_metadata or {}).get("headers") or {})
            if reply.text.strip():
                return Answer(reply.text, m.name, tokens_in, tokens_out, depth, trimmed, tried)
    return None
