"""The research step of the agent loop: work out what a question needs, gather evidence for each point from the
site, and hand the writer a checklist. LangChain tools, a planner model picked by the router (any tool-capable free
model, switched per call like every other), the tools run here in parallel.

    plan  rules first: a one-point question (one fact, the usual question) needs no model — the first search
          (graph.retrieve) is its evidence; a list of requirements (a job description) is searched point by point,
          also without a model. The planner model runs for the open reasoning questions (why hire him, the biggest
          risk, a comparison) and asks only for what the session memory hasn't found yet.
    act   runs the tool calls — search_site (hybrid search over the content index), open_page (a page's chunks) —
          skipping what's already in hand; a point the memory knows is answered from memory, with no search.

Budget: MAX_ROUNDS planner rounds and MAX_SEARCHES searches a turn, within the request's deadline. Economy mode
and a busy planner pool both mean the rules plan: the agent degrades, it never stops.
"""

import asyncio
import re
import time

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from . import llm, router, usage
from .memory import MAX_NOTE, Memory
from .pages import PATHS
from .prompts import RESEARCH
from .rag import load as load_index, search, tokenize

MAX_ROUNDS = 2  # the second round is for points the first found nothing for (other words)
MAX_SEARCHES = 8  # tool calls a planner round
LIST_SEARCHES = 14  # points of a list searched by rules (local, ~20 ms each; the chunks overlap, so few are new)
MIN_TIME = 20  # seconds left before the deadline below which the planner is skipped (the writer needs the rest)
BRIEF = 110  # characters of each passage the planner sees (it only maps points to ids; the writer reads them whole)


@tool
async def search_site(query: str) -> list[dict]:
    """Search Rishabh's site for one topic (a skill, a tool, a result, a role). Returns the best passages with ids."""
    docs, _ = await search(query, k=4)
    return docs


@tool
def open_page(path: str) -> list[dict]:
    """Read one of his pages in full, by its path from PAGES (e.g. /projects/collaterals-agent)."""
    clean = path.split("#")[0].rstrip("/") or "/"
    if clean not in PATHS:
        return []
    chunks, _ = load_index()
    return [c for c in chunks if c["url"].rstrip("/") == clean]


TOOLS = [search_site, open_page]
TOOL_NAMES = {t.name: t for t in TOOLS}


def questions(state: dict) -> list[str]:
    return [m.content for m in state["messages"] if m.type == "human"]


def docs_by_id(ids: list[str]) -> list[dict]:
    chunks, _ = load_index()
    by_id = {c["id"]: c for c in chunks}
    return [by_id[i] for i in ids if i in by_id]


def needs_planner(state: dict) -> bool:
    """The planner model is for reasoning questions (role fit, a job description, a comparison) when there's time,
    budget and a planner model to spare; everything else is a one-point question answered from the first search."""
    left = usage.time_left()
    return (state.get("level") == "L3" and not state.get("economy") and (left is None or left >= MIN_TIME)
            and any(llm.M[n].available for n in llm.RESEARCH.pool))


MIN_SPLIT = 3  # a list of at least this many points is searched point by point, no planner needed
NOT_A_POINT = re.compile(r"^(hiring|we are hiring|job|role|position|remote|hybrid|on-?site|full-?time|part-?time|contract|bengaluru|bangalore|"
                         r"hyderabad|mumbai|pune|delhi|india|usa|uk|europe|salary|ctc|lpa|esops?|benefits?)\b[\w\s/]*$", re.I)


def split_points(question: str) -> list[str]:
    """A job description or any list (commas, semicolons, bullets, "Must:" lines) split into its points — the
    requirements a hiring manager would tick off — with the question itself left out. Free: no model call."""
    body = re.sub(r"[^.?!;\n]*\?", " ", question)  # the questions asked ("Is he a fit?") aren't points to search
    body = re.sub(r"\s*\([^)]*(?:remote|hybrid|on-?site|bengaluru|bangalore|\d)[^)]*\)", "", body, flags=re.I)  # "(Bengaluru, 3–6 yrs)"
    points = []
    for part in re.split(r"[;\n••]|(?<!\d),|:\s|\.\s+", body):
        p = part.strip(" .-–")
        p = re.sub(r"^(must|nice to have|nice|required|requirements?|responsibilities|you'?ll|you will|we need|bonus)\s*[:\-–]?\s*", "", p, flags=re.I)
        p = re.sub(r"^(and|or|plus|with|also)\s+", "", p, flags=re.I).strip(" .-–")
        if p.count("(") != p.count(")"):
            p = p.replace("(", "").replace(")", "").strip()
        if (3 <= len(p) <= 70 and re.search(r"[a-z]{3}", p, re.I) and not NOT_A_POINT.match(p) and not re.match(r"\d|not\b", p, re.I)
                and p.lower() not in {q.lower() for q in points}):  # "4+ years…": the profile has his years; "not quarters": no point
            points.append(p)
    if len(points) > LIST_SEARCHES:
        # A full posting has more points than are searched. Taken evenly across it, not from the top: the must-haves
        # of a posting come after its company blurb, and the first 14 points of a 2,300-character one all sat in its
        # first 600 characters.
        step = len(points) / LIST_SEARCHES
        points = [points[int(i * step)] for i in range(LIST_SEARCHES)]
    return points


MODIFIERS = {  # words a requirement is wrapped in, not the requirement itself ("strong Python", "hands-on RAG experience")
    "strong", "solid", "deep", "proven", "good", "great", "excellent", "hands", "experience", "experienced", "skills", "skill",
    "knowledge", "familiar", "familiarity", "ability", "understanding", "background", "expertise", "working", "years", "year",
    "senior", "junior", "level", "basic", "advanced", "building", "build", "ship", "shipping", "own", "owning", "using", "use",
    "with", "our", "your", "their", "into", "across", "several", "multiple", "various", "etc", "like", "e.g", "eg", "ie",
}


def stem(word: str) -> str:
    """Enough stemming to match a requirement's word with the site's: tracing ~ traces, evals ~ evaluation, ViTs ~ ViT."""
    for suffix, keep in (("ations", "at"), ("ation", "at"), ("ings", ""), ("ing", ""), ("ies", "i"), ("es", ""), ("s", ""), ("ed", ""), ("ly", "")):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[:-len(suffix)] + keep
    return word


def covered(point: str, docs: list[dict]) -> bool:
    """Do the nearest chunks actually mention the point? Embeddings alone can't say (a word the site never uses still
    has a nearest chunk), so the point's own words must appear in them — by stem, in the text, title or keywords:
    every word, or three in five for longer points."""
    words = [w for w in dict.fromkeys(tokenize(point)) if w not in MODIFIERS]
    if not words:
        return bool(docs)
    if not docs:
        return False
    vocabulary = {stem(w) for w in tokenize(" ".join(f"{d['title']} {d['text']} {d.get('keywords', '')}" for d in docs))}

    def known(word: str) -> bool:
        s = stem(word)
        return s in vocabulary or (len(s) >= 4 and any(v.startswith(s) or s.startswith(v) for v in vocabulary if len(v) >= 4))

    hits = sum(1 for w in words if known(w))
    return hits == len(words) or (len(words) >= 2 and hits / len(words) >= 0.6)


def _brief(docs: list[dict]) -> str:
    return "\n".join(f"[{d['id']}] {d['title']} ({d['url']}): {' '.join(d['text'].split())[:BRIEF]}…" for d in docs) or "(nothing found)"


def _rules_points(state: dict) -> dict[str, dict]:
    """A one-point plan: the question itself, backed by the first search's best chunks."""
    docs = state.get("docs") or []
    point = " ".join(questions(state)[-1].split())[:80]
    return {point: {"ids": [d["id"] for d in docs[:2]], "note": docs[0]["title"][:MAX_NOTE] if docs else ""}}


def _trace(name: str, started: float, **details) -> list[dict]:
    return [{"step": name, "ms": round((time.perf_counter() - started) * 1000), **details}]


async def plan(state: dict) -> dict:
    """Round 0: decide between the rules plan and the planner model. Later rounds: give the planner its tool results
    and let it search again (only for points that found nothing) or finish."""
    started = time.perf_counter()
    memory: Memory = state.get("memory") or Memory()
    rounds = state.get("rounds", 0)
    points = dict(state.get("points") or {})
    if rounds == 0:
        if not needs_planner(state):
            points = _rules_points(state)
            return {"points": points, "calls": [], "rounds": 1, "notes": memory.notes(list(points)),
                    "trace": _trace("plan", started, planner="rules")}
        asked = questions(state)
        if len(listed := split_points(asked[-1])) >= MIN_SPLIT:
            # A list of requirements plans itself: one search per point, run by act, and no planner call at all.
            calls = [{"name": "search_site", "args": {"query": p}, "id": f"rules-{i}"} for i, p in enumerate(listed)]
            return {"planner": [], "calls": calls, "rounds": MAX_ROUNDS, "trace": _trace("plan", started, planner="list", searches=len(calls))}
        known = memory.notes() or "(nothing yet)"
        human = (f"ALREADY FOUND in this chat:\n{known}\n\n"
                 + (f"Earlier question: {asked[-2][:300]}\n" if len(asked) > 1 else "")
                 + f"Question now: {asked[-1][:2500]}")
        planner = [SystemMessage(RESEARCH), HumanMessage(human)]
    else:
        planner = list(state.get("planner") or [])
        empty = state.get("empty") or []
        if not empty or rounds >= MAX_ROUNDS or (usage.time_left() or 99) < MIN_TIME:
            return {"calls": [], "notes": memory.notes(list(points)), "trace": _trace("plan", started, planner="done", rounds=rounds)}
        planner.append(HumanMessage("Nothing was found for: " + "; ".join(empty[:4]) + ". Search once more for those points "
                                    "only, with other words his site would use — or reply done."))

    def prompt_for(m: llm.FreeModel):
        return (planner, False) if llm.fits(m, llm.estimate_tokens(planner), llm.RESEARCH.max_tokens) else None

    models = [llm.M[n] for n in llm.RESEARCH.pool if llm.M[n].available]
    answer = await router.run(models, llm.RESEARCH, prompt_for, tools=TOOLS)
    used = dict(state.get("research_usage") or {})  # every planner round counts towards the turn
    if answer:
        for key, amount in (("calls", 1), ("tokens_in", answer.tokens_in), ("tokens_out", answer.tokens_out), ("tokens_counted", answer.counted)):
            used[key] = used.get(key, 0) + amount
    calls = [c for c in (answer.message.tool_calls if answer and answer.message is not None else []) if c["name"] in TOOL_NAMES]
    if rounds:
        calls = calls[:len(state.get("empty") or []) + 1]  # a second round is for the points that found nothing
    if not calls:  # no planner model free, or it had nothing to add: the rules plan (or what's found so far)
        if rounds == 0:
            points = _rules_points(state)
        return {"points": points, "calls": [], "rounds": rounds + 1, "notes": memory.notes(list(points)), "research_usage": used,
                "trace": _trace("plan", started, planner=answer.model if answer else "rules", rounds=rounds + 1, searches=0)}
    planner.append(answer.message)
    return {"planner": planner, "calls": calls[:MAX_SEARCHES], "rounds": rounds + 1, "research_usage": used,
            "trace": _trace("plan", started, planner=answer.model, rounds=rounds + 1, searches=len(calls))}


async def act(state: dict) -> dict:
    """Runs the planner's tool calls in parallel, de-duplicated against what's in hand, and records each as a point."""
    started = time.perf_counter()
    memory: Memory = state.get("memory") or Memory()
    calls = state.get("calls") or []
    points = dict(state.get("points") or {})
    found = list(state.get("found") or [])
    seen = {d["id"] for d in (state.get("docs") or [])} | {d["id"] for d in found}
    empty: list[str] = []

    async def run(call: dict) -> list[dict]:
        point = str(call["args"].get("query") or call["args"].get("path") or "")
        if (known := memory.known(point)) and known.get("ids"):
            return docs_by_id(known["ids"])  # already researched earlier in this chat: no search
        try:
            return await TOOL_NAMES[call["name"]].ainvoke(call["args"])
        except Exception as err:
            print(f"[research] {call['name']} failed: {type(err).__name__}")
            return []

    results = await asyncio.gather(*(run(c) for c in calls))
    messages = []
    for call, docs in zip(calls, results):
        point = " ".join(str(call["args"].get("query") or call["args"].get("path") or "").split())[:80]
        if call["name"] == "search_site" and not covered(point, docs):
            docs = []  # the nearest chunks don't mention it: "not on the site" is the honest note, not a stretch
        if docs or call["name"] == "search_site":  # a page with nothing indexed isn't a point to remember or retry
            points[point] = {"ids": [d["id"] for d in docs[:2]], "note": docs[0]["title"][:MAX_NOTE] if docs else ""}
        if not docs and call["name"] == "search_site":
            empty.append(point)
        for d in docs:
            if d["id"] not in seen:
                seen.add(d["id"])
                found.append(d)
        messages.append(ToolMessage(content=_brief(docs), tool_call_id=call["id"]))
    return {"planner": list(state.get("planner") or []) + messages, "found": found, "points": points, "empty": empty, "calls": [],
            "trace": _trace("act", started, searched=[p for p in points if p not in (state.get("points") or {})], found=len(found))}


def evidence(state: dict, limit: int) -> list[dict]:
    """The chunks the writer gets, best first: every point's best chunk, then each point's second, then the first
    search's, then the rest — so a long list of requirements shares the room instead of the first few taking it all."""
    docs, found = list(state.get("docs") or []), list(state.get("found") or [])
    by_id = {d["id"]: d for d in docs + found}
    ids_by_point = [p.get("ids", []) for p in (state.get("points") or {}).values()]
    cited = [ids[n] for n in range(2) for ids in ids_by_point if len(ids) > n]
    missing = [i for i in cited if i not in by_id]
    if missing:
        by_id.update({d["id"]: d for d in docs_by_id(missing)})
    ordered, out = [*cited, *(d["id"] for d in docs), *(d["id"] for d in found)], []
    for i in ordered:
        if i in by_id and by_id[i] not in out:
            out.append(by_id[i])
    return out[:limit]


def turn_points(state: dict) -> dict[str, dict]:
    return dict(state.get("points") or {})
