"""The agent, as a LangGraph graph.

    START ─► route ─(question: L1/L2/L3)─► retrieve ─► rerank ─► respond ─► END
               └──(L0: greeting / contact / off-topic / injection / repeated question)──► instant reply ─► END

The router answers simple messages and repeated questions without calling an LLM (L0), and gives every other
question a difficulty level. The respond step runs the free-model web for that level (llm.py, router.py);
the visitor never sees which model answered.
"""

import operator
import re
import time
from typing import Annotated, TypedDict

import sentry_sdk

from langchain_core.messages import AIMessage, SystemMessage
from langgraph.graph import END, START, StateGraph, add_messages

from . import cache, llm, router
from .difficulty import difficulty
from .prompts import SITE, system_prompt
from .rag import rerank, search


class State(TypedDict, total=False):
    messages: Annotated[list, add_messages]  # the conversation (the browser sends it each turn)
    intent: str
    level: str  # L1 / L2 / L3 — how hard the question is (difficulty.py)
    docs: list[dict]  # retrieved chunks
    model: str  # which LLM answered
    usage: dict  # real tokens in/out, latency, switches — added to the visit's totals
    trace: Annotated[list[dict], operator.add]  # one entry per step, for logs


def step(name: str, started: float, **details) -> list[dict]:
    return [{"step": name, "ms": round((time.perf_counter() - started) * 1000), **details}]


def last_question(state: State, turns: int = 1) -> str:
    questions = [m.content for m in state["messages"] if m.type == "human"]
    return "\n".join(questions[-turns:])


# ── 1. route ────────────────────────────────────────────────────────────────

INTENTS = {
    "injection": r"ignore (all|any|previous|prior|the above)|system prompt|your (instructions|rules|prompt)|jailbreak|pretend (to be|you are)|you are now",
    "contact": r"\b(contact|reach (him|out)|e-?mail|linkedin|phone|mobile|whatsapp|call him|get in touch|address|where does he live)\b",
    "off_topic": r"\b(write|generate|implement|solve|debug)\b.{0,40}\b(code|function|script|program|algorithm|essay|poem|story)\b",
    "greeting": r"^\s*(hi|hello|hey|namaste|good (morning|afternoon|evening))[\s!.,]*$",
}

CANNED = {
    "injection": "I can only help with questions about Rishabh's work — his projects, research and experience. What would you like to know?",
    "contact": f"You can email him at **{SITE['email']}** or message him on [LinkedIn]({SITE['linkedin']}). He doesn't share a phone number or address here — or tap **Share your details** below and he'll get back to you.",
    "off_topic": "I'm here to talk about Rishabh's work, so I'll skip that one. Happy to tell you about his projects, research or experience!",
    "greeting": "Hi! Ask me anything about Rishabh — his projects, research, experience, or whether he'd fit a role you're hiring for.",
}


def classify(text: str) -> str:
    about_him = re.search(r"\b(he|his|him|rishabh)\b", text, re.I)
    for intent, pattern in INTENTS.items():
        if intent == "off_topic" and about_him:
            continue  # "did he write a script for X?" is a real question
        if re.search(pattern, text, re.I):
            return intent
    return "question"


async def route(state: State) -> dict:
    started = time.perf_counter()
    question = last_question(state)
    intent = classify(question)
    if intent in CANNED:
        return {"intent": intent, "model": "router", "messages": [AIMessage(CANNED[intent])], "trace": step("route", started, intent=intent)}
    first_question = len(state["messages"]) == 1
    if first_question and (hit := await cache.get(question)):
        return {"intent": "cached", "model": "cache", "messages": [AIMessage(hit)], "trace": step("route", started, intent="cached")}
    level = difficulty(question, len(state["messages"]) - 1)
    return {"intent": intent, "level": level, "trace": step("route", started, intent=intent, level=level)}


# ── 2. retrieve + 3. rerank ─────────────────────────────────────────────────

async def retrieve(state: State) -> dict:
    started = time.perf_counter()
    docs = await search(last_question(state, turns=2))  # previous question helps with follow-ups
    return {"docs": docs, "trace": step("retrieve", started, found=[d["id"] for d in docs])}


async def rerank_docs(state: State) -> dict:
    started = time.perf_counter()
    docs, method = await rerank(last_question(state, turns=2), state["docs"], top_n=6)  # each level uses 2, 4 or 6
    return {"docs": docs, "trace": step("rerank", started, method=method, kept=[d["id"] for d in docs])}


# ── 4. respond ──────────────────────────────────────────────────────────────

async def respond(state: State) -> dict:
    started = time.perf_counter()
    level = state["level"]
    tier = llm.TIERS[level]
    history = state["messages"][-tier.history:]

    def prompt_for(m: llm.FreeModel):
        """Context shifting: the level's chunks and turns, trimmed (older turns first, then chunks) until it fits m."""
        for chunks in sorted({tier.chunks, min(tier.chunks, 4), 2}, reverse=True):
            system, turns = SystemMessage(system_prompt(state["docs"][:chunks])), list(history)
            while turns:
                prompt = [system, *turns]
                if llm.fits(m, llm.estimate_tokens(prompt), tier.max_tokens):
                    return prompt, chunks < tier.chunks or len(turns) < len(history)
                turns = turns[1:]  # drop the oldest turn …
                while turns and turns[0].type != "human":
                    turns = turns[1:]  # … and keep the conversation starting with a visitor message
        return None

    answer = await router.run(llm.candidates(level), tier, prompt_for)
    if answer is None:
        # Every free model is out of budget: the API answers 503 and the chat pauses until the limits reset.
        alert_exhausted()
        return {"model": "none", "trace": step("respond", started, level=level, model="none")}

    if len(state["messages"]) == 1:
        await cache.put(last_question(state), answer.text)  # the next visitor asking this gets it instantly
    ms = round((time.perf_counter() - started) * 1000)
    used = {"calls": 1, "tokens_in": answer.tokens_in, "tokens_out": answer.tokens_out, "latency_ms": ms,
            "switches": answer.depth, "trims": int(answer.trimmed), f"level_{level}": 1}
    return {"messages": [AIMessage(answer.text)], "model": answer.model, "usage": used,
            "trace": step("respond", started, level=level, model=answer.model, tried=answer.tried, depth=answer.depth)}


_last_alert = 0.0


def alert_exhausted() -> None:
    """Tells Sentry the free models are all used up — at most every 10 minutes per server."""
    global _last_alert
    if time.time() - _last_alert > 600:
        _last_alert = time.time()
        sentry_sdk.capture_message("All free models are used up — the chat is paused for everyone", level="warning")


# ── wiring ──────────────────────────────────────────────────────────────────

builder = StateGraph(State)
builder.add_node("route", route)
builder.add_node("retrieve", retrieve)
builder.add_node("rerank", rerank_docs)
builder.add_node("respond", respond)
builder.add_edge(START, "route")
builder.add_conditional_edges("route", lambda s: "retrieve" if s["intent"] == "question" else END)
builder.add_edge("retrieve", "rerank")
builder.add_edge("rerank", "respond")
builder.add_edge("respond", END)
agent = builder.compile()
