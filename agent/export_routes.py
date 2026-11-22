"""Exports the model registry (llm.py) as the gateway's routing table: cloudflare/gateway/routes.json.

    python -m agent.export_routes        (npm run gateway:routes)

The gateway (cloudflare/gateway/worker.ts) is the one place that calls the free models; llm.py stays the one place
that says which models exist, what their free limits are, and which pool each role draws on, best first. This file
turns the second into the first, so the two can never disagree. Re-run it after changing llm.py.

Roles the agent asks for (OpenAI "model" field "dumbledore/<role>"):
    writer-L1, writer-L2, writer-L3   the writers, by how hard the question is, each spilling into its neighbours (SPILL)
    planner                           the research planner (tool calls)
    checker                           the grounding check
    summary                           the end-of-chat summary
Keys never appear here: only the name of the variable holding each provider's key.
"""

import json
from pathlib import Path

from . import llm

OUT = Path(__file__).resolve().parent.parent / "cloudflare" / "gateway" / "routes.json"


def tier(t: llm.Tier, pool: list[str]) -> dict:
    return {"max_tokens": t.max_tokens, "effort": t.effort, "timeout": t.timeout, "pool": pool}


def routes() -> dict:
    roles = {}
    for level, t in llm.TIERS.items():
        spilled = list(dict.fromkeys(name for other in llm.SPILL[level] for name in llm.TIERS[other].pool))
        roles[f"writer-{level}"] = tier(t, spilled)
    roles["planner"] = tier(llm.RESEARCH, list(llm.RESEARCH.pool))
    roles["checker"] = {"max_tokens": 700, "effort": "low", "timeout": 10, "pool": list(llm.GROUNDING_POOL)}
    roles["summary"] = {"max_tokens": 500, "effort": "low", "timeout": 20, "pool": list(llm.SUMMARY_POOL)}
    used = {name for role in roles.values() for name in role["pool"]}
    models = {
        name: {
            "provider": m.provider, "model": m.model, "rpm": m.rpm, "rpd": m.rpd, "tpm": m.tpm, "tpd": m.tpd,
            "context": m.context, "neurons": list(m.neurons), "reasoning": m.reasoning, "extra": m.extra,
        }
        for name, m in llm.M.items() if name in used
    }
    providers = {name: {"url": url, "key": key, "limits": llm.PROVIDER_LIMITS.get(name, {})}
                 for name, (url, key, _) in llm.PROVIDERS.items() if any(m["provider"] == name for m in models.values())}
    return {"providers": providers, "models": models, "roles": roles}


def main() -> None:
    data = routes()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"routes: {len(data['roles'])} roles, {len(data['models'])} models, {len(data['providers'])} providers -> {OUT}")


if __name__ == "__main__":
    main()
