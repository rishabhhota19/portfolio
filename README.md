# Rishabh Hota — portfolio + recruiter agent

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
                                                               respond  Groq gpt-oss → Gemini → … (fallback chain)
```

Chat memory lives only in the browser tab. When a chat ends, only an AI summary goes to a Google Sheet (never the transcript).

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
Keys live in `.env.local` (template: `.env.example`). Without LLM keys the agent runs in mock mode.

## After editing content
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
