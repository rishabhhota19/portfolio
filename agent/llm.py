"""The model layer: a web of free LLMs, grouped by how hard a question is — the visitor never sees which one answers.

Every question gets a difficulty level (difficulty.py). Each level has a pool of free models, best first; if a whole
pool is busy the router spills over to the neighbouring levels. Before calling a model the router *reserves* its
budget in one atomic step (usage.py), so many visitors at once never pile onto the same model. The chat only
pauses when every free model in every pool has used up its daily quota.

All providers speak the OpenAI chat format, so one LangChain class (ChatOpenAI) talks to all of them.
Limits are the providers' published free tiers (Groq's are confirmed by its response headers), rounded down.
"""

from dataclasses import dataclass, field

from langchain_openai import ChatOpenAI

from .config import env

PROVIDERS = {  # base URL, API key variable
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GOOGLE_GENERATIVE_AI_API_KEY"),
    "cloudflare": ("https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1", "CF_WORKERS_AI_TOKEN"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "sambanova": ("https://api.sambanova.ai/v1", "SAMBANOVA_API_KEY"),  # optional: models switch on when the key is set
}

# Free budgets shared by all of a provider's models.
PROVIDER_LIMITS = {
    "openrouter": {"rpd": 50},  # 50 free requests a day across every :free model
    "cloudflare": {"neurons_day": 10_000},  # Workers AI: one pool of 10,000 neurons a day per account (00:00 UTC)
}

PACE = 3  # a model may use at most 3x its hourly share of a daily quota, so the best ones aren't used up by noon


@dataclass(frozen=True)
class FreeModel:
    provider: str
    model: str
    rpm: int = 0  # free-tier limits; 0 = none we know of
    rpd: int = 0
    tpm: int = 0
    tpd: int = 0
    context: int = 32_000  # most tokens we'll send in one request
    neurons: tuple[float, float] = (0, 0)  # Cloudflare cost per million input / output tokens
    reasoning: bool = False  # gpt-oss: reasoning_effort low, or medium for hard questions
    extra: dict = field(default_factory=dict, hash=False, compare=False)  # provider-specific request options

    @property
    def name(self) -> str:
        return f"{self.provider}/{self.model}"

    @property
    def available(self) -> bool:
        return bool(env(PROVIDERS[self.provider][1]))

    def client(self, max_tokens: int, effort: str = "low", timeout: float = 15) -> ChatOpenAI:
        base_url, key_name = PROVIDERS[self.provider]
        extra = dict(self.extra)
        if self.reasoning:
            extra["reasoning_effort"] = effort
        return ChatOpenAI(
            model=self.model,
            api_key=env(key_name),
            base_url=base_url.format(CF_ACCOUNT_ID=env("CF_ACCOUNT_ID")),
            max_tokens=max_tokens + (250 if self.reasoning else 0),  # headroom for hidden reasoning tokens
            temperature=0.3,
            timeout=timeout,  # a slow provider shouldn't stall the chat — move on
            max_retries=0,  # no retries: switching to the next model is faster
            stream_usage=True,  # real token counts arrive at the end of the stream
            include_response_headers=True,  # Groq sends its exact remaining quota
            extra_body=extra or None,
        )

    def neurons_for(self, tokens_in: int, tokens_out: int) -> int:
        return round((tokens_in * self.neurons[0] + tokens_out * self.neurons[1]) / 1e6)


NO_THINKING = {"chat_template_kwargs": {"enable_thinking": False}}  # Cloudflare's reasoning models answer directly
OR_DIRECT = {"reasoning": {"enabled": False}}

# Every free model, by provider. Each was benchmarked on this site's real RAG prompt (Nov 2026).
M = {
    # Groq: fastest (~2s). Free: 30 req/min, 1,000 req/day, 8,000 tokens/min, 200,000 tokens/day per model.
    "groq-120b": FreeModel("groq", "openai/gpt-oss-120b", 30, 1000, 8000, 200_000, reasoning=True),
    "groq-20b": FreeModel("groq", "openai/gpt-oss-20b", 30, 1000, 8000, 200_000, reasoning=True),
    "groq-qwen": FreeModel("groq", "qwen/qwen3.8-27b", 30, 1000, 8000, 200_000, extra={"reasoning_format": "hidden"}),
    # Gemini: big daily quotas (Google no longer publishes free limits; ~500/day measured by others).
    "gemini-lite-3.5": FreeModel("gemini", "gemini-3.5-flash-lite", 15, 500, 250_000),
    "gemini-lite-3.1": FreeModel("gemini", "gemini-3.1-flash-lite", 15, 500, 250_000),
    # Cloudflare Workers AI: 300 req/min per model, all models share 10,000 neurons/day.
    "cf-20b": FreeModel("cloudflare", "@cf/openai/gpt-oss-20b", 300, neurons=(18_182, 27_273), reasoning=True),
    "cf-glm": FreeModel("cloudflare", "@cf/zai-org/glm-4.7-flash", 300, neurons=(5_500, 36_400), extra=NO_THINKING),
    "cf-gemma": FreeModel("cloudflare", "@cf/google/gemma-4-26b-a4b-it", 300, neurons=(9_091, 27_273), extra=NO_THINKING),
    "cf-llama70b": FreeModel("cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", 300, neurons=(26_668, 204_805)),
    "cf-scout": FreeModel("cloudflare", "@cf/meta/llama-4-scout-17b-16e-instruct", 300, neurons=(24_545, 77_273)),
    "cf-120b": FreeModel("cloudflare", "@cf/openai/gpt-oss-120b", 300, neurons=(31_818, 68_182), reasoning=True),
    "cf-mistral": FreeModel("cloudflare", "@cf/mistralai/mistral-small-3.1-24b-instruct", 300, neurons=(31_876, 50_488)),
    "cf-nemotron": FreeModel("cloudflare", "@cf/nvidia/nemotron-3-120b-a12b", 300, neurons=(45_455, 136_364)),
    # Tiny models: the shared 10,000 neurons/day go 3–8x further (an easy answer costs ~4–13 neurons vs ~30), so they
    # come before the bigger Cloudflare models for easy questions. Qwen3-30B-A3B runs only 3B parameters per token;
    # Granite 4.0 Micro (3B) is built for RAG and tool use. evals/load_sim + model_bench measure the trade-off.
    "cf-qwen3-a3b": FreeModel("cloudflare", "@cf/qwen/qwen3-30b-a3b-fp8", 300, neurons=(4_625, 30_475), extra=NO_THINKING),
    "cf-granite": FreeModel("cloudflare", "@cf/ibm-granite/granite-4.0-h-micro", 300, neurons=(1_542, 10_158)),
    # OpenRouter: 20 req/min, 50 free requests/day shared — the last line of defence.
    "or-lightning": FreeModel("openrouter", "nvidia/nemotron-3.5-lightning:free", 20, extra=OR_DIRECT),
    "or-ultra": FreeModel("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", 20, extra=OR_DIRECT),
    # SambaNova (optional): 20 req/min, 20 req/day, 200,000 tokens/day per model.
    "sn-120b": FreeModel("sambanova", "gpt-oss-120b", 20, 20, 0, 200_000, reasoning=True),
    "sn-deepseek": FreeModel("sambanova", "DeepSeek-V3.1", 20, 20, 0, 200_000),
}


@dataclass(frozen=True)
class Tier:
    chunks: int  # retrieved chunks in the prompt
    history: int  # past messages kept
    max_tokens: int  # longest answer
    effort: str  # reasoning effort for gpt-oss models
    timeout: float
    pool: list[str]  # models, best first


TIERS = {
    # L1 — one fact ("Where did he study?"): small, fast, cheap models and a short prompt.
    "L1": Tier(2, 4, 200, "low", 10, ["groq-20b", "gemini-lite-3.1", "cf-qwen3-a3b", "cf-granite", "cf-glm", "cf-20b",
                                      "gemini-lite-3.5", "cf-scout"]),
    # L2 — the usual question ("What did he build at X, and what was the impact?").
    "L2": Tier(4, 8, 350, "low", 15, ["groq-120b", "gemini-lite-3.5", "groq-qwen", "cf-qwen3-a3b", "cf-gemma",
                                      "cf-llama70b", "gemini-lite-3.1", "cf-mistral", "or-lightning"]),
    # L3 — reasoning (role fit, comparisons, "why"): the strongest models, more context, longer answers.
    "L3": Tier(6, 12, 600, "medium", 25, ["groq-120b", "cf-120b", "groq-qwen", "sn-deepseek", "cf-nemotron",
                                          "sn-120b", "or-ultra", "gemini-lite-3.5"]),
}

# If a level's whole pool is busy, try the neighbours: easy questions move up, hard ones move down.
SPILL = {"L1": ["L1", "L2", "L3"], "L2": ["L2", "L3", "L1"], "L3": ["L3", "L2", "L1"]}

SUMMARY_POOL = ["gemini-lite-3.1", "cf-glm", "gemini-lite-3.5", "cf-20b", "cf-gemma"]  # high-quota, cheap; never Groq


def candidates(level: str) -> list[FreeModel]:
    """Every usable model for a question of this level, in the order to try them (no duplicates)."""
    names = dict.fromkeys(name for tier in SPILL[level] for name in TIERS[tier].pool)
    return [M[n] for n in names if M[n].available]


def estimate_tokens(messages: list) -> int:
    """Token count estimate (~4 characters per token — within 1% of the providers' counts on our prompts)."""
    return sum(len(str(m.content)) for m in messages) // 4 + 4 * len(messages)


def tokens_used(reply) -> tuple[int, int, int]:
    """(input, output, cached input) tokens the provider reported on a reply or stream chunk, or zeros if it didn't say.
    When streaming, take the largest value across chunks — never the sum: Groq repeats its totals, Gemini sends a
    running total in every chunk, and Cloudflare sends per-token deltas plus a final total."""
    u = getattr(reply, "usage_metadata", None) or {}
    cached = (u.get("input_token_details") or {}).get("cache_read", 0) or 0
    return u.get("input_tokens", 0), u.get("output_tokens", 0), cached


def fits(m: FreeModel, prompt_tokens: int, max_tokens: int) -> bool:
    """Can one request this big go to this model at all (context window and per-minute token cap)?"""
    limit = min(m.context, m.tpm or m.context)
    return prompt_tokens + max_tokens + (250 if m.reasoning else 0) <= limit
