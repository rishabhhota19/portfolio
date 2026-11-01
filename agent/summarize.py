"""End-of-chat summary for Rishabh's Google Sheet. The transcript itself is never stored.

Summaries run on the router like answers, but only on cheap high-quota models (never Groq, which chat needs most);
if those are busy, a plain summary (no LLM) is used — so summaries can never starve the chat.
"""

import json
import re

from langchain_core.messages import HumanMessage, SystemMessage

from . import llm, router, usage
from .prompts import SUMMARY_PROMPT

TIER = llm.Tier(chunks=0, history=0, max_tokens=300, effort="low", timeout=15, pool=llm.SUMMARY_POOL)


async def summarize(messages: list[dict], lead: dict | None = None, session_id: str = "") -> dict:
    transcript = "\n".join(f"{'Visitor' if m['role'] == 'user' else 'Agent'}: {m['content']}" for m in messages)
    if lead:
        transcript += f"\n(Visitor shared their details: {json.dumps(lead)})"
    prompt = [SystemMessage(SUMMARY_PROMPT), HumanMessage(transcript)]

    models = [llm.M[n] for n in TIER.pool if llm.M[n].available]
    fit = lambda m: (prompt, False) if llm.fits(m, llm.estimate_tokens(prompt), TIER.max_tokens) else None  # noqa: E731
    answer = await router.run(models, TIER, fit)
    if answer:
        await usage.add_to_session(session_id, {"summary_tokens": answer.tokens_in + answer.tokens_out})
        match = re.search(r"\{.*\}", answer.text, re.S)
        if match:
            try:
                return {**json.loads(match.group()), "model": answer.model}
            except json.JSONDecodeError:
                pass  # malformed JSON: fall back to the plain summary

    asked = [m["content"][:80] for m in messages if m["role"] == "user"]
    return {"summary": "Visitor asked: " + "; ".join(asked), "topics": ", ".join(asked[:6]), "model": "none"}
