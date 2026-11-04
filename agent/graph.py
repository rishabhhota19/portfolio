"""Dumbledore, the agent, as a LangGraph graph. One conversation is one agent session (a thread): its memory is
loaded at the start of every turn and saved at the end, whichever model or server answers.

    START ─► route ─(question)─► retrieve ─► scope ─(in scope)─► rerank ─► recall ─► plan ─► respond ─► check ─► remember ─► END
               │                               ├──(off topic: refusal)──► END          ▲      │
               │                               └──(answer bank hit)─────► END          └─ act ◄┘  (the research loop)
               └──(refused / canned / "take me to …" / repeated question)───────────────────► END

The refusal pipeline (guard.py) runs through it: route = Gate 1 (rules), scope = Gate 2 (meaning), respond = Gate 3
(the prompt), check = Gate 4 (output) and Gate 5 (what gets cached). Questions answered before respond cost no tokens.
The research loop (research.py) is the agent's own search: a planner model breaks a hard question into points and
searches the site for each with tools; a simple question is one point and one search, no planner. Memory (memory.py)
keeps each point's evidence and a summary of the earlier turns, so a long chat sends a few hundred tokens of history
instead of a dozen messages, and nothing is researched twice.

Model routing is per call, not per agent: each step draws on its own pool of free models (llm.py) through the
router, so the agent keeps its character and its memory while the model underneath changes. Economy mode (the
day's quota running thin, or a chat that has spent a lot) skips the planner and shortens the answer; when every
model is out, the agent still answers in character from the evidence in hand. It degrades; it never stops.

Dumbledore also acts on the page (pages.py): it navigates the visitor when asked ("take me to his projects") and
offers "take me there" links for the pages an answer is about. The visitor never sees which model answered.
"""

import operator
import re
import time
from dataclasses import replace
from typing import Annotated, Any, TypedDict

import sentry_sdk

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph, add_messages

from . import cache, embeddings, guard, llm, memory as session, pages, research, router, scope as gate2, usage
from .difficulty import difficulty
from .prompts import system_prompt
from .rag import rerank, search


class State(TypedDict, total=False):
    messages: Annotated[list, add_messages]  # the conversation (the browser sends it each turn)
    intent: str  # question, refused, navigate, cached, bank, or a canned one (greeting, contact, …)
    why: str  # which gate refused, or what the output guard removed
    level: str  # L1 / L2 / L3 — how hard the question is (difficulty.py)
    docs: list[dict]  # retrieved chunks
    engine: Any  # the embedding route that answered (embeddings.py), or None: keyword search only
    vector: Any  # the question's embedding (scope check + answer bank)
    context_vector: Any  # follow-ups: the previous + this question together (what retrieval searched with)
    relevance: float  # how close the best chunk is in meaning, 0–1
    model: str  # which LLM answered (or router / cache / bank)
    usage: dict  # real tokens in/out, latency, switches — added to the visit's totals
    actions: list[dict]  # what Dumbledore does on the page: navigate, links
    trace: Annotated[list[dict], operator.add]  # one entry per step, for logs
    # The agent session (memory.py, research.py)
    memory: Any  # this conversation's memory: points researched so far, a summary of the earlier turns, its spend
    economy: bool  # the day's quota is thin or this chat has spent a lot: no planner, shorter prompt and answer
    rounds: int  # planner rounds this turn
    planner: list  # the planner's own messages (its brief, tool calls and results) — never shown to the visitor
    calls: list[dict]  # tool calls waiting for act
    points: dict  # this turn's research: point → evidence ids and a note
    found: list[dict]  # chunks the research found beyond the first search
    empty: list[str]  # points the last round found nothing for
    notes: str  # the research block the writer sees
    research_usage: dict  # the planner's tokens (added to the turn's totals)


def step(name: str, started: float, **details) -> list[dict]:
    return [{"step": name, "ms": round((time.perf_counter() - started) * 1000), **details}]


def last_question(state: State, turns: int = 1) -> str:
    questions = [m.content for m in state["messages"] if m.type == "human"]
    return "\n".join(questions[-turns:])


def fresh(state: State) -> bool:
    """Nothing before this question but starter quick answers (the browser shows those itself): the question still
    starts the conversation, so the cache, the answer bank and the first-turn rules apply. Writing to the cache stays
    first-turn only, because the answer was written with the starters in view."""
    return all(m.additional_kwargs.get("starter") for m in state["messages"][:-1])


def first_turn(state: State) -> bool:
    return len(state["messages"]) == 1


def say(text: str, intent: str, started: float, name: str, **extra) -> dict:
    """A reply that didn't need an LLM."""
    return {"intent": intent, "model": extra.pop("model", "router"), "messages": [AIMessage(text)],
            "trace": step(name, started, intent=intent, **{k: v for k, v in extra.items() if k == "why"}), **extra}


# ── 1. route (Gate 1) ───────────────────────────────────────────────────────

async def route(state: State) -> dict:
    started = time.perf_counter()
    question = last_question(state)
    intent = guard.classify(question, fresh(state))
    if intent in guard.REFUSED:
        return say(guard.reply_for(intent), "refused", started, "route", why=f"rules:{intent}")
    if intent != "question":
        return say(guard.reply_for(intent), intent, started, "route")

    nav = pages.navigation(question)
    # focus = the visitor only wants to see the page (phones then step the full-screen chat aside)
    actions = [{"type": "navigate", "path": nav["path"], "label": nav["label"], "focus": nav["pure"]}] if nav else []
    if nav and nav["pure"]:  # "take me to his projects" — nothing else to answer
        return say(f"Taking you to **{nav['label']}**. Ask me anything about it.", "navigate", started, "route", actions=actions)
    if fresh(state) and (hit := await cache.get(question)):
        return say(hit["text"], "cached", started, "route", model="cache", actions=actions or link_actions(hit["links"]))
    level = difficulty(question, len(state["messages"]) - 1)
    return {"intent": "question", "level": level, "actions": actions, "trace": step("route", started, intent=intent, level=level)}


# ── 2. retrieve + 3. scope (Gate 2) + 4. rerank ─────────────────────────────

async def retrieve(state: State) -> dict:
    started = time.perf_counter()
    query, question = last_question(state, turns=2), last_question(state)  # previous question helps with follow-ups
    engine, vectors = await embeddings.embed([query] if query == question else [query, question])  # one call for both
    docs, relevance = await search(query, None if vectors is None else vectors[0])
    vector = None if vectors is None else vectors[-1]
    context_vector = None if vectors is None or query == question else vectors[0]
    return {"docs": docs, "engine": engine, "vector": vector, "context_vector": context_vector, "relevance": relevance,
            "trace": step("retrieve", started, found=[d["id"] for d in docs], relevance=round(relevance, 3),
                          embeddings=engine.name if engine else "none (keywords only)")}


async def scope(state: State) -> dict:
    started = time.perf_counter()
    relevance = state.get("relevance", 0.0)
    in_scope, gap = gate2.judge(last_question(state), state.get("vector"), relevance)  # the question on its own, normal margin
    if not in_scope and state.get("context_vector") is not None:
        # A follow-up ("give me the link of the paper") leans on the chat: refuse it only if it's off-topic on its
        # own AND together with the previous question.
        in_scope, gap = gate2.judge(last_question(state, turns=2), state["context_vector"], relevance, follow_up=True)
    if not in_scope:
        return say(guard.REFUSAL, "refused", started, "scope", why=f"scope:{gap}")
    if fresh(state) and (hit := cache.from_bank(state.get("vector"))):
        links = link_actions(hit["links"], skip=state.get("actions", []))
        return say(hit["text"], "bank", started, "scope", model="bank", actions=state.get("actions", []) + links)
    return {"trace": step("scope", started, gap=gap)}


async def rerank_docs(state: State) -> dict:
    started = time.perf_counter()
    docs, method = await rerank(last_question(state, turns=2), state["docs"], top_n=6)  # each level uses 2, 4 or 6
    return {"docs": docs, "trace": step("rerank", started, method=method, kept=[d["id"] for d in docs])}


# ── the agent session: recall before the research loop, remember after the answer ──────────

ECONOMY_WATCH = ("groq-120b", "groq-qwen", "cf-120b")  # the writers whose day running out puts everyone in economy mode


async def recall(state: State, config: RunnableConfig) -> dict:
    """Loads this conversation's memory (its thread id) and decides whether the turn runs in economy mode."""
    started = time.perf_counter()
    thread = (config.get("configurable") or {}).get("thread_id") or ""
    mem = await session.load(thread) if thread else session.Memory()
    economy = mem.economy or await usage.thin([llm.M[n] for n in ECONOMY_WATCH])
    return {"memory": mem, "economy": economy,
            "trace": step("recall", started, turns=mem.turns, points=len(mem.points), economy=economy)}


async def remember(state: State, config: RunnableConfig) -> dict:
    """Folds the turn into the conversation's memory and saves it: the next turn, on any model and any server,
    continues from here."""
    started = time.perf_counter()
    thread = (config.get("configurable") or {}).get("thread_id") or ""
    mem: session.Memory = state.get("memory") or session.Memory()
    mem.remember(last_question(state), research.turn_points(state), (state.get("usage") or {}).get("tokens_counted", 0))
    if thread:
        await session.save(thread, mem)
    return {"memory": mem, "trace": step("remember", started, turns=mem.turns, points=len(mem.points), saved=bool(thread))}


def fallback_answer(state: State) -> str:
    """Every free model is out of budget. Dumbledore still answers, in character, from the evidence in hand — and
    still offers the next step. Nothing a model wrote, so no budget is charged for it."""
    lines = ["Every model I work with is busy this minute, so here is the short version straight from his site:"]
    seen: set[str] = set()
    for d in research.evidence(state, 4):
        if d["url"] not in seen:
            seen.add(d["url"])
            lines.append(f"- **{d['title']}** — [read more]({d['url']})")
    lines.append("Ask me again in a minute for the full answer. Meanwhile his [résumé](/resume) is one click away, and "
                 "**Share your details** below gets you a reply from Rishabh himself.")
    return "\n".join(lines)


# ── 5. respond (Gate 3: the prompt) ─────────────────────────────────────────

async def respond(state: State) -> dict:
    started = time.perf_counter()
    level = state["level"]
    tier = llm.TIERS[level]
    mem: session.Memory = state.get("memory") or session.Memory()
    notes = state.get("notes") or mem.notes()
    if state.get("economy"):  # fewer chunks, fewer turns, a shorter answer: the same agent on a tighter budget
        tier = replace(tier, chunks=min(tier.chunks, 4), max_tokens=min(tier.max_tokens, 400), history=4)
    keep = min(tier.history, 4) if mem.summary else tier.history  # the memory's summary carries the older turns
    history = state["messages"][-keep:]
    docs = research.evidence(state, tier.chunks)  # this turn's evidence first, then the first search, then the rest

    def prompt_for(m: llm.FreeModel, second_opinion: bool = False):
        """Context shifting: the level's chunks and turns, trimmed (older turns first, then chunks) until it fits m."""
        for chunks in sorted({tier.chunks, min(tier.chunks, 4), 2}, reverse=True):
            system, turns = SystemMessage(system_prompt(docs[:chunks], second_opinion, notes)), list(history)
            while turns:
                prompt = [system, *turns]
                if llm.fits(m, llm.estimate_tokens(prompt), tier.max_tokens):
                    return prompt, chunks < tier.chunks or len(turns) < len(history)
                turns = turns[1:]  # drop the oldest turn …
                while turns and turns[0].type != "human":
                    turns = turns[1:]  # … and keep the conversation starting with a visitor message
        return None

    answers = [await router.run(llm.candidates(level), tier, prompt_for)]
    if answers[0] and guard.is_refusal(answers[0].text) and re.search(guard.ABOUT_HIM_OR_SITE, last_question(state), re.I):
        # Second opinion: smaller models sometimes refuse real questions about him ("does he have a US visa?").
        # The question already passed Gates 1–2, so ask a *different* model once, with a note; Gate 4 still applies.
        others = [m for m in llm.candidates(level) if m.name != answers[0].model]
        if retry := await router.run(others, tier, lambda m: prompt_for(m, second_opinion=True)):
            answers.append(retry)
    answer = answers[-1]
    planner = state.get("research_usage") or {}  # the planner's tokens count towards the turn
    if answer is None:
        # Every free model is out of budget: the agent answers from what it has (fallback_answer) instead of a 503,
        # and Sentry hears about it.
        alert_exhausted()
        return {"messages": [AIMessage(fallback_answer(state))], "model": "fallback", "usage": dict(planner),
                "trace": step("respond", started, level=level, model="fallback")}

    ms = round((time.perf_counter() - started) * 1000)
    used = {"calls": len(answers) + planner.get("calls", 0),
            "tokens_in": sum(a.tokens_in for a in answers) + planner.get("tokens_in", 0),
            "tokens_out": sum(a.tokens_out for a in answers) + planner.get("tokens_out", 0),
            "tokens_cached": sum(a.cached for a in answers),
            "tokens_counted": sum(a.counted for a in answers) + planner.get("tokens_counted", 0),
            "latency_ms": ms, "switches": answer.depth,
            "trims": int(answer.trimmed), f"level_{level}": 1}
    return {"messages": [AIMessage(answer.text)], "model": answer.model, "usage": used,
            "trace": step("respond", started, level=level, model=answer.model, tried=answer.tried, depth=answer.depth,
                          chunks=len(docs), history=len(history), economy=bool(state.get("economy")))}


# ── 6. check (Gate 4: output, Gate 5: cache) ────────────────────────────────

async def check(state: State) -> dict:
    started = time.perf_counter()
    last = state["messages"][-1]
    if last.type != "ai":  # no model answered (respond returned model "none")
        return {}
    text = last.content
    if why := guard.check(text):  # code or leaked instructions: replace the whole answer
        return {"messages": [AIMessage(guard.REFUSAL, id=last.id)], "intent": "refused", "why": f"output:{why}",
                "trace": step("check", started, blocked=why)}
    safe = guard.clean(text)  # unknown links, long numbers, IDs, other people's emails removed
    if guard.is_refusal(safe):
        return {"intent": "refused", "why": "prompt", "trace": step("check", started, refused=True)}

    links = pages.links_for(safe, research.evidence(state, 8), skip={a["path"] for a in state.get("actions", [])})
    update: dict = {"actions": state.get("actions", []) + link_actions(links), "trace": step("check", started, links=len(links))}
    if safe != text:
        update["messages"] = [AIMessage(safe, id=last.id)]
        update["why"] = "output:cleaned"
    elif first_turn(state):
        await cache.put(last_question(state), safe, links)  # Gate 5: only a clean, in-scope, first-turn answer
    return update


def link_actions(links: list[dict], skip: list[dict] = ()) -> list[dict]:
    taken = {a["path"] for a in skip}
    links = [link for link in links if link["path"] not in taken]
    return [{"type": "links", "links": links}] if links else []


_last_alert = 0.0


def alert_exhausted() -> None:
    """Tells Sentry the free models are all used up — at most every 10 minutes per server."""
    global _last_alert
    if time.time() - _last_alert > 600:
        _last_alert = time.time()
        sentry_sdk.capture_message("All free models are used up — the chat is paused for everyone", level="warning")


# ── wiring ──────────────────────────────────────────────────────────────────

builder = StateGraph(State)
for name, node in [("route", route), ("retrieve", retrieve), ("scope", scope), ("rerank", rerank_docs), ("recall", recall),
                   ("plan", research.plan), ("act", research.act), ("respond", respond), ("check", check), ("remember", remember)]:
    builder.add_node(name, node)
builder.add_edge(START, "route")
builder.add_conditional_edges("route", lambda s: "retrieve" if s["intent"] == "question" else END)
builder.add_edge("retrieve", "scope")
builder.add_conditional_edges("scope", lambda s: "rerank" if s["intent"] == "question" else END)
builder.add_edge("rerank", "recall")
builder.add_edge("recall", "plan")
builder.add_conditional_edges("plan", lambda s: "act" if s.get("calls") else "respond")  # the research loop
builder.add_edge("act", "plan")
builder.add_edge("respond", "check")
builder.add_edge("check", "remember")
builder.add_edge("remember", END)
agent = builder.compile()
