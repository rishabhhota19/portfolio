"""Asking a failed eval case once more, and when.

One answer is one sample of a writer, so the model evals ask a case that failed on form a second time and count the
failure only if it happens twice (each eval says which failures are never excused: a leak, an invented number,
forbidden content).

The second ask waits for the usual writer. The provider rate-limits the level's first-choice model now and then
(seven 429s in one CI run, 15 Nov 2026); the agent then rests that model for a minute and a smaller one stands in,
as it should for a visitor. But a stand-in's answer is not what these evals were written against: in three runs in
a row a stand-in's long or loosely worded reply failed a case that the usual writer passes every time. So when the
failed answer came from a stand-in, the second ask comes after the rest is over.
"""

import asyncio

from agent import llm
from agent.graph import UNANSWERED

RESTING = 65  # seconds: a rate-limited writer rests for 60 (router.on_error)
NOT_A_WRITER = ("router", "bank", "cache", "", *UNANSWERED)


def stood_in(level: str, model: str) -> bool:
    """Was this answered by a writer other than the level's first choice?"""
    if not level or model in NOT_A_WRITER:
        return False
    pool = llm.candidates(level)
    return bool(pool) and model != pool[0].name


async def wait(level: str, model: str, usual: float) -> None:
    """The pause before a second ask: the usual one, or long enough for a rested first-choice writer to be back."""
    await asyncio.sleep(RESTING if stood_in(level, model) else usual)
