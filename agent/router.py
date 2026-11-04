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
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

from . import llm, usage
from .llm import FreeModel, Tier

MAX_WAIT = 20  # seconds we'll wait for per-minute limits to reset before giving up
MIN_CALL = 5  # seconds a model call needs at least; with less time left before the deadline, stop trying
NONE_LEFT_FOR = 60  # once no model in a pool could be booked for a caller, answer them "busy" this long without asking again
_none_left: dict[tuple, float] = {}  # (pool, caller) → until when; this instance only, costs no Redis commands to check


@dataclass
class Answer:
    text: str
    model: str
    tokens_in: int
    tokens_out: int
    cached: int  # input tokens the provider served from its prompt cache (Groq: free against its limits)
    depth: int  # how many models were skipped or failed before this one (0 = first choice)
    trimmed: bool  # context had to be shortened to fit
    tried: list[str]
    message: Any = None  # the whole reply, tool calls included (the agent loop reads them)

    @property
    def counted(self) -> int:
        """Tokens that count against the provider's free limits: Groq doesn't count prompt tokens from its cache."""
        return self.tokens_in - (self.cached if self.model.startswith("groq/") else 0) + self.tokens_out


def too_big(message: str) -> bool:
    """A 429 for this request alone ("Limit 8000, Requested 9500"): not the account being busy."""
    numbers = re.search(r"Limit (\d+),.*?Requested (\d+)", message)
    return bool(numbers) and int(numbers[2]) > int(numbers[1])


async def on_error(m: FreeModel, err: Exception) -> None:
    """What a failed call means for everyone else. Only the provider's own word (429: the account is limited) pauses a
    model straight away. Anything a single request could cause — too big, malformed, slow, a 5xx — skips the model for
    that request only, and pauses it for everyone only when several different networks see it fail (usage.py)."""
    status = getattr(err, "status_code", None)
    response = getattr(err, "response", None)
    retry_after = response.headers.get("retry-after") if response is not None else None
    if status in (400, 413, 422) or (status == 429 and too_big(str(err))):
        pass  # this request was too big or malformed for this model: skip it for this question only
    elif status == 429:
        seconds = 60
        message = str(err)
        if any(w in message.lower() for w in ("per day", "daily", "perday")):
            seconds = 3600  # daily quota gone: look again in an hour
            # Groq says exactly how much is used and when it frees up: "…tokens per day (TPD): Limit 200000,
            # Used 199835, Requested 1567. Please try again in 11m16s" → match our counter and pause just that long.
            if used := re.search(r"per day \((TPD|RPD)\): Limit \d+, Used (\d+)", message):
                await usage.sync_day(m, tokens=int(used[2]) if used[1] == "TPD" else 0, requests=int(used[2]) if used[1] == "RPD" else 0)
            if wait := re.search(r"try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s", message):
                seconds = int(wait[1] or 0) * 3600 + int(wait[2] or 0) * 60 + int(float(wait[3])) + 1
        elif retry_after:
            try:
                seconds = int(float(retry_after)) + 1  # the provider says exactly when to come back
            except ValueError:
                pass
        await usage.pause(f"paused:{m.name}", min(seconds, 3600))
    elif status in (401, 403, 404):  # bad key or model: every visitor would fail the same way
        if await usage.failed_networks(m.name) >= 2:
            await usage.pause(f"paused:{m.name}", 3600)
    else:  # 5xx, timeout, connection error
        if await usage.failed_networks(m.name) >= 2:
            await usage.pause(f"paused:{m.name}", 30)
        if await usage.provider_failed(m.provider):
            print(f"[router] breaker: skipping {m.provider} for 60s")
    print(f"[router] {m.name} failed ({status or type(err).__name__}): {' '.join(str(err).split())[:140]}")


async def run(models: list[FreeModel], tier: Tier, prompt_for: Callable[[FreeModel], tuple[list, bool] | None],
              tools: list | None = None) -> Answer | None:
    """Tries `models` in order; returns the first real answer, or None if every free model is out of budget.
    With `tools`, the models may call them: a reply of tool calls and no text counts as an answer too."""
    pool = (tuple(m.name for m in models), usage.CALLER.get())  # per caller: one visitor's request never blocks others
    if _none_left.get(pool, 0) > time.time():
        return None  # everything was used up a moment ago: don't spend ~2 Redis commands per model finding that out again
    tried: list[str] = []
    failed: set[str] = set()  # models that errored on this question: later passes don't try them again
    out_of_time = False
    # Pass 1 keeps every model within its hourly pace (so the best ones last all day); pass 2 ignores the pace
    # (still within the real per-minute and per-day limits); pass 3 waits for the per-minute limits to reset.
    for attempt, paced in enumerate((True, False, False)):
        if out_of_time:
            break
        if attempt == 2:
            wait = 60 - time.time() % 60 + 0.5
            left = usage.time_left()
            if not minute_limited or wait > MAX_WAIT or (left is not None and wait > left - MIN_CALL):
                break
            print(f"[router] every model is at its per-minute limit — waiting {wait:.0f}s")
            await asyncio.sleep(wait)
        minute_limited = False
        for depth, m in enumerate(models):
            if m.name in failed:
                continue
            left = usage.time_left()
            if left is not None and left < MIN_CALL:
                out_of_time = True  # answer "busy" in time rather than be cut off by the platform
                break
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
            tokens_in = tokens_out = cached = 0  # largest count seen: providers repeat or accumulate usage across chunks
            timeout = tier.timeout if left is None else max(MIN_CALL, min(tier.timeout, left - 2))
            client = m.client(tier.max_tokens, tier.effort, timeout)
            try:
                async for chunk in (client.bind_tools(tools) if tools else client).astream(prompt):
                    reply = chunk if reply is None else reply + chunk
                    chunk_in, chunk_out, chunk_cached = llm.tokens_used(chunk)
                    tokens_in, tokens_out, cached = max(tokens_in, chunk_in), max(tokens_out, chunk_out), max(cached, chunk_cached)
            except Exception as err:
                failed.add(m.name)
                if reply is None or not (reply.text.strip() or reply.tool_call_chunks):  # failed before answering: refund, move on
                    await usage.refund(reservation)
                else:  # broke off mid-answer: the tokens were spent, but a cut-off answer is never returned
                    counted = tokens_in - (cached if m.provider == "groq" else 0) + tokens_out
                    await usage.settle(reservation, counted or booked, m.neurons_for(tokens_in or prompt_tokens, tokens_out))
                await on_error(m, err)
                continue
            if reply is None:  # the stream ended without a single chunk
                await usage.refund(reservation)
                continue
            # Groq doesn't count cached prompt tokens against its limits, so neither do we.
            counted = tokens_in - (cached if m.provider == "groq" else 0) + tokens_out
            await usage.settle(reservation, counted or booked, m.neurons_for(tokens_in or prompt_tokens, tokens_out))
            if m.provider == "groq":
                await usage.sync_groq(m, (reply.response_metadata or {}).get("headers") or {})
            if reply.text.strip() or (tools and reply.tool_calls):
                return Answer(reply.text, m.name, tokens_in, tokens_out, cached, depth, trimmed, tried, reply)
    if not tried and pool[1]:
        if len(_none_left) > 5000:
            _none_left.clear()
        _none_left[pool] = time.time() + NONE_LEFT_FOR
    return None
