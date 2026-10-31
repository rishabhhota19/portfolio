"""Free LLMs in priority order. If one fails (rate limit, outage), the next one answers.

All of them speak the OpenAI chat format, so one LangChain class (ChatOpenAI) talks to every provider.
"""

import time

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_openai import ChatOpenAI

from .config import env

PROVIDERS = {
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GOOGLE_GENERATIVE_AI_API_KEY"),
}

# (provider, model) — best first. Change the order or models here.
CHAT_MODELS = [
    ("groq", "openai/gpt-oss-120b"),
    ("gemini", "gemini-flash-lite-latest"),
    ("groq", "openai/gpt-oss-20b"),
    ("groq", "qwen/qwen3.8-27b"),
]
SUMMARY_MODELS = [("groq", "openai/gpt-oss-20b"), ("gemini", "gemini-flash-lite-latest")]

# A model that just failed is skipped until this time (per server instance).
_cooldown_until: dict[str, float] = {}


def make_model(provider: str, model: str, max_tokens: int = 350) -> ChatOpenAI:
    base_url, key_name = PROVIDERS[provider]
    extra = {}
    if model.startswith("openai/gpt-oss"):
        extra = {"reasoning_effort": "low"}  # think briefly, answer fast
        max_tokens += 250  # reasoning tokens count towards the limit
    elif model.startswith("qwen/"):
        extra = {"reasoning_format": "hidden"}  # keep <think> text out of the answer
        max_tokens += 250
    return ChatOpenAI(
        model=model,
        api_key=env(key_name),
        base_url=base_url,
        max_tokens=max_tokens,
        temperature=0.3,
        timeout=25,
        max_retries=0,  # don't retry — falling over to the next model is faster
        stream_usage=False,
        extra_body=extra or None,
    )


def available(models: list[tuple[str, str]]) -> list[tuple[str, ChatOpenAI]]:
    """Models whose key is set and that aren't cooling down, in priority order."""
    now = time.time()
    return [
        (f"{provider}/{model}", make_model(provider, model))
        for provider, model in models
        if env(PROVIDERS[provider][1]) and _cooldown_until.get(model, 0) < now
    ]


def cool_down(name: str, err: Exception) -> None:
    status = getattr(err, "status_code", None)
    seconds = {429: 60, 401: 3600, 403: 3600, 404: 3600}.get(status, 30)  # rate limit / bad key or model / other
    _cooldown_until[name.split("/", 1)[1]] = time.time() + seconds
    print(f"[llm] {name} failed ({status or type(err).__name__}) — skipping it for {seconds}s")


def fake_model(answer: str):
    """Used locally when no API keys are set, so the app still runs end to end."""
    return [("mock", FakeListChatModel(responses=[answer], sleep=0.005))]
