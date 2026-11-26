"""Measures each free model on the gateway's two contracts and writes what it finds as the gateway's routing data:
cloudflare/gateway/capabilities.json. Run with the gateway up (npm run gateway:dev, or GATEWAY_URL set):

    python -m evals.gateway_contract_eval            (npm run gateway:contracts)
    python -m evals.gateway_contract_eval groq-20b   only these models

For each model, alone (x-only-model), twice per contract:
    tools        given search_site and a question that needs it, does it make a real tool call? (a call typed out
                 as text is refused by the gateway, so it fails here)
    first_line   asked to start with the hidden "BRIEF: … | SHOW: …" line, does it? (the gateway enforces it)
A model passes a contract when it met it in at least one of the two tries; failing both marks it false, and the
gateway stops asking it for that contract. Nothing here is a hand-written rule about a model: the measurement decides.
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

from agent.config import env
from agent.loop import BRIEF_LINE

ROOT = Path(__file__).resolve().parent.parent
ROUTES = json.loads((ROOT / "cloudflare/gateway/routes.json").read_text(encoding="utf-8"))
OUT = ROOT / "cloudflare/gateway/capabilities.json"
TRIES = 2

SEARCH = {"type": "function", "function": {
    "name": "search_site", "description": "Search Rishabh's portfolio site for one topic; returns passages.",
    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}
TOOLS_ASK = [
    {"role": "system", "content": "You answer questions about Rishabh Hota from his portfolio site. You know nothing about "
                                  "him yourself: call search_site before answering."},
    {"role": "user", "content": "Which of his projects used LangGraph?"},
]
LINE_ASK = [
    {"role": "system", "content": "You are Dumbledore, the agent on Rishabh Hota's portfolio. Every reply starts with one "
                                  "hidden line, exactly: BRIEF: <what the visitor is deciding, under 10 words> | SHOW: "
                                  "<a page path, stay, or book>. Then the reply, in two sentences."},
    {"role": "user", "content": "Can I book a call with him about a RAG project?"},
]


async def ask(client: httpx.AsyncClient, name: str, messages: list, tools: list | None, contract: str | None) -> tuple[bool, int, str]:
    headers = {"authorization": f"Bearer {env('GATEWAY_KEY')}", "x-only-model": name}
    if contract:
        headers["x-contract-first-line"] = contract
    body = {"model": "dumbledore/writer-L2", "messages": messages, "max_tokens": 200, **({"tools": tools} if tools else {})}
    started = time.perf_counter()
    try:
        res = await client.post(f"{env('GATEWAY_URL')}/chat/completions", json=body, headers=headers, timeout=60)
    except httpx.HTTPError as err:
        return False, round((time.perf_counter() - started) * 1000), type(err).__name__
    ms = round((time.perf_counter() - started) * 1000)
    if res.status_code != 200:
        return False, ms, f"HTTP {res.status_code}"
    message = (res.json().get("choices") or [{}])[0].get("message") or {}
    if tools:
        return bool(message.get("tool_calls")), ms, "no tool call"
    return True, ms, ""


async def main() -> int:
    if not (env("GATEWAY_URL") and env("GATEWAY_KEY")):
        print("Set GATEWAY_URL and GATEWAY_KEY (the gateway must be running).")
        return 1
    wanted = [a for a in sys.argv[1:]] or list(ROUTES["models"])
    found = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    print(f"{'model':<26} {'tools':>7} {'first line':>11}   median ms")
    async with httpx.AsyncClient() as client:
        for name in wanted:
            row, times = {}, []
            for contract_name, messages, tools, contract in (("tools", TOOLS_ASK, [SEARCH], None),
                                                             ("first_line", LINE_ASK, None, BRIEF_LINE)):
                passed = 0
                for _ in range(TRIES):
                    ok, ms, why = await ask(client, name, messages, tools, contract)
                    passed += ok
                    times.append(ms)
                    if why.startswith("HTTP 503") and not ok:
                        break  # no budget or no key here right now: the next try would say the same
                row[contract_name] = passed > 0
                row[f"{contract_name}_passed"] = f"{passed}/{TRIES}"
            row["median_ms"] = sorted(times)[len(times) // 2]
            if not any(row[c] for c in ("tools", "first_line")) and row["median_ms"] < 100:
                # Refused at once, every time: no key here or the model isn't served, so nothing was measured. Left
                # unmarked, the gateway still asks it (and checks every reply) once it becomes available.
                row = {"unmeasured": "no answer (no key here, or the model is not served)", "median_ms": row["median_ms"]}
            row["measured"] = time.strftime("%Y-%m-%d")
            found[name] = row
            print(f"{name:<26} {row.get('tools_passed', '-'):>7} {row.get('first_line_passed', '-'):>11}   {row['median_ms']:>6}")
            await asyncio.sleep(1.5)  # gentle on the free per-minute limits
    OUT.write_text(json.dumps(found, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT} ({len(found)} models). Redeploy the gateway to use it.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
