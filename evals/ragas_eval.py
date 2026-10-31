"""RAGAS scores for the agent's answers. Run after `python -m evals.run_evals`:

    python -m evals.ragas_eval

  faithfulness       is every claim in the answer backed by the retrieved chunks? (catches hallucinations)
  answer_relevancy   does the answer actually address the question?
  context_precision  were the retrieved chunks the useful ones? (judges retrieval + re-ranking)

A free Gemini model is the judge. Results are saved to evals/ragas_results.csv.
"""

import asyncio
import csv
import json
import sys
import types
from pathlib import Path

# ragas 0.4 imports a module that newer langchain-community removed. We don't use it, so stub it out.
_stub = types.ModuleType("langchain_community.chat_models.vertexai")
_stub.ChatVertexAI = type("ChatVertexAI", (), {})
sys.modules.setdefault("langchain_community.chat_models.vertexai", _stub)

from openai import AsyncOpenAI  # noqa: E402
from ragas.embeddings import OpenAIEmbeddings  # noqa: E402
from ragas.llms import llm_factory  # noqa: E402
from ragas.metrics.collections import AnswerRelevancy, ContextPrecisionWithoutReference, Faithfulness  # noqa: E402

from agent.config import env  # noqa: E402

HERE = Path(__file__).parent

client = AsyncOpenAI(api_key=env("GOOGLE_GENERATIVE_AI_API_KEY"), base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
judge = llm_factory("gemini-flash-lite-latest", client=client)
embeddings = OpenAIEmbeddings(client=client, model="gemini-embedding-001")

METRICS = {
    "faithfulness": Faithfulness(llm=judge),
    "answer_relevancy": AnswerRelevancy(llm=judge, embeddings=embeddings),
    "context_precision": ContextPrecisionWithoutReference(llm=judge),
}


async def score(row: dict) -> dict:
    result = {"id": row["id"]}
    for name, metric in METRICS.items():
        args = {"user_input": row["question"], "response": row["answer"]}
        if name != "answer_relevancy":
            args["retrieved_contexts"] = row["contexts"]
        try:
            result[name] = round((await metric.ascore(**args)).value, 3)
        except Exception as err:
            result[name] = None
            print(f"  {row['id']} {name}: failed ({type(err).__name__})")
        await asyncio.sleep(2)  # stay inside the judge's free-tier rate limit
    return result


async def main() -> None:
    rows = [json.loads(line) for line in open(HERE / "results.jsonl", encoding="utf-8")]
    rows = [r for r in rows if r["kind"] == "fact" and r["contexts"]]  # RAG answers only (router replies have no context)

    scored = []
    for row in rows:  # one at a time: gentle on the free tier
        scored.append(await score(row))
        print(" ".join(f"{k}={v}" for k, v in scored[-1].items()))

    with open(HERE / "ragas_results.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["id", *METRICS])
        writer.writeheader()
        writer.writerows(scored)

    print("\nAverages:")
    for name in METRICS:
        values = [s[name] for s in scored if s[name] is not None]
        print(f"  {name:<18} {sum(values) / len(values):.2f}  (n={len(values)})" if values else f"  {name:<18} n/a")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
