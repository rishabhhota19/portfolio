"""Builds the answer bank: common recruiter questions → checked answers, served instantly by cache.from_bank().

    python -m agent.build_answers            # CI runs it after build_index; a no-op when nothing changed

1. Intents: the fact questions in evals/questions.json (each has checks) and content/starters.json (hand-written).
2. Paraphrases: 8 ways a recruiter might ask each one, written once by a free LLM and kept in answers.json.
3. Answers: each fact question is asked through the real agent (bank off). An answer is kept only if it passes that
   question's eval checks and the output guard — a wrong answer never gets in. Starters keep their own answers.
4. Every intent and paraphrase is embedded → answers.npz. Answers are rebuilt when the content changes.
"""

import asyncio
import json
import os
import re
from pathlib import Path

os.environ["ANSWER_BANK"] = "off"  # answers come from the live agent, not from an older bank

import numpy as np  # noqa: E402
from langchain_core.messages import HumanMessage  # noqa: E402

from . import guard, llm, pages  # noqa: E402
from .cache import VERSION  # noqa: E402
from .config import DATA_DIR  # noqa: E402
from .embeddings import PRIMARY  # noqa: E402 — the bank's vectors come from the primary engine

ROOT = Path(__file__).parent.parent
META, VECTORS = DATA_DIR / "answers.json", DATA_DIR / "answers.npz"
SMART_QUOTES = str.maketrans("‘’“”", "''\"\"")


def intents() -> list[dict]:
    facts = [c for c in json.loads((ROOT / "evals/questions.json").read_text(encoding="utf-8")) if c["kind"] == "fact"]
    starters = json.loads((ROOT / "content/starters.json").read_text(encoding="utf-8"))
    return [{"q": c["q"], "include": c.get("include", []), "exclude": c.get("exclude", [])} for c in facts] + \
           [{"q": s["q"], "text": s["a"], "source": "starter"} for s in starters]


async def paraphrase(questions: list[str]) -> list[list[str]]:
    prompt = ("For each question below, write 8 different ways a recruiter might ask the SAME question about Rishabh "
              "(same meaning, varied wording; some short, some casual; use 'he', 'his' or 'Rishabh'). Return ONLY JSON: "
              f"a list of {len(questions)} lists of 8 strings, in order.\n\n" + "\n".join(f"{i + 1}. {q}" for i, q in enumerate(questions)))
    for name in ("gemini-lite-3.5", "gemini-lite-3.1", "groq-120b"):
        try:
            reply = await llm.M[name].client(6000, timeout=90).ainvoke([HumanMessage(prompt)])
            lists = json.loads(re.search(r"\[.*\]", reply.text, re.S).group())
            if len(lists) == len(questions):
                return [[p.strip() for p in ps if isinstance(p, str)][:8] for ps in lists]
        except Exception as err:
            print(f"paraphrasing with {name} failed: {err}")
    raise RuntimeError("no free model could write the paraphrases")


def passes(intent: dict, answer: str) -> bool:
    text = answer.translate(SMART_QUOTES)
    return (bool(answer.strip()) and not guard.is_refusal(answer) and guard.check(answer) is None and guard.clean(answer) == answer
            and all(re.search(p, text, re.I) for p in intent["include"]) and not any(re.search(p, text, re.I) for p in intent["exclude"]))


async def main() -> None:
    from .graph import agent  # imported here so ANSWER_BANK=off is set first

    old = json.loads(META.read_text(encoding="utf-8")) if META.exists() else {"version": "", "intents": []}
    known = {i["q"]: i for i in old["intents"]}
    wanted = intents()

    new = [i["q"] for i in wanted if not known.get(i["q"], {}).get("paraphrases")]
    written = dict(zip(new, await paraphrase(new))) if new else {}

    bank = []
    for intent in wanted:
        before = known.get(intent["q"], {})
        entry = {"q": intent["q"], "paraphrases": written.get(intent["q"]) or before.get("paraphrases", [])}
        if intent.get("source") == "starter":
            entry |= {"text": intent["text"], "links": pages.links_for(intent["text"], []), "source": "starter"}
        elif old["version"] == VERSION and before.get("text"):
            entry |= {k: before[k] for k in ("text", "links", "source")}  # content unchanged: keep the checked answer
        else:
            state = await agent.ainvoke({"messages": [HumanMessage(intent["q"])]})
            answer = state["messages"][-1].content if state["messages"][-1].type == "ai" else ""
            if not passes(intent, answer):
                print(f"  skipped (failed its checks): {intent['q']}")
                continue
            links = next((a["links"] for a in state.get("actions", []) if a["type"] == "links"), [])
            entry |= {"text": answer, "links": links, "source": state.get("model", "")}
            await asyncio.sleep(3)  # stay inside the free per-minute limits
        bank.append(entry)

    if bank == old["intents"] and old["version"] == VERSION and old.get("model") == PRIMARY.model and VECTORS.exists():
        print(f"Answer bank already up to date ({len(bank)} intents).")
        return
    texts, owner = [], []
    for n, entry in enumerate(bank):
        for t in [entry["q"], *entry["paraphrases"]]:
            texts.append(t)
            owner.append(n)
    vectors = await PRIMARY.embed(texts, timeout=60)
    np.savez(VECTORS, vectors=vectors, intent=np.array(owner, dtype="int16"))
    META.write_text(json.dumps({"version": VERSION, "model": PRIMARY.model, "intents": bank}, indent=1, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    print(f"Answer bank: {len(bank)} intents, {len(texts)} phrasings (content version {VERSION}) -> {META.name}")


if __name__ == "__main__":
    asyncio.run(main())
