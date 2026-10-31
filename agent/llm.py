"""Free LLMs in priority order. If one fails (rate limit, outage), the next one answers.

All of them speak the OpenAI chat format, so one LangChain class (ChatOpenAI) talks to every provider.
Each model has its own free quota, so a longer list = more capacity. If every model is busy, the graph
still answers from the retrieved facts (see `respond` in graph.py) — the chat never stops.
"""

import time

from langchain_openai import ChatOpenAI

from .config import env

PROVIDERS = {
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GOOGLE_GENERATIVE_AI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
}

# (provider, model) — best first. Models without a key set are skipped automatically.
CHAT_MODELS = [
    ("groq", "openai/gpt-oss-120b"),
    ("gemini", "gemini-flash-lite-latest"),
    ("groq", "openai/gpt-oss-20b"),
    ("gemini", "gemini-flash-latest"),
    ("groq", "qwen/qwen3.8-27b"),
    ("openrouter", "google/gemma-4-31b-it:free"),
    ("openrouter", "nvidia/nemotron-3.5-lightning:free"),
]
SUMMARY_MODELS = [("groq", "openai/gpt-oss-20b"), ("gemini", "gemini-flash-lite-latest"), ("openrouter", "google/gemma-4-31b-it:free")]

# A model that just failed is skipped until this time (per server instance).
_cooldown_until: dict[str, float] = {}


def make_model(provider: str, model: str, max_tokens: int = 350) -> ChatOpenAI:
    base_url, key_name = PROVIDERS[provider]
    extra = {}
    if model.startswith("openai/gpt-oss") or model == "gemini-flash-latest":
        extra = {"reasoning_effort": "low"}  # reasoning models: think briefly, answer fast
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
        timeout=15,  # a slow provider shouldn't stall the chat — move on
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
