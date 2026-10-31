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

    prompt = [SystemMessage(SUMMARY_PROMPT), HumanMessage(transcript)]
    for m in llm.SUMMARY_MODELS:
        sent = await llm.fit(m, prompt, max_tokens=300)  # same budgets as chat, so summaries can't starve it
        if sent is None:
            continue
        try:
            reply = await m.client(max_tokens=300).ainvoke(sent)
        except Exception as err:
            await llm.on_error(m, err)
            continue
        await llm.record(m, sent, max_tokens=300)
        match = re.search(r"\{.*\}", reply.text, re.S)
        if match:
            try:
                return {**json.loads(match.group()), "model": m.name}
            except json.JSONDecodeError:
                pass  # malformed JSON: try the next model

    asked = [m["content"][:80] for m in messages if m["role"] == "user"]
    return {"summary": "Visitor asked: " + "; ".join(asked), "topics": ", ".join(asked[:6]), "model": "none"}
