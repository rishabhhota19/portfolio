"""The agent's HTTP API (FastAPI), deployed as a Vercel Python Function.

Browsers never call this directly: the Next.js gateway (app/api/chat/route.ts) runs the security checks
(bot check, rate limits, daily budget) and then calls these endpoints with a shared secret.

Run locally:  npm run agent   →  http://127.0.0.1:8000
"""

import asyncio
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

from agent import memory as session_memory, usage
from agent.config import env
from agent.graph import agent
from agent.guard import StreamGuard
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
BOOTED = time.time()  # when this server instance started (the warm-up log shows how fresh it was)


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)
    starter: bool = False  # a starter quick answer the browser showed itself


class ChatRequest(BaseModel):
    conversation_id: str = ""
    session_id: str = Field("", max_length=64)  # the visit, so token totals add up per visit
    messages: list[Message] = Field(min_length=1, max_length=12)


class SummaryRequest(BaseModel):
    messages: list[Message] = Field(max_length=40)
    lead: dict | None = None
    session_id: str = Field("", max_length=64)
    conversation_id: str = Field("", max_length=64)  # the chat is over: its working memory is deleted


def check_secret(secret: str | None) -> None:
    expected = env("AGENT_SHARED_SECRET")
    if env("VERCEL") and not expected:
        raise HTTPException(503, "AGENT_SHARED_SECRET is not configured")
    if expected and not hmac.compare_digest(secret or "", expected):
        raise HTTPException(401, "unauthorized")


def loaded() -> bool:
    """Whether this instance already holds what a first answer loads: the chunks, the scope and answer banks and, when
    built in, the FAISS index and the local embedding model. Each sits in an lru_cache once loaded."""
    from agent import cache, embeddings, rag, scope

    parts = [rag.load, scope.bank, cache.bank] + ([rag.index, embeddings._session] if embeddings.ENGINES[0].ready else [])
    return all(part.cache_info().currsize for part in parts)


def load() -> None:
    from agent import cache, embeddings, rag, scope

    rag.load()
    scope.bank()
    cache.bank()
    if embeddings.ENGINES[0].ready:
        rag.index()


def preload() -> None:
    """Loads what a first answer needs as this instance starts, whatever request started it. Vercel runs several
    instances: one started by a summary or a session lookup used to stay half-loaded, and the visitor whose question
    landed there waited for the load. Best-effort: a chat still loads anything missing itself."""
    from agent import embeddings

    started = time.perf_counter()
    try:
        load()
        if embeddings.ENGINES[0].ready:
            embeddings._local(("warm",))  # loads the ONNX model and runs it once
    except Exception as err:
        print(f"[boot] preload failed: {type(err).__name__}")
    print(json.dumps({"event": "boot", "ms": round((time.perf_counter() - started) * 1000)}))


preload()


@app.get("/api/agent/warm")
async def warm(src: str = ""):
    """Public. Wakes the agent before a visitor asks: an instance that starts loads everything (preload), so this only
    has to start one. Never calls an LLM: no tokens, no quota. Already warm: returns at once. The CDN keeps the reply
    for 3 minutes, so visitors in that window don't reach the function at all; the Cloudflare cron that keeps the agent
    awake (cloudflare/warm/) asks with a fresh URL each time, src=cron."""
    from agent import embeddings

    started = time.perf_counter()
    was_cold = not loaded()
    if was_cold:
        try:
            await asyncio.to_thread(load)
            if (local := embeddings.ENGINES[0]).ready:
                await local.embed(["warm"])  # loads the ONNX model and runs it once
        except Exception as err:  # best-effort: a chat still loads anything missing itself
            print(f"[warm] failed: {type(err).__name__}")
    ms = round((time.perf_counter() - started) * 1000)
    print(json.dumps({"event": "warm", "src": src[:16] or "site", "was_cold": was_cold, "ms": ms,
                      "instance_age_s": round(time.time() - BOOTED)}))
    return JSONResponse({"ok": True, "was_cold": was_cold, "ms": ms}, headers={"Cache-Control": "public, max-age=0, s-maxage=180"})


@app.post("/api/agent/chat")
async def chat(req: ChatRequest, x_agent_secret: str | None = Header(None), x_caller: str | None = Header(None)):
    """Streams the answer as NDJSON events, one JSON object per line:
        {"type": "text", "text": "…"}        more of the answer
        {"type": "replace", "text": "…"}     the output guard changed what was shown: show this instead
        {"type": "navigate", "path": "/…", "label": "…"}   take the visitor to this page
        {"type": "links", "links": [{"path", "label"}]}    "take me there" buttons under the answer
        {"type": "usage", "tokens": 123}                   tokens this turn counted against free limits (chat shows a total)
        {"type": "meta", "model": …, "level": …, …}        for the admin dashboard; the gateway strips it
    Every sentence passes the output guard (Gate 4) before it leaves the server. Returns 503 if every model is busy."""
    check_secret(x_agent_secret)
    usage.CALLER.set((x_caller or "")[:64])  # the visitor's network (hashed): fair shares and failure counting
    usage.DEADLINE.set(time.monotonic() + 45)  # the function is stopped at 60 s; leave time to finish the stream
    # Starter quick answers (shown by the browser, not written by the agent) are marked, so a question typed after
    # them still counts as the start of the conversation (graph.fresh).
    history = [(HumanMessage if m.role == "user" else AIMessage)(m.content, additional_kwargs={"starter": True} if m.starter else {})
               for m in req.messages]
    started = time.perf_counter()
    result: dict = {"trace": [], "cold": not loaded()}  # cold: this turn met an instance that hadn't loaded yet
    line = lambda event: json.dumps(event, ensure_ascii=False) + "\n"  # noqa: E731

    async def events():
        output = StreamGuard()
        call = None  # the LLM call being streamed
        live = True  # False once a call broke off mid-answer: the next model's answer is then sent whole, at the end
        final = None  # the answer as the graph finished it (after the output guard)
        # The conversation id is the agent's thread: its memory (agent/memory.py) follows it across turns and servers.
        async for mode, data in agent.astream({"messages": history}, stream_mode=["messages", "updates"],
                                              config={"configurable": {"thread_id": req.conversation_id}}):
            if mode == "messages":  # LLM tokens, as they are generated
                chunk, meta = data
                if meta.get("langgraph_node") == "respond" and isinstance(chunk, AIMessageChunk) and chunk.text:
                    if chunk.id != call:  # another call: a second opinion (nothing shown yet) or a replacement model
                        call = chunk.id
                        if output.sent:
                            live = False  # the earlier model broke off mid-answer: "replace" sends the new one whole
                        else:
                            output = StreamGuard()
                    if live:
                        for kind, text in output.push(chunk.text):
                            yield line({"type": kind, "text": text})
            else:  # "updates": what each node returned
                for update in data.values():
                    update = update or {}
                    result["trace"] += update.get("trace", [])
                    result.update({k: update[k] for k in ("intent", "why", "level", "model", "usage", "actions", "economy") if k in update})
                    if update.get("messages"):
                        final = update["messages"][-1].content
        # One structured log line per turn (visible in Vercel logs). No message text is logged.
        print(json.dumps({"event": "agent_turn", "conversation": req.conversation_id, "ms": round((time.perf_counter() - started) * 1000), **result}, default=str))
        if result.get("model") == "none":
            if output.sent:  # a model broke off mid-answer and no other could finish it: don't leave half an answer
                yield line({"type": "replace", "text": "That answer broke off part-way. Please ask again in a moment."})
            return  # every model is out of budget → nothing streamed → 503 below
        for kind, text in output.finish() if live else []:
            yield line({"type": kind, "text": text})
        if final is not None and final != output.sent:  # canned replies, or the graph's guard changed the answer
            yield line({"type": "replace" if output.sent else "text", "text": final})
        for action in result.get("actions", []):
            yield line(action)
        # This turn's tokens as the free limits count them (Groq's cached prompt tokens are free), 0 when no model was
        # needed; the chat shows the running total.
        used = result.get("usage") or {}
        yield line({"type": "usage", "tokens": used.get("tokens_counted", used.get("tokens_in", 0) + used.get("tokens_out", 0))})
        # For the admin dashboard only: the gateway records this line and strips it, so visitors never see models.
        yield line({"type": "meta", "intent": result.get("intent", ""), "why": result.get("why", ""), "level": result.get("level", ""),
                    "model": result.get("model", ""), "tokens_in": used.get("tokens_in", 0), "tokens_out": used.get("tokens_out", 0),
                    "ms": round((time.perf_counter() - started) * 1000)})

        counts = dict(result.get("usage") or {})  # real token counts from the provider
        if result.get("intent") == "refused":
            counts["refused"] = 1  # questions the refusal pipeline turned down
        if counts:  # added to this visit's totals
            await usage.add_to_session(req.session_id, counts, model=result.get("model", "") if result.get("usage") else "")

    stream = events()
    first = await anext(stream, None)  # wait for the first event so "all models down" becomes a clean 503
    if first is None:
        return JSONResponse({"error": "offline"}, status_code=503)

    async def body():
        yield first
        async for event in stream:
            yield event

    return StreamingResponse(body(), media_type="application/x-ndjson; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.post("/api/agent/summarize")
async def summarize_chat(req: SummaryRequest, x_agent_secret: str | None = Header(None), x_caller: str | None = Header(None)):
    check_secret(x_agent_secret)
    usage.CALLER.set((x_caller or "")[:64])
    usage.DEADLINE.set(time.monotonic() + 25)  # the gateway waits 30 s for a summary
    if req.conversation_id:
        await session_memory.forget(req.conversation_id)
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
        "refused": totals.get("refused", 0),  # questions the refusal pipeline turned down
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
    from agent import embeddings

    engines = {}  # the embedding lineup, in order; the local one is test-run so a broken runtime shows here
    for e in embeddings.ENGINES:
        engines[e.name] = {"model": e.model, "ready": e.ready,
                           "paused": bool((await usage.get(e.remote.name))["paused"]) if e.remote else False}
        if e.remote is None and e.ready:
            try:
                engines[e.name]["probe"] = f"ok, {(await e.embed(['ping'])).shape[1]}-dim"
            except Exception as err:
                engines[e.name]["probe"] = f"failed: {type(err).__name__}"
    from agent import cache

    meta = cache.DATA_DIR / "answers.json"
    info = json.loads(meta.read_text(encoding="utf-8")) if meta.exists() else {}
    bank = {"status": "on" if cache.bank() is not None else "off", "built_for": info.get("version"), "site_content": cache.VERSION,
            "model": info.get("model"), "intents": len(info.get("intents", [])), "disabled_by_env": env("ANSWER_BANK") == "off"}
    if (loaded := cache.bank()) is not None:  # probe: embed the first intent's own question; it must come back as a hit
        try:
            engine, vectors = await embeddings.embed([loaded[2][0]["q"]])
            hit = cache.from_bank(None if vectors is None else vectors[0])
            bank["probe"] = f"hit, score {hit['score']}" if hit else "miss"
            bank["probe_engine"] = engine.name if engine else "none"
        except Exception as err:
            bank["probe"] = f"failed: {type(err).__name__}"
    return {"ok": True, "levels": {lv: t.pool for lv, t in llm.TIERS.items()}, "summaries": llm.SUMMARY_POOL,
            "shared_pools_today": await usage.pools(), "embeddings": engines, "answer_bank": bank, "models": models}
