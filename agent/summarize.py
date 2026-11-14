"""End-of-chat summary for Rishabh's Google Sheet. The transcript itself is never stored.

Summaries run on the router like answers, but only on cheap high-quota models (never Groq, which chat needs most);
if those are busy, no summary comes back and the gateway writes a plain one — so summaries can never starve the chat.

Only the chat goes to a model. What a visitor types into "Share your details" (name, email, phone, note) goes to the
Sheet and Rishabh's inbox and nowhere else: the gateway adds it to the row itself.
"""

import json
import re

from langchain_core.messages import HumanMessage, SystemMessage

from . import llm, router, usage
from .prompts import SUMMARY_PROMPT

TIER = llm.Tier(chunks=0, history=0, max_tokens=300, effort="low", timeout=15, pool=llm.SUMMARY_POOL)
NO_SUMMARY = {"summary": "", "model": "none"}  # the gateway's plain summary takes over (lib/server/agent.ts)


async def summarize(messages: list[dict], session_id: str = "") -> dict:
    transcript = "\n".join(f"{'Visitor' if m['role'] == 'user' else 'Agent'}: {m['content']}" for m in messages)
    prompt = [SystemMessage(SUMMARY_PROMPT), HumanMessage(transcript)]

    models = [llm.M[n] for n in TIER.pool if llm.M[n].available]
    fit = lambda m: (prompt, False) if llm.fits(m, llm.estimate_tokens(prompt), TIER.max_tokens) else None  # noqa: E731
    answer = await router.run(models, TIER, fit)
    if not answer:
        return NO_SUMMARY
    await usage.add_to_session(session_id, {"summary_tokens": answer.tokens_in + answer.tokens_out})
    match = re.search(r"\{.*\}", answer.text, re.S)
    try:
        return {**json.loads(match.group()), "model": answer.model} if match else NO_SUMMARY
    except json.JSONDecodeError:
        return NO_SUMMARY  # malformed JSON
