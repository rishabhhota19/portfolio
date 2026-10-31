"""The agent's HTTP API (FastAPI), deployed as a Vercel Python Function.

Browsers never call this directly: the Next.js gateway (app/api/chat/route.ts) runs the security checks
(bot check, rate limits, daily budget) and then calls these endpoints with a shared secret.

Run locally:  npm run agent   →  http://127.0.0.1:8000
"""

import hmac
import json
import sys
import time
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).parent.parent))  # makes the `agent` package importable on Vercel

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from pydantic import BaseModel, Field

from agent.config import env
from agent.graph import agent
from agent.summarize import summarize

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    conversation_id: str = ""
    messages: list[Message] = Field(min_length=1, max_length=12)


class SummaryRequest(BaseModel):
    messages: list[Message] = Field(max_length=40)
    lead: dict | None = None


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
                    result.update({k: update[k] for k in ("intent", "model") if k in update})
                    # Replies that weren't streamed token by token: the router's canned answer,
                    # or the facts-only fallback when every model is busy.
                    if update.get("messages") and (node == "route" or not result.get("streamed")):
                        yield update["messages"][-1].content
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
    return await summarize([m.model_dump() for m in req.messages], req.lead)


@app.get("/api/agent/health")
async def health(x_agent_secret: str | None = Header(None)):
    """Public: just "ok". With the secret: each free model's token tracking for today."""
    expected = env("AGENT_SHARED_SECRET")
    if not (expected and hmac.compare_digest(x_agent_secret or "", expected)):
        return {"ok": True}
    from agent import llm, usage

    models = []
    for m in llm.CHAT_MODELS:
        u = await usage.get(m.name)
        models.append({"model": m.name, "key_set": bool(env(llm.PROVIDERS[m.provider][1])), "paused": bool(u["paused"]),
                       "requests_today": f"{u['req_day']}/{m.rpd}", "tokens_this_minute": u["tok_min"]})
    return {"ok": True, "models": models}
