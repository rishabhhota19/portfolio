"""The model layer: a web of free LLMs, grouped by how hard a question is — the visitor never sees which one answers.

Every question gets a difficulty level (difficulty.py). Each level has a pool of free models, best first; if a whole
pool is busy the router spills over to the neighbouring levels. Before calling a model the router *reserves* its
budget in one atomic step (usage.py), so many visitors at once never pile onto the same model. The chat only
pauses when every free model in every pool has used up its daily quota.

All providers speak the OpenAI chat format, so one LangChain class (ChatOpenAI) talks to all of them.
Limits are the providers' published free tiers (Groq's are confirmed by its response headers), rounded down.

Calls go through Cloudflare AI Gateway (one dashboard of every model call) when it's set up: same models, same
requests, only the address changes. Nothing is logged or cached there. If the gateway itself fails, calls go straight
to the provider for a minute; AI_GATEWAY=off sends everything direct.
"""

import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import openai
from langchain_openai import ChatOpenAI
from pydantic import Field

from .config import env

GATEWAY = "https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{CF_GATEWAY_ID}"

PROVIDERS = {  # direct base URL, API key variable, AI Gateway base URL (None: the gateway has no route for it)
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY", GATEWAY + "/groq"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GOOGLE_GENERATIVE_AI_API_KEY",
               GATEWAY + "/google-ai-studio/v1beta/openai"),  # the gateway forwards Gemini's own REST path
    "cloudflare": ("https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1", "CF_WORKERS_AI_TOKEN",
                   GATEWAY + "/workers-ai/v1"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", GATEWAY + "/openrouter"),
    "sambanova": ("https://api.sambanova.ai/v1", "SAMBANOVA_API_KEY", None),  # optional: models switch on when the key is set
    # NVIDIA's API catalog (build.nvidia.com): free for Developer Program members, rate-limited per account (no
    # published daily cap, ~40 requests/min reported, "varies per model"). Optional: on when NVIDIA_API_KEY is set.
    "nvidia": ("https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY", None),
}

GATEWAY_DOWN_FOR = 60  # seconds this instance skips the gateway after the gateway itself failed
MIN_RETRY = 3  # seconds a direct retry needs at least; with less left, the router moves on to the next model
_gateway_down_until = 0.0  # this instance only: checking it costs no network call


def gateway_on() -> bool:
    """Use AI Gateway? Only when it's configured (it's an authenticated gateway, so it needs CF_AIG_TOKEN), not switched
    off with AI_GATEWAY=off, and not seen failing in the last minute."""
    return (env("AI_GATEWAY").lower() != "off" and bool(env("CF_GATEWAY_ID") and env("CF_AIG_TOKEN"))
            and time.time() >= _gateway_down_until)


def gateway_fault(err: Exception) -> str | None:
    """Why a failed call was the gateway's own fault, or None if the provider (or the request) caused it. The gateway is
    at fault when it gave no reply at all, or wrote the error itself: AI Gateway's JSON error, or a Cloudflare error page.
    A provider's own errors come back through the gateway as the provider's JSON, and are handled as today."""
    if isinstance(err, openai.APITimeoutError):  # a slow model isn't the gateway's fault; not reaching the gateway is
        return "connect timeout" if isinstance(err.__cause__, httpx.ConnectTimeout) else None
    if isinstance(err, openai.APIConnectionError):  # no reply at all (DNS, refused, TLS, reset)
        return type(err.__cause__ or err).__name__
    response = getattr(err, "response", None)
    if not isinstance(response, httpx.Response):
        return None
    try:
        body = response.json()
    except ValueError:  # not JSON: Cloudflare's own error page
        return f"{response.status_code} error page" if response.status_code >= 500 else None
    if isinstance(body, dict) and (body.get("name") == "AiGatewayError"
                                   or (body.get("success") is False and isinstance(body.get("error"), list))):
        return f"{response.status_code} AiGatewayError {body.get('internalCode', '')}".strip()
    return None


def gateway_failed(why: str) -> None:
    global _gateway_down_until
    _gateway_down_until = time.time() + GATEWAY_DOWN_FOR
    print(f"[llm] AI Gateway failed ({why}): calls go direct for {GATEWAY_DOWN_FOR}s")


class GatewayChat(ChatOpenAI):
    """A ChatOpenAI that goes through AI Gateway. If the gateway itself fails before the answer starts, it's skipped
    for a minute and the same call goes straight to the provider in the time left: a gateway outage costs a moment,
    never a model (the router never sees it)."""

    direct: Any = Field(default=None, exclude=True)  # timeout → the same client without the gateway

    def _direct_after(self, err: Exception, started: float) -> ChatOpenAI | None:
        """The direct client to retry with, or None to let the error through (the provider's fault, or no time left)."""
        why = gateway_fault(err)
        if why is None:
            return None
        gateway_failed(why)
        left = self.request_timeout - (time.monotonic() - started)
        return self.direct(int(left)) if left >= MIN_RETRY else None

    async def _astream(self, *args, **kwargs):
        started, answering = time.monotonic(), False
        try:
            async for chunk in super()._astream(*args, **kwargs):
                answering = True
                yield chunk
            return
        except Exception as err:
            if answering or not (direct := self._direct_after(err, started)):
                raise  # a cut-off answer is never retried: the router handles it as today
        async for chunk in direct._astream(*args, **kwargs):
            yield chunk

    async def _agenerate(self, *args, **kwargs):
        started = time.monotonic()
        try:
            return await super()._agenerate(*args, **kwargs)
        except Exception as err:
            if not (direct := self._direct_after(err, started)):
                raise
        return await direct._agenerate(*args, **kwargs)

# Free budgets shared by all of a provider's models.
PROVIDER_LIMITS = {
    "openrouter": {"rpd": 50},  # 50 free requests a day across every :free model
    "cloudflare": {"neurons_day": 10_000},  # Workers AI: one pool of 10,000 neurons a day per account (00:00 UTC)
    "nvidia": {"rpm": 30},  # the catalog's ~40 requests a minute are per account, shared by every model; headroom kept
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
        direct_url, key_name, gateway_url = PROVIDERS[self.provider]
        extra = dict(self.extra)
        if self.reasoning:
            extra["reasoning_effort"] = effort
        ids = {"CF_ACCOUNT_ID": env("CF_ACCOUNT_ID"), "CF_GATEWAY_ID": env("CF_GATEWAY_ID")}
        options = dict(
            model=self.model,
            api_key=env(key_name),
            max_tokens=max_tokens + (250 if self.reasoning else 0),  # headroom for hidden reasoning tokens
            temperature=0.3,
            max_retries=0,  # no retries: switching to the next model is faster
            stream_usage=True,  # real token counts arrive at the end of the stream
            include_response_headers=True,  # Groq sends its exact remaining quota
            extra_body=extra or None,
        )

        def direct(seconds: float) -> ChatOpenAI:
            # a slow provider shouldn't stall the chat — move on
            return ChatOpenAI(base_url=direct_url.format(**ids), timeout=seconds, **options)

        if gateway_url is None or not gateway_on():
            return direct(timeout)
        headers = {
            "cf-aig-authorization": f"Bearer {env('CF_AIG_TOKEN')}",
            "cf-aig-collect-log": "false",  # no prompt or answer is ever stored (the privacy page promises it)
            "cf-aig-skip-cache": "true",  # every answer stays a real call to the model, as without the gateway
            "cf-aig-no-wholesale": "true",  # never let Cloudflare pay for (and bill) a model call: our keys only, ₹0
        }
        if self.provider == "gemini":  # the gateway sees Gemini's key only in Google's own header (no-wholesale needs it)
            headers["x-goog-api-key"] = env(key_name)
        return GatewayChat(
            base_url=gateway_url.format(**ids),
            timeout=timeout,
            default_headers=headers,
            direct=direct,
            **options,
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
    # Gemini: big daily quotas (Google no longer publishes free limits; ~500/day measured by others). Each model is
    # its own daily quota, reset at midnight Pacific.
    "gemini-lite-3.5": FreeModel("gemini", "gemini-3.5-flash-lite", 15, 500, 250_000),
    "gemini-lite-3.1": FreeModel("gemini", "gemini-3.1-flash-lite", 15, 500, 250_000),
    # The free tier of the bigger Flash models and Gemma 4 sheds load often (503 "high demand", 429 at ~5 req/min,
    # timeouts; benched Nov 2026: right on every fact they did answer), so they come late in the pools, as extra
    # daily capacity when the leaders are out. Gemma 4 31B never answered through this endpoint and isn't listed.
    "gemini-flash-3.6": FreeModel("gemini", "gemini-3.6-flash", 5, 250, 250_000, reasoning=True),
    "gemini-flash-3": FreeModel("gemini", "gemini-3-flash-preview", 5, 250, 250_000, reasoning=True),
    "gemini-flash-3.8": FreeModel("gemini", "gemini-3.8-flash", 5, 250, 250_000, reasoning=True),
    "gemini-gemma-26b": FreeModel("gemini", "gemma-4-26b-a4b-it", 5, 1000, 15_000),
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
    # NVIDIA API catalog (optional, NVIDIA_API_KEY): free for Developer Program members with ~40 requests a minute per
    # account (PROVIDER_LIMITS) and no published daily cap — so these sit right after Groq and take the overflow all
    # day. Benched 5 Nov 2026 on the real prompt: every Nemotron 8/8 facts, 0.7–3.2 s median, no reasoning leaks.
    # The catalog's other free chat endpoints didn't make it: DeepSeek V4.1 Flash, GLM-5.3 Flash, gpt-oss-20b,
    # Gemma 4 31B, MiniMax M3.1 and Mistral Large 4 timed out at 45 s even one at a time; Step 5 leaks its reasoning
    # into the answer; Muse Glimmer takes 15 s to say "51". Worth a retry some months on.
    "nv-nemotron-super": FreeModel("nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b", context=64_000, extra=NO_THINKING),
    "nv-nemotron-ultra": FreeModel("nvidia", "nvidia/nemotron-3-ultra-550b-a55b", context=64_000, extra=NO_THINKING),
    "nv-nemotron-lightning": FreeModel("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b", extra=NO_THINKING),
    # Nano Omni 30B and Bolt E4B scored 8/8 facts too, but on a visa question Nano echoed a rule of the prompt word for
    # word and Bolt refused outright instead of saying the site doesn't share it: not in any pool.
    "nv-nemotron-nano": FreeModel("nvidia", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", extra=NO_THINKING),
    "nv-nemotron-bolt": FreeModel("nvidia", "nvidia/nemotron-3.5-bolt-e4b", extra=NO_THINKING),
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
    # (Granite 4.0 Micro, 3B, left the pool: it answered a "notice period" question instead of saying the site doesn't
    # share it, and Nemotron Lightning now covers the cheap end with no daily cap.)
    "L1": Tier(2, 4, 200, "low", 10, ["groq-20b", "nv-nemotron-lightning", "gemini-lite-3.1", "cf-qwen3-a3b", "cf-glm",
                                      "cf-20b", "gemini-lite-3.5", "cf-scout", "gemini-gemma-26b"]),
    # L2 — the usual question ("What did he build at X, and what was the impact?").
    "L2": Tier(4, 8, 300, "low", 15, ["groq-120b", "nv-nemotron-super", "nv-nemotron-lightning", "gemini-lite-3.5", "groq-qwen",
                                      "cf-qwen3-a3b", "cf-gemma", "cf-llama70b", "gemini-lite-3.1", "cf-mistral",
                                      "gemini-flash-3", "gemini-flash-3.6", "or-lightning"]),
    # L3 — reasoning (role fit, comparisons, "why"): the strongest models, the agent loop's evidence, longer answers.
    "L3": Tier(10, 12, 600, "medium", 25, ["groq-120b", "nv-nemotron-super", "nv-nemotron-ultra", "cf-120b", "groq-qwen",
                                          "sn-deepseek", "cf-nemotron", "sn-120b", "gemini-flash-3.6", "gemini-flash-3",
                                          "or-ultra", "gemini-lite-3.5", "gemini-flash-3.8"]),
}

# The agent loop's planner (research.py): models that make real tool calls when streaming (checked Nov 2026: Nemotron
# 3.5 Super, Qwen and Gemini Lite search every point in one go — Super in 0.9 s with no daily cap, so it leads; the
# gpt-oss models and Nemotron Lightning one call a round; Llama 3.3 70B writes the call as text and Mistral's stream
# breaks). The L3 writer's own model comes last so the two don't share Groq's 8,000 tokens a minute.
RESEARCH = Tier(0, 4, 400, "low", 12, ["nv-nemotron-super", "groq-qwen", "gemini-lite-3.1", "nv-nemotron-lightning", "groq-120b", "cf-120b"])

# If a level's whole pool is busy, try the neighbours: easy questions move up, hard ones move down.
SPILL = {"L1": ["L1", "L2", "L3"], "L2": ["L2", "L3", "L1"], "L3": ["L3", "L2", "L1"]}

SUMMARY_POOL = ["gemini-lite-3.1", "nv-nemotron-lightning", "cf-glm", "gemini-lite-3.5", "cf-20b", "cf-gemma"]  # high-quota, cheap; never Groq


def candidates(level: str) -> list[FreeModel]:
    """Every usable model for a question of this level, in the order to try them (no duplicates)."""
    names = dict.fromkeys(name for tier in SPILL[level] for name in TIERS[tier].pool)
    return [M[n] for n in names if M[n].available]


def estimate_tokens(messages: list) -> int:
    """Token count estimate: ~4 characters per token for English (within 1% of the providers' counts on our prompts).
    Other scripts and emoji take 1–3 tokens a character, so each non-ASCII character counts as 1.5 — padded
    Chinese or emoji text can't pass as small any more."""
    text = "".join(str(m.content) for m in messages)
    other = sum(1 for c in text if ord(c) > 127)
    return (len(text) - other) // 4 + other * 3 // 2 + 4 * len(messages)


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
