# Rishabh Hota — portfolio + recruiter agent

[![Agent evals](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml/badge.svg)](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml) · **Live: [rishabh-hota.vercel.app](https://rishabh-hota.vercel.app)**

A Next.js portfolio with an AI agent that answers recruiters' questions about Rishabh.
The AI pipeline is **Python** (LangGraph + LangChain): hybrid RAG with **FAISS + BM25**, **re-ranking**, a chain of
**free LLMs**, and **RAGAS** evals. Runs on free tiers at 10k+ visitors a month.

```
Browser ─► Next.js gateway  (app/api/chat/route.ts)          security: bot check, input validation,
             │                                               rate limits, daily budget
             ▼  shared secret
           Python agent  (api/index.py → agent/graph.py)     LangGraph:
             route ─► retrieve ─► rerank ─► respond            route    canned replies, no LLM (greeting/contact/injection)
                                                               retrieve FAISS (meaning) + BM25 (keywords) → RRF
                                                               rerank   bge-reranker cross-encoder → top 4
                                                               respond  Groq → Gemini → OpenRouter (7 free models),
                                                                        then a facts-only answer — never goes offline
```

Chat memory lives only in the browser tab. When a chat ends, only an AI summary goes to a Google Sheet (never the transcript).

## Why it's built this way
- **Hybrid retrieval.** Embeddings understand paraphrases but can miss exact names ("LCSNet", "RBKnee"); BM25 is the
  opposite. Reciprocal Rank Fusion merges the two rankings without having to calibrate their very different scores.
- **Re-ranking.** First-stage search is fast but shallow. A cross-encoder reads the question and each chunk *together*,
  so the final 4 chunks the LLM sees are the most relevant ones.
- **Router before the LLM.** Greetings, contact questions and prompt-injection attempts get instant canned replies —
  zero tokens, zero hallucination risk.
- **Fallback chain, then facts.** Free tiers rate-limit, so availability beats a single "best" model: when one of the
  7 models (Groq, Gemini, OpenRouter) fails it is skipped for a while and the next answers. If all are busy, the agent
  quotes the most relevant retrieved chunk with a link — the chat never goes offline.
- **Security in the gateway, AI in Python.** Bot checks, rate limits and the daily budget sit in front of the agent;
  the Python service only accepts calls carrying a shared secret, and stays small and testable. A Vercel Firewall rule
  adds a per-IP limit at the edge.
- **Grounded answers, measured.** The prompt forbids guessing or embellishing; the evals check facts and guardrails on
  every content change, and RAGAS scores faithfulness.

## Code map
| Path | What it does |
|---|---|
| `agent/graph.py` | The LangGraph agent: the 4 nodes and how they connect |
| `agent/rag.py` | FAISS + BM25 hybrid search, Reciprocal Rank Fusion, cross-encoder re-ranking |
| `agent/llm.py` | Free models in priority order, with cooldowns when one fails |
| `agent/prompts.py` | System prompt (grounding + guardrail rules) and summary prompt |
| `agent/build_index.py` | Chunks the content, embeds it (Gemini), saves the FAISS index |
| `api/index.py` | FastAPI: `/api/agent/chat` (streams), `/api/agent/summarize`, `/api/agent/health` |
| `evals/run_evals.py` | Retrieval / fact / guardrail checks over `evals/questions.json` |
| `evals/ragas_eval.py` | RAGAS: faithfulness, answer relevancy, context precision |
| `app/api/*` | Next.js gateway: security checks, then calls the Python agent; logging + lead email |
| `content/` | All site text. The same files feed the pages and the agent |

## Run locally
```bash
npm install
py -3.13 -m venv .venv && .venv\Scripts\activate && pip install -r requirements-dev.txt
npm run agent      # Python agent on :8000   (terminal 1, venv active)
npm run dev        # site on :3000           (terminal 2)
```
Keys live in `.env.local` (template: `.env.example`). Without LLM keys the agent answers from the retrieved facts only.

## After editing content
Just push — CI rebuilds the FAISS index and redeploys. To rebuild it locally instead:
```bash
npm run agent:index   # rebuilds knowledge.json + the FAISS index in agent/data/ — commit them
```

## Evals
```bash
npm run evals         # checks; writes evals/results.jsonl
npm run evals:ragas   # RAGAS scores on those results (Gemini as the judge)
```

## Deploy (Vercel, free)
Push to `main`; Vercel builds the site and the Python function (`requirements.txt`).
Set the variables from `.env.example` in Vercel (except `AGENT_URL`).

## CI
`.github/workflows/agent.yml` runs on every change to `content/`, `agent/` or `evals/` (and weekly): it rebuilds the
FAISS index — committing it if the content changed, which redeploys the site — then runs the evals and RAGAS and
uploads the results. Needs the `GROQ_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` repository secrets.
