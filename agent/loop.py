"""The agent loop: one model with tools decides each turn's steps (branch `agentic`, 19 Nov 2026).

    gate: today's rule replies (canned lines, keyword refusals) that the judge can set aside; the judge's own
          declines (JUDGE=enforce); the exact cache and the answer bank on a first turn. Nothing else answers before
          the model.
    judge (in parallel): scope, distress, and how much the answer needs → the pool (fact / usual / reasoning)
    pre-read: the question's own search (the gate embedded it for the scope check: the same vectors, the same vote)
          is in the first prompt as FROM HIS SITE. The model writes from it when it answers the question and searches
          for what it doesn't — it never writes about something specific from memory of the profile alone (CI, 19 Nov
          2026: a writer that skipped the search gave the teddy bear no stories and Smartknower no Power BI).
    ─► round: the model reads persona + PAGES + PROFILE + memory + FROM HIS SITE + the chat, and calls tools or writes
         search_site(query)  the best passages of his site for one topic (vectors, the vote)
         open_page(path)     a page in full
         navigate(path)      moves the visitor's page (one of PAGES)
         book()              opens the booking card
    ─► … up to MAX_ROUNDS rounds, MAX_SEARCHES searches, the request's deadline; economy mode: one round
    ─► the reply (streams) ─► graph.check (output guard, grounding on what the agent read) ─► remember

What used to be decided by rules in the graph — how hard a question is, whether and what to search, which page to
show, where the research loop runs — is now the judge's verdict or the agent's own call. The gates keep only the
place the judge already gave them: the keyword rules and the scope bank (off-topic by meaning) as first filters the
judge sets aside when it is sure (rescue), its own declines in enforce mode, and the whole gate when no judge is
available. A writer's refusal or care signal gets
a second opinion from the level above; two refusals of a question the judge is sure is about him end in our "the
site doesn't say" line; an empty reply gets one more writer, then the short version from the site — never nothing.
Fixed on purpose: the gateway's security, the tool allow-list (pages.PATHS), the budgets, the output guard.
"""

import asyncio
import re
import time

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from . import cache, embeddings, guard, judge, llm, pages, rag, router, scope as gate2, usage
from .memory import MAX_NOTE, Memory
from .prompts import SECOND_OPINION, agent_prompt
from .research import docs_by_id, open_page, search_site

MAX_ROUNDS = 3  # tool rounds before the model must write
# The reply's hidden first line (what the contract eval measures each model on).
BRIEF_LINE = r"^[\s*_]*BRIEF:.*\|[\s*_]*SHOW:"
# How a reply may start, as the gateway checks it (a reply that starts otherwise is dropped for another model's): the
# BRIEF line, or — rules 7 and 10 of the prompt — the refusal sentence alone or the care mark alone, which carry no
# BRIEF line. Requiring BRIEF on every reply dropped the models that refused off-topic questions correctly and let
# through the ones that wrote a BRIEF line and answered them (CI scope eval, 27 Nov: 10 "no model", 2 leaks).
REPLY_START = (rf"{BRIEF_LINE}|^[\s*_\"]*{re.escape(guard.REFUSAL[:40])}|^[\s*_]*{re.escape(guard.CARE_MARK)}[\s*_.]*$")
MAX_SEARCHES = 8  # searches a turn
MIN_TIME = 8  # seconds left before the deadline below which no new round starts
LEVELS = {"fact": "L1", "usual": "L2", "reasoning": "L3"}  # the judge's reading of what the answer needs → the pool
STRONGER = {"L1": "L2", "L2": "L3", "L3": "L3"}


TOOLS = [search_site, open_page]  # the page and the booking card are the reply's first line (BRIEF … | SHOW: …)
BY_NAME = {t.name: t for t in TOOLS}


def passages(docs: list[dict]) -> str:
    return "\n\n".join(f"[{d['id']}] {d['title']} (page: {d['url']})\n{d['text']}" for d in docs) or "(nothing found)"


def _step(name: str, started: float, **details) -> list[dict]:
    return [{"step": name, "ms": round((time.perf_counter() - started) * 1000), **details}]


def _say(text: str, intent: str, started: float, **extra) -> dict:
    """A reply that didn't need the model."""
    return {"intent": intent, "model": extra.pop("model", "router"), "messages": [AIMessage(text)], "read": 0,
            "trace": _step("respond", started, intent=intent, **{k: v for k, v in extra.items() if k == "why"}), **extra}


def _fresh(state: dict) -> bool:
    return all(m.additional_kwargs.get("starter") for m in state["messages"][:-1])


def _question(state: dict) -> str:
    return next((m.content for m in reversed(state["messages"]) if m.type == "human"), "")


TOOL_TEXT = re.compile(r"<tool_call>|<function=|\"tool_calls\"\s*:|^\s*\{\s*\"name\"\s*:\s*\"(search_site|open_page|navigate|book)\"", re.I | re.M)


def empty(text: str) -> bool:
    """Nothing for the visitor in it: blank, the old hidden line alone, a reply that talks about that line, or a tool
    call written out as text (Nemotron Super did that when asked to write with no tools bound, CI 19 Nov 2026)."""
    return not guard.clean(text).strip() or guard.check(text) == "hidden_line" or bool(TOOL_TEXT.search(text))


async def gate(state: dict, question: str, started: float) -> dict | None:
    """What answers before the model, or None (with what the gate learned in state) when the model runs."""
    intent = guard.classify(question)
    rescued = False
    if intent in guard.REFUSED:
        judge.ask()
        verdict = await judge.verdict(judge.REFUSAL_WAIT) if judge.rescues() else None
        if not (verdict and verdict.rescues):
            return _say(guard.reply_for(intent), "refused", started, why=f"rules:{intent}")
        rescued = True  # the judge is sure this is about him: a keyword's refusal is set aside
    elif intent != "question":  # a canned line never asks the judge; "how do I reach him?" also opens the booking card
        return _say(guard.reply_for(intent), intent, started, **({"actions": [dict(pages.BOOK)]} if intent == "contact" else {}))
    if moved := pages.move(question):  # "go back", "scroll down": a page command the chat does where the visitor is
        return _say(pages.MOVE_REPLY[moved], "navigate", started, actions=[{"type": "ui", "move": moved}])
    if _fresh(state) and (hit := await cache.get(question)):
        return _say(hit["text"], "cached", started, model="cache", actions=[{"type": "links", "links": hit["links"]}] if hit.get("links") else [])
    judge.ask()
    # Gate 2 as today: off-topic by meaning (the scope bank, one matrix product) unless the judge, where it is sure,
    # says otherwise; in enforce mode the judge's own lines come first. The question is embedded once, for this and
    # for the answer bank.
    _, vectors = await embeddings.embed([question])
    vector = None if vectors is None else vectors[0]
    found, relevance = await rag.search(question, vector) if vector is not None else ([], 0.0)
    in_scope, gap = gate2.judge(question, vector, relevance)
    verdict = await judge.verdict(judge.REFUSAL_WAIT if not in_scope else judge.WAIT)
    rescued = rescued or (not in_scope and judge.rescues() and bool(verdict and verdict.rescues))
    if verdict is not None and verdict.calm and judge.enforces() and not rescued:
        # Where the judge is sure, our own line and no model: small talk, or a message that is plainly not about him.
        if talk := verdict.small_talk:
            return _say(guard.TALK[talk], talk if talk in guard.CANNED else "talk", started, why=f"judge:{talk}", actions=[])
        if kind := verdict.declined:
            if kind == "attack":
                return _say(guard.CANNED["injection"], "refused", started, why="judge:attack", actions=[])
            return _say(guard.decline(kind, question), "refused", started, why=f"judge:{kind}", actions=[])
    if not in_scope and not rescued:
        return _say(guard.REFUSAL, "refused", started, why=f"scope:{gap}")
    if _fresh(state) and vector is not None and (hit := cache.from_bank(vector)):
        return _say(hit["text"], "bank", started, model="bank", actions=[{"type": "links", "links": hit["links"]}] if hit.get("links") else [])
    state["rescued"] = rescued
    # The pre-read: the search the gate already ran, put through the second vote, is what the model reads first.
    state["preread"] = (await rag.rerank(question, found, top_n=4))[0] if found else []
    return None


def level_for(verdict) -> str:
    return LEVELS.get(getattr(verdict, "complexity", "") or "", "L2")


async def second_look(state: dict, reply: str) -> str:
    """Did the writer turn away something it should have answered? "" for no; else which note the second opinion
    carries: "sure" when the judge has read the message, "soft" on the old hint alone (graph.second_look, ported)."""
    verdict = await judge.verdict(judge.REFUSAL_WAIT)
    if guard.is_care(reply):
        return "sure" if verdict and verdict.calm and verdict.about_him and not verdict.rider else ""
    if not guard.is_refusal(reply) or state.get("rescued"):
        return ""
    if verdict and verdict.about_him and not verdict.rider:
        return "sure"
    return "soft" if re.search(guard.ABOUT_HIM_OR_SITE, _question(state), re.I) else ""


def _remember(read: list[dict], docs: list[dict]) -> None:
    seen = {d["id"] for d in read}
    for d in docs:
        if d["id"] not in seen:
            seen.add(d["id"])
            read.append(d)


def fallback(read: list[dict]) -> str:
    """Every free model is out of budget. Dumbledore still answers, in character, from the evidence in hand."""
    lines = ["Every model I work with is busy this minute, so here is the short version straight from his site:"]
    seen: set[str] = set()
    for d in read[:4]:
        if d["url"] not in seen:
            seen.add(d["url"])
            lines.append(f"- **{d['title']}** — [read more]({d['url']})")
    lines.append("Ask me again in a minute for the full answer. Meanwhile his [résumé](/resume) is one click away, and "
                 "**Share your details** below gets you a reply from Rishabh himself.")
    return "\n".join(lines)


class Turn:
    """One turn's working state: what the agent read and did, and what it cost."""

    def __init__(self, state: dict, level: str):
        self.state, self.level = state, level
        self.memory: Memory = state.get("memory") or Memory()
        self.tier = llm.TIERS[level]
        self.economy = bool(state.get("economy"))
        keep = min(self.tier.history, 4) if self.memory.summary else self.tier.history
        self.history = list(state["messages"][-keep:])
        while self.history and self.history[0].type != "human":
            self.history = self.history[1:]
        self.actions: list[dict] = list(state.get("actions") or [])
        # What the gate's search found for this message: read before the first round, and remembered like a search.
        self.preread: list[dict] = list(state.get("preread") or [])
        self.read: list[dict] = list(self.preread)
        self.points: dict = {}
        if self.preread:
            question = _question(state)
            self.points[question[:80]] = {"ids": [d["id"] for d in self.preread[:2]], "note": self.preread[0]["title"][:MAX_NOTE]}
        self.transcript: list = []  # this turn's tool calls and results: never part of the visitor's conversation
        self.used = {"calls": 0, "tokens_in": 0, "tokens_out": 0, "tokens_counted": 0, "tokens_cached": 0}
        self.tried: list[str] = []
        self.model = "none"
        self.searches = 0
        self.rounds = 0
        self.brief = ""
        self.show = ""  # the page (or "book", or "stay") the reply's first line chose

    def prompt_for(self, note: str, final: bool):
        def build(m: llm.FreeModel):
            system = SystemMessage(agent_prompt(self.level, self.memory.notes(), note, final=final, economy=self.economy,
                                                context=passages(self.preread) if self.preread else ""))
            turns = list(self.history)
            # No reminder note after the tool results: one that repeated the first line and the length rule cut the
            # page moves from 94% to 87%, and 84% once it listed when to stay (showing eval through the gateway, 27 Nov).
            while turns:
                prompt = [system, *turns, *self.transcript]
                if llm.fits(m, llm.estimate_tokens(prompt), self.tier.max_tokens):
                    return prompt, len(turns) < len(self.history)
                turns = turns[1:]
                while turns and turns[0].type != "human":
                    turns = turns[1:]
            return None
        return build

    def count(self, reply: router.Answer) -> None:
        self.model = reply.model
        self.used["calls"] += 1
        self.used["tokens_in"] += reply.tokens_in
        self.used["tokens_out"] += reply.tokens_out
        self.used["tokens_counted"] += reply.counted
        self.used["tokens_cached"] += reply.cached
        self.tried.extend(reply.tried)

    async def run_tools(self, calls: list[dict]) -> list[ToolMessage]:
        """One round's tool calls: searches in parallel; page moves and the booking card become actions."""

        async def one(call: dict) -> str:
            name, args = call["name"], dict(call.get("args") or {})
            if name == "search_site":
                if self.searches >= MAX_SEARCHES:
                    return "Search budget used up for this turn: answer from what you have."
                self.searches += 1
                query = " ".join(str(args.get("query", "")).split())[:200]
                known = self.memory.known(query)
                docs = docs_by_id(known["ids"]) if known and known.get("ids") else await search_site.ainvoke({"query": query})
                self.points[query[:80]] = {"ids": [d["id"] for d in docs[:2]], "note": docs[0]["title"][:MAX_NOTE] if docs else ""}
                _remember(self.read, docs)
                return passages(docs)
            if name == "open_page":
                docs = open_page.invoke({"path": str(args.get("path", ""))})
                _remember(self.read, docs)
                return passages(docs[:4])
            return "Unknown tool."

        results = await asyncio.gather(*(one(c) for c in calls), return_exceptions=True)
        return [ToolMessage(content=r if isinstance(r, str) else f"{c['name']} failed; answer from what you have.",
                            tool_call_id=c.get("id") or c["name"]) for c, r in zip(calls, results)]

    async def write(self, level: str, note: str = "", exclude: str = "") -> str | None:
        """Rounds of tools, then the reply, from this level's pool. None when no model was free."""
        rounds_allowed = 1 if self.economy else MAX_ROUNDS
        models = [m for m in llm.candidates(level) if m.name != exclude]
        # The tools stay bound in every round: asked to write with none bound, Nemotron Super wrote the call syntax
        # out as its reply (CI, 19 Nov 2026). The last round only tells the model to write; a call it makes anyway is
        # run, and the round after that is the end.
        for round_no in range(rounds_allowed + 2):
            final = round_no >= rounds_allowed or (usage.time_left() or 99) < MIN_TIME
            reply = await router.run(models, self.tier, self.prompt_for(note, final), tools=TOOLS, role=f"writer-{level}",
                                     exclude=exclude, contract=REPLY_START)
            if reply is None:
                return None
            self.count(reply)
            self.rounds += 1
            calls = [c for c in (reply.message.tool_calls if reply.message is not None else []) if c["name"] in BY_NAME]
            if calls and round_no <= rounds_allowed:
                self.transcript.append(reply.message)
                self.transcript.extend(await self.run_tools(calls))
                continue
            # The first line is the agent's decision about the page and the booking card ("BRIEF: … | SHOW: <path|stay|book>"):
            # kept for graph.check, which turns it into the page move or the card; the visitor never sees the line.
            self.brief, self.show, text = guard.read_brief(reply.text)
            return text
        return ""


async def respond(state: dict) -> dict:
    """The agent's turn: the gate, then rounds of tools and one reply, on the pool the judge's verdict picks."""
    started = time.perf_counter()
    question = _question(state)
    if gated := await gate(state, question, started):
        return gated
    verdict = await judge.verdict(0)  # in by now, or not: never waited for twice
    turn = Turn(state, level_for(verdict))
    why, show, intent = ("judge:rescued" if state.get("rescued") else ""), "", "question"

    answer = await turn.write(turn.level)
    if answer is not None and (look := await second_look(state, answer)):
        # Smaller models sometimes refuse real questions about him, or take a figure of speech for distress: a
        # different model from the level above answers once more, with a note; the output guard still applies.
        retry = await turn.write(STRONGER[turn.level], note=SECOND_OPINION[look], exclude=turn.model)
        answer = retry if retry is not None else answer
    if answer is not None and empty(answer):
        retry = await turn.write(STRONGER[turn.level], exclude=turn.model)  # one more writer, no note
        answer = retry if retry is not None else answer
    if answer and guard.is_refusal(answer) and not state.get("rescued") and judge.rescues():
        verdict = await judge.verdict(judge.REFUSAL_WAIT)
        if verdict and verdict.rescues:  # never a flat no to a question the judge is sure is about him
            answer, why, show, intent = guard.NOT_ON_SITE, "judge:not_on_site", "stay", "not_on_site"
    if answer is None or empty(answer):
        if not turn.read:  # nothing searched yet: one plain search, so the short version has something to stand on
            _remember(turn.read, await search_site.ainvoke({"query": question}))
        answer, turn.model = fallback(turn.read), "fallback"

    ms = round((time.perf_counter() - started) * 1000)
    return {"messages": [AIMessage(answer)], "intent": intent, "model": turn.model, "level": turn.level, "docs": turn.read,
            "read": len(turn.read), "points": turn.points, "actions": turn.actions, "show": show or turn.show, "brief": turn.brief,
            **({"why": why} if why else {}), **({"rescued": True} if state.get("rescued") else {}),
            "usage": {**turn.used, "latency_ms": ms, "switches": 0, "trims": 0, f"level_{turn.level}": 1},
            "trace": _step("respond", started, level=turn.level, model=turn.model, rounds=turn.rounds, searches=turn.searches,
                           preread=len(turn.preread), read=len(turn.read), tried=turn.tried, economy=turn.economy,
                           judge=verdict.summary() if verdict else None)}
