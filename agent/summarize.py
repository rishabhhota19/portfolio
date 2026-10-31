"""End-of-chat summary for Rishabh's Google Sheet. The transcript itself is never stored."""

import json
import re

from langchain_core.messages import HumanMessage, SystemMessage

from . import llm
from .prompts import SUMMARY_PROMPT


async def summarize(messages: list[dict], lead: dict | None = None) -> dict:
    transcript = "\n".join(f"{'Visitor' if m['role'] == 'user' else 'Agent'}: {m['content']}" for m in messages)
    if lead:
        transcript += f"\n(Visitor shared their details: {json.dumps(lead)})"

    for name, model in llm.available(llm.SUMMARY_MODELS):
        try:
            reply = await model.ainvoke([SystemMessage(SUMMARY_PROMPT), HumanMessage(transcript)])
        except Exception as err:
            llm.cool_down(name, err)
            continue
        match = re.search(r"\{.*\}", reply.text, re.S)
        if match:
            try:
                return {**json.loads(match.group()), "model": name}
            except json.JSONDecodeError:
                pass  # malformed JSON: try the next model

    asked = [m["content"][:80] for m in messages if m["role"] == "user"]
    return {"summary": "Visitor asked: " + "; ".join(asked), "topics": ", ".join(asked[:6]), "model": "none"}
