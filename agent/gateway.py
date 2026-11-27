"""The agent's side of the model gateway (cloudflare/gateway/worker.ts): one OpenAI-compatible door to the free models.

With GATEWAY_URL and GATEWAY_KEY set, router.run hands every call that names a role to the gateway, which picks the
model, books its free budget, falls through on errors and enforces the reply's contract. The agent only says WHAT it
needs (a role: writer-L1/L2/L3, planner, checker, summary) and HOW the reply must start (contract), never which model.
GATEWAY=off, or no GATEWAY_URL, keeps the direct path (router.py calling providers itself): the agent is the same
either way. If the gateway cannot be reached at all, the call goes direct, so the chat never stops on the gateway.
"""

import time

from langchain_openai import ChatOpenAI

from .config import env

DOWN_FOR = 60  # seconds this instance calls providers directly after the gateway was unreachable
_down_until = 0.0


def enabled() -> bool:
    return bool(env("GATEWAY_URL") and env("GATEWAY_KEY")) and env("GATEWAY").lower() != "off" and time.time() >= _down_until


def client(role: str, max_tokens: int, timeout: float, contract: str | None = None, exclude: str = "") -> ChatOpenAI:
    """exclude: a model (as "provider/model") the gateway must not use for this call: a second opinion asks a different one."""
    headers = {**({"x-contract-first-line": contract} if contract else {}), **({"x-exclude-model": exclude} if exclude else {})}
    if env("GATEWAY_SHARE"):  # CI: may fill only this share of each model's free daily limits; the visitors keep the rest
        headers["x-budget-share"] = env("GATEWAY_SHARE")
    if env("GATEWAY_WRITER") and role.startswith("writer"):  # evals only: every writer call to this one registry model
        headers["x-only-model"] = env("GATEWAY_WRITER")       # (to measure models against each other on the same cases)
    return ChatOpenAI(
        base_url=env("GATEWAY_URL"),
        api_key=env("GATEWAY_KEY"),
        model=f"dumbledore/{role}",
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=0,  # the gateway already walked the whole pool
        stream_usage=True,
        include_response_headers=True,
        default_headers=headers or None,
    )


def unreachable() -> None:
    """The gateway itself failed (not a busy pool): call providers directly for a minute."""
    global _down_until
    _down_until = time.time() + DOWN_FOR
