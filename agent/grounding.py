"""The grounding check: a second model reads the finished answer against what it was written from, and corrects
what the sources do not support, before the answer is final.

    answer + SOURCES (PROFILE and the passages the writer had) ─► checker model (cheap, high-quota pool, never Groq)
      ─► {"unsupported": [claims quoted from the answer], "answer": the answer with them corrected or removed}
      ─► accepted only when each quoted claim really is in the answer, and the rewrite passes the output guard and
         keeps the answer's size ─► the corrected answer replaces the streamed one (api/index.py sends "replace")

Why: the small writers mix results between projects when two sit close in their context. "LCSNet achieved 98%
accuracy on osteoarthritis X-ray grading" was said on the live site (LCSNet: dental caries, F1 71.7% and IoU 56.8%;
the 98% is the osteoarthritis project). Retrieval now puts the right paper first, and PROFILE still names both; this
check reads the finished answer and the sources together, which the writer never does. The model decides what is
unsupported; the code only checks that the checker quoted the answer and that its rewrite is safe to show.

The check fails open: no model with budget, a slow one, malformed JSON, a claim the checker did not quote, or a
rewrite that fails its own checks all leave the answer as written, with the reason in the turn's trace.
evals/grounding_eval.py measures it on answers with planted mistakes; --dry checks the acceptance rules alone.
"""

import asyncio
import json
import re
import time
from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage

from . import gateway, guard, llm, router
from .config import env
from .prompts import GROUNDING_PROMPT, KNOWLEDGE

TIER = llm.Tier(chunks=0, history=0, max_tokens=700, effort="low", timeout=10, pool=llm.GROUNDING_POOL)
HEDGE_AFTER = 1.5  # seconds: the first checker gets this long alone, then the second is asked too and the first reply wins
MAX_GROWTH = 1.35  # a rewrite may not grow past this times the answer (plus a few words): a correction swaps or removes
MIN_KEPT = 0.35  # nor shrink below this share of it: a one-line stub is not a corrected answer
SMART = str.maketrans("‘’“”", "''\"\"")


@dataclass
class Grounding:
    text: str  # the answer as it stands after the check
    fixed: list[str] = field(default_factory=list)  # the claims corrected, as the checker quoted them
    why: str = "ok"  # ok | fixed | skipped:<reason> | rejected:<reason>
    model: str = ""
    ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    counted: int = 0


def sources(docs: list[dict]) -> str:
    """What the writer had, in the writer's own layout (prompts.system_prompt): PROFILE, then the passages."""
    passages = "\n\n".join(f"[{d['id']}] {d['title']} (page: {d['url']})\n{d['text']}" for d in docs)
    return f"PROFILE\n{KNOWLEDGE['core']}\n\nCONTEXT\n{passages}"


def parse(reply: str) -> tuple[list[str], str] | None:
    """(unsupported claims, rewritten answer) from the checker's reply, or None when it is not the JSON asked for."""
    match = re.search(r"\{.*\}", reply, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group())
    except json.JSONDecodeError:
        return None
    claims, answer = data.get("unsupported"), data.get("answer")
    if not isinstance(claims, list) or not isinstance(answer, str):
        return None
    return [c for c in claims if isinstance(c, str) and c.strip()], answer


LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")  # [text](/path) reads as "text"
MARKS = re.compile(r"(\*\*|__|`|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w))")  # bold, italics, code marks
BULLET = re.compile(r"(?m)^\s*(?:[-*•]|\d+[.)])\s+")
DASHES = str.maketrans({"–": "-", "—": "-", " ": " "})


def visible(text: str) -> str:
    """The text as a reader sees it: no Markdown marks, link text without its address, no bullets, plain dashes and
    quotes, one space, lower case. A checker quotes what it reads, which is this, not the Markdown under it."""
    text = LINK.sub(r"\1", text.translate(SMART).translate(DASHES))
    text = BULLET.sub("", MARKS.sub("", text))
    return re.sub(r"\s+", " ", text).lower().strip(" .")


def quoted(claims: list[str], answer: str) -> list[str]:
    """The claims that really are in the answer. The checker must quote what it corrects, so a claim it imagined
    cannot trigger a rewrite. Compared as a reader sees both (visible), so bold or a link inside a sentence the
    checker quoted whole no longer hides it (the lcsnet-98 case was missed this way, 22 Nov 2026)."""
    haystack = visible(answer)
    return [c for c in claims if visible(c) and visible(c) in haystack]


def accept(answer: str, rewrite: str) -> str | None:
    """Why a rewrite may not replace the answer, or None when it may."""
    if not rewrite.strip():
        return "empty"
    if guard.check(rewrite):
        return "guard"
    if guard.is_refusal(rewrite):
        return "refusal"
    if len(rewrite) > MAX_GROWTH * len(answer) + 40:
        return "grew"
    if len(rewrite) < MIN_KEPT * len(answer):
        return "stub"
    return None


def decide(answer: str, reply: str) -> tuple[str, list[str], str]:
    """(the answer to show, the claims fixed, why) from the checker's reply. Pure: evals/grounding_eval.py --dry."""
    parsed = parse(reply)
    if parsed is None:
        return answer, [], "skipped:unparsed"
    claims, rewrite = parsed
    if not claims:
        return answer, [], "ok"
    real = quoted(claims, answer)
    if not real:
        return answer, [], "rejected:unquoted"
    rewrite = guard.clean(rewrite).strip()  # the same cleaning every answer gets: unknown links, long numbers
    if why := accept(answer, rewrite):
        return answer, [], f"rejected:{why}"
    return rewrite, real, "fixed"


async def check(question: str, answer: str, docs: list[dict]) -> Grounding:
    """The answer after the check. Never raises: whatever goes wrong, the answer as written comes back, with why.
    GROUNDING=off switches the check off (the scripted judge eval, an outage drill)."""
    if env("GROUNDING") == "off":
        return Grounding(answer, why="skipped:off")
    started = time.perf_counter()
    prompt = [SystemMessage(GROUNDING_PROMPT), HumanMessage(f"{sources(docs)}\n\nQUESTION\n{question}\n\nANSWER\n{answer}")]
    models = [llm.M[n] for n in TIER.pool if llm.M[n].available]
    fit = lambda m: (prompt, False) if llm.fits(m, llm.estimate_tokens(prompt), TIER.max_tokens) else None  # noqa: E731
    try:
        reply = await hedged(models, fit)
    except Exception as err:  # the router handles model errors itself; this is for anything else
        print(f"[grounding] skipped ({type(err).__name__}: {err})")
        reply = None
    ms = round((time.perf_counter() - started) * 1000)
    if reply is None:
        return Grounding(answer, why="skipped:no_model", ms=ms)
    text, fixed, why = decide(answer, reply.text)
    return Grounding(text, fixed, why, reply.model, ms, reply.tokens_in, reply.tokens_out, reply.counted)


_background: set[asyncio.Task] = set()  # a hedge's slower call finishes on its own, so the router settles its quota


async def hedged(models: list, fit) -> "router.Answer | None":
    """The checker's reply, as soon as one of the two best checkers gives it. The answer's page and links wait for this
    check, so its slow tail is the visitor's wait: the first checker gets HEDGE_AFTER seconds alone, then the second is
    asked too and whichever replies first is used (both caught 5/5 planted mistakes, 22 Nov 2026). The slower call is
    not cancelled (that would skip the router's quota bookkeeping); it finishes in the background. When neither has a
    reply (no budget, errors), the rest of the pool is tried in order."""
    if gateway.enabled():  # the gateway walks the checker pool itself
        return await router.run(models, TIER, fit, role="checker")
    ask = lambda pool: asyncio.ensure_future(router.run(pool, TIER, fit))  # noqa: E731
    first, second, rest = models[:1], models[1:2], models[2:]
    pending = {ask(first)} if first else set()
    if pending:
        done, pending = await asyncio.wait(pending, timeout=HEDGE_AFTER)
        if done and (reply := done.pop().result()) is not None:
            return reply
    if second:
        pending.add(ask(second))
    while pending:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if (reply := task.result()) is not None:
                for slower in pending:
                    _background.add(slower)
                    slower.add_done_callback(_background.discard)
                return reply
    return await router.run(rest, TIER, fit) if rest else None
