"""Free LLMs only, in priority order — orchestrated so the visitor never notices a switch.

For every answer the backend walks the list below and uses the first model that
  1. has its API key set,
  2. still has free-tier budget left (requests + tokens, per minute and per day — see usage.py), and
  3. can fit the conversation into that budget ("context shifting": the oldest turns are dropped if needed).
If a model errors (rate limit, outage) it is paused and the next one answers, with the same conversation.
When every model is used up, the chat pauses for everyone until the limits reset.

All providers speak the OpenAI chat format, so one LangChain class (ChatOpenAI) talks to all of them.
"""

from dataclasses import dataclass

from langchain_openai import ChatOpenAI

from . import usage
from .config import env

PROVIDERS = {
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GOOGLE_GENERATIVE_AI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
}

# Some free tiers are shared across a provider's models: OpenRouter allows 50 free requests a day in total.
PROVIDER_DAILY_REQUESTS = {"openrouter": 50}


@dataclass(frozen=True)
class FreeModel:
    provider: str
    model: str
    rpm: int  # free-tier requests per minute
    rpd: int  # requests per day
    tpm: int  # tokens per minute (0 = no limit we know of)
    tpd: int  # tokens per day   (0 = no limit we know of)
    context: int = 32_000  # most tokens we'll send in one request
    extra_tokens: int = 0  # headroom for hidden reasoning tokens

    @property
    def name(self) -> str:
        return f"{self.provider}/{self.model}"

    def client(self, max_tokens: int = 350) -> ChatOpenAI:
        base_url, key_name = PROVIDERS[self.provider]
        extra = None
        if self.model.startswith("openai/gpt-oss") or self.model == "gemini-flash-latest":
            extra = {"reasoning_effort": "low"}  # think briefly, answer fast
        elif self.model.startswith("qwen/"):
            extra = {"reasoning_format": "hidden"}  # keep <think> text out of the answer
        elif self.provider == "openrouter":
            extra = {"reasoning": {"enabled": False}}  # answer directly: faster, and never an empty reply
        return ChatOpenAI(
            model=self.model,
            api_key=env(key_name),
            base_url=base_url,
            max_tokens=max_tokens + self.extra_tokens,
            temperature=0.3,
            timeout=15,  # a slow provider shouldn't stall the chat — move on
            max_retries=0,  # no retries: switching to the next model is faster
            stream_usage=True,  # the provider reports the real token counts at the end of the stream
            extra_body=extra,
        )


# Best first. Limits are the providers' published free tiers, rounded down to stay safe.
CHAT_MODELS = [
    FreeModel("groq", "openai/gpt-oss-120b", rpm=30, rpd=1000, tpm=8_000, tpd=200_000, extra_tokens=250),
    FreeModel("gemini", "gemini-flash-lite-latest", rpm=15, rpd=1000, tpm=250_000, tpd=0),
    FreeModel("groq", "openai/gpt-oss-20b", rpm=30, rpd=1000, tpm=8_000, tpd=200_000, extra_tokens=250),
    FreeModel("gemini", "gemini-flash-latest", rpm=10, rpd=250, tpm=250_000, tpd=0, extra_tokens=250),
    FreeModel("groq", "qwen/qwen3.8-27b", rpm=30, rpd=1000, tpm=6_000, tpd=200_000, extra_tokens=250),
    FreeModel("openrouter", "google/gemma-4-31b-it:free", rpm=20, rpd=50, tpm=0, tpd=0),
    FreeModel("openrouter", "nvidia/nemotron-3.5-lightning:free", rpm=20, rpd=50, tpm=0, tpd=0),
]
SUMMARY_MODELS = [CHAT_MODELS[2], CHAT_MODELS[1], CHAT_MODELS[4]]  # smaller models first: save the best for chat


def estimate_tokens(messages: list) -> int:
    """Rough token count (~4 characters per token) — good enough to stay inside free limits."""
    return sum(len(str(m.content)) for m in messages) // 4 + 4 * len(messages)


async def fit(m: FreeModel, prompt: list, max_tokens: int = 350):
    """Returns the prompt trimmed to fit this model's remaining free budget, or None if it can't be used now.

    prompt = [system message, ...conversation]. Context shifting: drop the oldest turns until it fits.
    """
    if not env(PROVIDERS[m.provider][1]):
        return None
    u = await usage.get(m.name)
    if u["paused"] or u["req_min"] >= m.rpm or u["req_day"] >= m.rpd:
        return None
    if m.provider in PROVIDER_DAILY_REQUESTS:
        if (await usage.get(m.provider))["req_day"] >= PROVIDER_DAILY_REQUESTS[m.provider]:
            return None

    reserve = max_tokens + m.extra_tokens  # providers count the reply allowance against the limit too
    budget = m.context
    if m.tpm:
        budget = min(budget, m.tpm - u["tok_min"])
    if m.tpd:
        budget = min(budget, m.tpd - u["tok_day"])
    budget -= reserve

    system, history = prompt[0], list(prompt[1:])
    while history:
        if estimate_tokens([system, *history]) <= budget:
            return [system, *history]
        history = history[1:]  # drop the oldest turn …
        while history and history[0].type != "human":
            history = history[1:]  # … and keep the conversation starting with a visitor message
    return None


def tokens_used(reply) -> tuple[int, int]:
    """(input, output) tokens the provider reported for a reply, or (0, 0) if it didn't say."""
    u = getattr(reply, "usage_metadata", None) or {}
    return u.get("input_tokens", 0), u.get("output_tokens", 0)


async def record(m: FreeModel, sent: list, max_tokens: int = 350, used: int = 0) -> None:
    """Token tracking: count this call against the model's free budget — the provider's real count when it
    gave one, otherwise an estimate (prompt + the full reply allowance, to stay on the safe side)."""
    tokens = used or estimate_tokens(sent) + max_tokens + m.extra_tokens
    await usage.record(m.name, tokens)
    if m.provider in PROVIDER_DAILY_REQUESTS:
        await usage.record(m.provider, tokens)


async def on_error(m: FreeModel, err: Exception) -> None:
    """Pauses a failing model: an hour if its daily quota is gone, a minute for anything else."""
    message = str(err).lower()
    status = getattr(err, "status_code", None)
    daily = status == 429 and ("day" in message or "daily" in message)
    seconds = 3600 if daily or status in (401, 403, 404) else 60
    await usage.pause(m.name, seconds)
    print(f"[llm] {m.name} failed ({status or type(err).__name__}) — paused {seconds}s")
