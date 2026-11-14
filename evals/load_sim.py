"""Load simulator: many visitors chatting at once, against fake providers that enforce the real free-tier limits.

    python -m evals.load_sim

It runs the *real* router, reservations and model pools (agent/router.py, usage.py, llm.py). Only the LLM calls
are fake: each provider allows exactly its published free limits (Groq 8k tokens/min + 200k/day per model,
Gemini 15 req/min, Cloudflare's shared 10k neurons/day, OpenRouter's 50/day) with realistic latency, and answers
429 when a limit is crossed. Time runs SPEED× faster. It compares the router with atomic reservations against
the old "check, call, then count" approach, at several numbers of simultaneous chatters.
"""

import asyncio
import random
import time as real_time
from collections import Counter
from types import SimpleNamespace

from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage

from agent import llm, router, usage
from agent.difficulty import difficulty  # noqa: F401 — the levels below follow its real mix

SPEED = 30  # simulated seconds per real second
MINUTES = 10  # simulated duration of each run
MIX = {"L1": 0.30, "L2": 0.55, "L3": 0.15}  # share of LLM questions per level
PROMPT = {"L1": 1400, "L2": 2500, "L3": 4000}  # typical prompt tokens per level (measured)
# Seconds per answer by provider. NVIDIA's catalog measured about 1.5x Groq on the live site (Nov 2026).
LATENCY = {"groq": 1.8, "gemini": 2.3, "cloudflare": 3.5, "openrouter": 6.0, "sambanova": 2.5, "nvidia": 2.7}
# A provider added to llm.py without a latency here used to crash the run part-way (KeyError): say so at the start.
if missing := sorted(set(llm.PROVIDERS) - set(LATENCY)):
    raise SystemExit(f"evals/load_sim.py: add a LATENCY entry for {', '.join(missing)}")


class Clock:
    """Simulated time, swapped into the router and usage modules."""

    def __init__(self):
        self.start = real_time.time()

    def time(self):
        return self.start + (real_time.time() - self.start) * SPEED

    def gmtime(self, t=None):
        return real_time.gmtime(self.time() if t is None else t)

    def strftime(self, fmt, t=None):
        return real_time.strftime(fmt, t or self.gmtime())

    async def sleep(self, seconds):
        await real_time_sleep(seconds / SPEED)


real_time_sleep = asyncio.sleep
clock = Clock()


class Providers:
    """What the providers themselves enforce (independent of our counters)."""

    def __init__(self):
        self.used = Counter()
        self.rate_limited = 0

    def call(self, m: llm.FreeModel, tokens_in: int, tokens_out: int):
        now = clock.time()
        minute, day = int(now // 60), "d"
        checks = [
            (f"{m.name}:rm:{minute}", 1, m.rpm), (f"{m.name}:tm:{minute}", tokens_in + tokens_out, m.tpm),
            (f"{m.name}:rd:{day}", 1, m.rpd), (f"{m.name}:td:{day}", tokens_in + tokens_out, m.tpd),
        ]
        pool = llm.PROVIDER_LIMITS.get(m.provider, {})
        if "rpm" in pool:  # a per-account limit shared by all of a provider's models (NVIDIA's catalog)
            checks.append((f"{m.provider}:rm:{minute}", 1, pool["rpm"]))
        if "rpd" in pool:
            checks.append((f"{m.provider}:rd", 1, pool["rpd"]))
        if "neurons_day" in pool:
            checks.append((f"{m.provider}:nd", m.neurons_for(tokens_in, tokens_out), pool["neurons_day"]))
        for key, amount, limit in checks:
            if limit and self.used[key] + amount > limit:
                self.rate_limited += 1
                raise RateLimited(60 - now % 60 if ":rm:" in key or ":tm:" in key else 3600)
        for key, amount, _ in checks:
            self.used[key] += amount


class RateLimited(Exception):
    status_code = 429

    def __init__(self, retry):
        super().__init__("rate limited")
        self.response = SimpleNamespace(headers={"retry-after": str(int(retry))})


providers = Providers()


class FakeClient:
    def __init__(self, m: llm.FreeModel, max_tokens: int):
        self.m, self.max_tokens = m, max_tokens

    async def astream(self, prompt):
        tokens_in = llm.estimate_tokens(prompt)
        tokens_out = int(self.max_tokens * random.uniform(0.4, 0.8))
        await clock.sleep(LATENCY[self.m.provider] * random.uniform(0.3, 0.6))  # time to first token
        providers.call(self.m, tokens_in, tokens_out)  # 429 here, like a real provider
        await clock.sleep(LATENCY[self.m.provider] * random.uniform(0.4, 0.9))
        yield AIMessageChunk(content="answer ", usage_metadata={"input_tokens": tokens_in, "output_tokens": tokens_out,
                                                              "total_tokens": tokens_in + tokens_out})


def install(naive: bool):
    """Swap in simulated time and fake model calls; `naive` = the old check-then-count behaviour."""
    usage.time, router.time = clock, clock
    router.asyncio = SimpleNamespace(sleep=clock.sleep)
    llm.FreeModel.client = lambda self, max_tokens, effort="low", timeout=15: FakeClient(self, max_tokens)
    usage._memory.clear()
    if naive:
        original_reserve = usage.reserve

        async def check_only(m, tokens, neurons=0, paced=True):  # look, but don't book — count only after the call
            r, why = await original_reserve(m, tokens, neurons, paced)
            if r:
                await usage.refund(r)
                await clock.sleep(LATENCY[m.provider] * 0.5)  # the gap in which other visitors see the same "free" model
                await usage._adjust(r.keys, r.amounts)
            return r, why

        usage.reserve = check_only
    return usage.reserve


async def visitor(results: list, until: float):
    while clock.time() < until:
        level = random.choices(list(MIX), weights=list(MIX.values()))[0]
        tier = llm.TIERS[level]
        prompt = [SystemMessage("x" * (PROMPT[level] * 4 - 200)), HumanMessage("question")]
        started = clock.time()
        answer = await router.run(llm.candidates(level), tier, lambda m: (prompt, False) if llm.fits(m, PROMPT[level], tier.max_tokens) else None)
        results.append((level, answer.model if answer else None, answer.depth if answer else None, clock.time() - started))
        await clock.sleep(random.uniform(15, 45))  # reading the answer, typing the next question


async def run(users: int, naive: bool) -> dict:
    global providers
    providers = Providers()
    saved = usage.reserve
    install(naive)
    results: list = []
    until = clock.time() + MINUTES * 60
    await asyncio.gather(*(visitor(results, until) for _ in range(users)))
    usage.reserve = saved
    answered = [r for r in results if r[1]]
    waits = sorted(r[3] for r in answered)
    return {
        "users": users, "router": "old (check, then count)" if naive else "new (atomic reserve)",
        "questions": len(results), "answered": f"{len(answered) / max(len(results), 1):.0%}",
        "429s": providers.rate_limited,
        "first_choice": f"{sum(1 for r in answered if r[2] == 0) / max(len(answered), 1):.0%}",
        "p50_s": round(waits[len(waits) // 2], 1) if waits else None,
        "p95_s": round(waits[int(len(waits) * 0.95)], 1) if waits else None,
        "providers": dict(Counter(r[1].split("/")[0] for r in answered)),
    }


async def main():
    print(f"{MINUTES} simulated minutes per run, visitors ask every 15–45 s; limits = real free tiers\n")
    for users in (5, 25, 50, 100):
        for naive in (True, False):
            print(await run(users, naive))


if __name__ == "__main__":
    asyncio.run(main())
