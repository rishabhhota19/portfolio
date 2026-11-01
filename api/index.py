"""The agent's HTTP API (FastAPI), deployed as a Vercel Python Function.

Browsers never call this directly: the Next.js gateway (app/api/chat/route.ts) runs the security checks
(bot check, rate limits, daily budget) and then calls these endpoints with a shared secret.

Run locally:  npm run agent   →  http://127.0.0.1:8000
"""

import hmac
import json
import re
import sys
import time
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).parent.parent))  # makes the `agent` package importable on Vercel

import sentry_sdk
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from pydantic import BaseModel, Field

from agent import usage
from agent.config import env
from agent.graph import agent
from agent.summarize import summarize

if env("NEXT_PUBLIC_SENTRY_DSN") and env("VERCEL"):  # deployed only: local runs and evals stay out of Sentry
    # Errors from the Python agent go to the same Sentry project. Request bodies (chat text) are never sent.
    sentry_sdk.init(
        dsn=env("NEXT_PUBLIC_SENTRY_DSN"),
        environment=env("VERCEL_ENV", "development"),
        traces_sample_rate=0.1,
        send_default_pii=False,
        max_request_body_size="never",
    )

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    conversation_id: str = ""
    session_id: str = Field("", max_length=64)  # the visit, so token totals add up per visit
    messages: list[Message] = Field(min_length=1, max_length=12)


class SummaryRequest(BaseModel):
    messages: list[Message] = Field(max_length=40)
    lead: dict | None = None
    session_id: str = Field("", max_length=64)


def check_secret(secret: str | None) -> None:
    expected = env("AGENT_SHARED_SECRET")
    if env("VERCEL") and not expected:
        raise HTTPException(503, "AGENT_SHARED_SECRET is not configured")
    if expected and not hmac.compare_digest(secret or "", expected):
        raise HTTPException(401, "unauthorized")


@app.post("/api/agent/chat")
async def chat(req: ChatRequest, x_agent_secret: str | None = Header(None)):
    """Streams the answer as plain text. Returns 503 if every model is unavailable."""
    check_secret(x_agent_secret)
    history = [HumanMessage(m.content) if m.role == "user" else AIMessage(m.content) for m in req.messages]
    started = time.perf_counter()
    result: dict = {"trace": []}

    async def tokens():
        async for mode, data in agent.astream({"messages": history}, stream_mode=["messages", "updates"]):
            if mode == "messages":  # LLM tokens, as they are generated
                chunk, meta = data
                if meta.get("langgraph_node") == "respond" and isinstance(chunk, AIMessageChunk) and chunk.text:
                    result["streamed"] = True
                    yield chunk.text
            else:  # "updates": what each node returned
                for node, update in data.items():
                    update = update or {}
                    result["trace"] += update.get("trace", [])
                    result.update({k: update[k] for k in ("intent", "level", "model", "usage") if k in update})
                    # Replies that weren't streamed token by token: the router's canned answer,
                    # or the facts-only fallback when every model is busy.
                    if update.get("messages") and (node == "route" or not result.get("streamed")):
                        yield update["messages"][-1].content
        if result.get("usage"):  # real token counts from the provider, added to this visit's totals
            await usage.add_to_session(req.session_id, result["usage"], model=result.get("model", ""))
        # One structured log line per turn (visible in Vercel logs). No message text is logged.
        print(json.dumps({"event": "agent_turn", "conversation": req.conversation_id, "ms": round((time.perf_counter() - started) * 1000), **result}))

    stream = tokens()
    first = await anext(stream, None)  # wait for the first token so "all models down" becomes a clean 503
    if first is None:
        return JSONResponse({"error": "offline"}, status_code=503)

    async def body():
        yield first
        async for token in stream:
            yield token

    return StreamingResponse(body(), media_type="text/plain; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.post("/api/agent/summarize")
async def summarize_chat(req: SummaryRequest, x_agent_secret: str | None = Header(None)):
    check_secret(x_agent_secret)
    return await summarize([m.model_dump() for m in req.messages], req.lead, req.session_id)


@app.get("/api/agent/session/{session_id}")
async def session_usage(session_id: str, x_agent_secret: str | None = Header(None)):
    """A visit's token totals, as columns for the Sessions sheet. Secret required."""
    check_secret(x_agent_secret)
    if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        raise HTTPException(400, "bad session id")
    totals, per_model = await usage.session(session_id)
    calls, tokens_in, tokens_out = totals.get("calls", 0), totals.get("tokens_in", 0), totals.get("tokens_out", 0)
    models = ", ".join(f"{name.split('/')[-1]} ×{n}" for name, n in sorted(per_model.items(), key=lambda kv: -kv[1]))
    levels = " · ".join(f"{lv} ×{totals[f'level_{lv}']}" for lv in ("L1", "L2", "L3") if totals.get(f"level_{lv}"))
    return {
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "tokensTotal": tokens_in + tokens_out,
        "llmCalls": calls,
        "models": f"{models} ({levels})" if levels else models,  # e.g. "gpt-oss-120b ×2, gpt-oss-20b ×1 (L1 ×1 · L2 ×2)"
        "switches": totals.get("switches", 0),
        "avgLatency": round(totals.get("latency_ms", 0) / calls) if calls else 0,
        "summaryTokens": totals.get("summary_tokens", 0),
    }


@app.get("/api/agent/health")
async def health(x_agent_secret: str | None = Header(None)):
    """Public: just "ok". With the secret: the model web — each level's pool and every model's budget today."""
    expected = env("AGENT_SHARED_SECRET")
    if not (expected and hmac.compare_digest(x_agent_secret or "", expected)):
        return {"ok": True}
    from agent import llm

    models = {}
    for key, m in llm.M.items():
        u = await usage.get(m.name)
        models[key] = {"model": m.name, "available": m.available, "paused": bool(u["paused"]),
                       "requests_today": f"{u['req_day']}/{m.rpd or '∞'}",
                       "tokens_today": f"{u['tok_day']}/{m.tpd or '∞'}", "tokens_this_minute": u["tok_min"]}
    return {"ok": True, "levels": {lv: t.pool for lv, t in llm.TIERS.items()}, "summaries": llm.SUMMARY_POOL,
            "shared_pools_today": await usage.pools(), "models": models}
