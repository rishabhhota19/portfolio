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

import json
import re
import time
from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage

from . import guard, llm, router
from .prompts import GROUNDING_PROMPT, KNOWLEDGE

TIER = llm.Tier(chunks=0, history=0, max_tokens=700, effort="low", timeout=10, pool=llm.GROUNDING_POOL)
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


def quoted(claims: list[str], answer: str) -> list[str]:
    """The claims that really are in the answer. The checker must quote what it corrects, so a claim it imagined
    cannot trigger a rewrite."""
    flat = lambda s: re.sub(r"\s+", " ", s.translate(SMART)).lower().strip(" .")  # noqa: E731
    haystack = flat(answer)
    return [c for c in claims if flat(c) and flat(c) in haystack]


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
    """The answer after the check. Never raises: whatever goes wrong, the answer as written comes back, with why."""
    started = time.perf_counter()
    prompt = [SystemMessage(GROUNDING_PROMPT), HumanMessage(f"{sources(docs)}\n\nQUESTION\n{question}\n\nANSWER\n{answer}")]
    models = [llm.M[n] for n in TIER.pool if llm.M[n].available]
    fit = lambda m: (prompt, False) if llm.fits(m, llm.estimate_tokens(prompt), TIER.max_tokens) else None  # noqa: E731
    try:
        reply = await router.run(models, TIER, fit)
    except Exception as err:  # the router handles model errors itself; this is for anything else
        print(f"[grounding] skipped ({type(err).__name__}: {err})")
        reply = None
    ms = round((time.perf_counter() - started) * 1000)
    if reply is None:
        return Grounding(answer, why="skipped:no_model", ms=ms)
    text, fixed, why = decide(answer, reply.text)
    return Grounding(text, fixed, why, reply.model, ms, reply.tokens_in, reply.tokens_out, reply.counted)
