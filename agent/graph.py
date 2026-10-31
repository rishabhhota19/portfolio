"""The agent, as a LangGraph graph.

    START ─► route ─(question)─► retrieve ─► rerank ─► respond ─► END
               └──(greeting / contact / off-topic / prompt injection)──► canned reply ─► END

The router answers simple messages without calling an LLM, which saves the free-tier quota.
The respond step walks the free models (see llm.py); the visitor never sees which one answered.
"""

import operator
import re
import time
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, SystemMessage
from langgraph.graph import END, START, StateGraph, add_messages

from . import llm
from .prompts import SITE, system_prompt
from .rag import rerank, search


class State(TypedDict, total=False):
    messages: Annotated[list, add_messages]  # the conversation (the browser sends it each turn)
    intent: str
    docs: list[dict]  # retrieved chunks
    model: str  # which LLM answered
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


def route(state: State) -> dict:
    started = time.perf_counter()
    intent = classify(last_question(state))
    if intent in CANNED:
        return {"intent": intent, "model": "router", "messages": [AIMessage(CANNED[intent])], "trace": step("route", started, intent=intent)}
    return {"intent": intent, "trace": step("route", started, intent=intent)}


# ── 2. retrieve + 3. rerank ─────────────────────────────────────────────────

async def retrieve(state: State) -> dict:
    started = time.perf_counter()
    docs = await search(last_question(state, turns=2))  # previous question helps with follow-ups
    return {"docs": docs, "trace": step("retrieve", started, found=[d["id"] for d in docs])}


async def rerank_docs(state: State) -> dict:
    started = time.perf_counter()
    docs, method = await rerank(last_question(state, turns=2), state["docs"])
    return {"docs": docs, "trace": step("rerank", started, method=method, kept=[d["id"] for d in docs])}


# ── 4. respond ──────────────────────────────────────────────────────────────

async def respond(state: State) -> dict:
    started = time.perf_counter()
    prompt = [SystemMessage(system_prompt(state["docs"])), *state["messages"][-12:]]
    tried = []

    for m in llm.CHAT_MODELS:
        sent = await llm.fit(m, prompt)  # None = no budget left (or no key); else the prompt, trimmed to fit
        if sent is None:
            continue
        tried.append(m.name)
        text = ""
        try:
            async for chunk in m.client().astream(sent):  # tokens stream to the browser as they arrive
                text += chunk.text
        except Exception as err:
            if not text:  # failed before answering: pause it and silently try the next model
                await llm.on_error(m, err)
                continue
        await llm.record(m, sent)  # token tracking (an empty reply still used quota)
        if text.strip():
            trimmed = len(prompt) - len(sent)
            return {"messages": [AIMessage(text)], "model": m.name, "trace": step("respond", started, model=m.name, tried=tried, trimmed_turns=trimmed)}

    # Every free model is used up: the API answers 503 and the chat pauses for everyone until limits reset.
    return {"model": "none", "trace": step("respond", started, model="none", tried=tried)}


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
