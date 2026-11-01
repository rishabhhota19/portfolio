# Rishabh Hota — portfolio + recruiter agent

[![Agent evals](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml/badge.svg)](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml) · **Live: [rishabh-hota.vercel.app](https://rishabh-hota.vercel.app)**

A Next.js portfolio with an AI agent that answers recruiters' questions about Rishabh.
The AI pipeline is **Python** (LangGraph + LangChain): hybrid RAG with **FAISS + BM25**, a **4-level routing web of
15 free LLMs** across Groq, Gemini, Cloudflare Workers AI and OpenRouter, and **RAGAS** evals. ₹0/month.

```
Browser ─► Next.js gateway  (app/api/chat/route.ts)          security: bot check, input validation,
             │                                               rate limits, daily budget
             ▼  shared secret
           Python agent  (api/index.py → agent/graph.py)     LangGraph:
             route ─► retrieve ─► rerank ─► respond            route    L0: canned replies + answer cache (no LLM);
                                                                        else difficulty L1 / L2 / L3 (rules, 0 tokens)
                                                               retrieve FAISS (meaning) + BM25 (keywords) → RRF
                                                               rerank   top 2/4/6 by level (RRF order)
                                                               respond  the level's pool of free models; atomic
                                                                        budget reservation; switches are invisible
```

**Visit analytics.** Every visit (one browser tab) gets one row in the Google Sheet's *Sessions* tab: pages, active time,
source/UTM, clicks, city-level location, network (company or ISP), device — and, if they chat, the **real token counts**
the providers report (in/out, models, latency, summary tokens) plus an AI summary (never the transcript). Chat memory
lives only in the tab. When a recruiter shares their details, the same row gets them and you get an email (Resend if
`RESEND_API_KEY` is set, otherwise the Sheet's Apps Script sends it). IPs are blanked after 90 days; see `/privacy`.

## Why it's built this way
- **Hybrid retrieval.** Embeddings understand paraphrases but can miss exact names ("LCSNet", "RBKnee"); BM25 is the
  opposite. Reciprocal Rank Fusion merges the two rankings without having to calibrate their very different scores.
- **Re-ranking — measured, then switched off.** A cross-encoder reads the question and each chunk *together*, which
  usually beats first-stage search. But on this site's eval questions the only free one (Cloudflare's bge-reranker-base)
  tied RRF on hit@4 (100%) and ranked worse (MRR@4 0.885 vs 0.962) — it missed acronyms like "MCP". So production keeps
  the RRF order; `RERANKER=bge` (plus the Cloudflare keys) turns the re-ranker back on. Re-check with `npm run evals:rerank`.
- **Router before the LLM.** Greetings, contact questions and prompt-injection attempts get instant canned replies —
  zero tokens, zero hallucination risk.
- **A routing web of free models, by difficulty.** Questions get a level from plain rules (0 tokens): **L0**
  greetings/contact/repeats (no LLM), **L1** one fact (small fast models, 2 chunks), **L2** the usual question
  (4 chunks), **L3** reasoning such as role fit (strongest models, 6 chunks, longer answers). Each level has a pool of
  free models across 4 providers; if a pool is busy the router spills to the neighbouring level.
- **Reserve, then call — safe under concurrency.** Before calling a model, one atomic Redis (Lua) script checks every
  limit that applies — requests/tokens per minute, per hour and per day, plus shared pools like Cloudflare's 10,000
  neurons/day — and books the call only if all have room. A load simulator (`npm run evals:load`) with the real free
  limits shows it: at 50 simultaneous chatters, 0 rate-limit errors (vs 194 for check-then-count) and a 3.9 s median.
  Then the booking is corrected to the provider's real token count (Groq's own remaining quota is read from its
  headers). Pacing (≤3× a model's hourly share) only orders the models; 429s pause a model for the provider's
  retry-after; three outages in a minute trip a breaker for that provider. When every free model is out for the
  **day**, the chat pauses until the limits reset — never before.
- **Context shifting per model.** Each level's prompt is trimmed to fit the chosen model: older turns first, then
  fewer chunks — the profile always stays.
- **Security in the gateway, AI in Python.** Bot checks, rate limits and the daily budget sit in front of the agent;
  the Python service only accepts calls carrying a shared secret, and stays small and testable. A Vercel Firewall rule
  adds a per-IP limit at the edge.
- **Grounded answers, measured.** The prompt forbids guessing or embellishing; the evals check facts and guardrails on
  every content change, and RAGAS scores faithfulness.

## Code map
| Path | What it does |
|---|---|
| `agent/graph.py` | The LangGraph agent: the 4 nodes and how they connect |
| `agent/rag.py` | FAISS + BM25 hybrid search, Reciprocal Rank Fusion, optional cross-encoder re-ranking |
| `agent/llm.py` | The model web: every free model, its limits, and the pool for each difficulty level |
| `agent/difficulty.py` | L1 / L2 / L3 from plain rules (tested by `evals/difficulty.json`) |
| `agent/router.py` | Pick → reserve → call → settle; spill-over, pauses, breaker, the wait for per-minute limits |
| `agent/usage.py` | Atomic budget reservations (Redis Lua), pacing, per-visit token totals |
| `agent/cache.py` | Answers to repeated first questions, for a day (L0) |
| `agent/prompts.py` | System prompt (grounding + guardrail rules) and summary prompt |
| `agent/build_index.py` | Chunks the content, embeds it (Gemini), saves the FAISS index |
| `api/index.py` | FastAPI: `/api/agent/chat` (streams), `/api/agent/summarize`, `/api/agent/health` |
| `evals/run_evals.py` | Retrieval / fact / guardrail checks over `evals/questions.json` |
| `evals/ragas_eval.py` | RAGAS: faithfulness, answer relevancy, context precision |
| `evals/rerank_ab.py` | A/B: RRF order vs the cross-encoder re-ranker (hit@4, MRR@4) |
| `app/api/*` | Next.js gateway: security checks, then calls the Python agent; logging + lead email |
| `lib/visit.ts`, `app/api/visit` | The visit: tab session id, pages, clicks, active time → one Sessions row (sendBeacon) |
| `lib/server/visitor.ts`, `session.ts` | Location, device, network (IPinfo), returning visitor; combining a visit's chats |
| `content/` | All site text. The same files feed the pages and the agent |

## Run locally
```bash
npm install
py -3.13 -m venv .venv && .venv\Scripts\activate && pip install -r requirements-dev.txt
npm run agent      # Python agent on :8000   (terminal 1, venv active)
npm run dev        # site on :3000           (terminal 2)
```
Keys live in `.env.local` (template: `.env.example`). Without LLM keys the chat shows its "taking a short break" message.

## After editing content
Just push — CI rebuilds the FAISS index and redeploys. To rebuild it locally instead:
```bash
npm run agent:index   # rebuilds knowledge.json + the FAISS index in agent/data/ — commit them
```

## Evals
```bash
npm run evals         # checks; writes evals/results.jsonl
npm run evals:ragas   # RAGAS scores on those results (Gemini as the judge)
npm run evals:rerank  # does the re-ranker beat RRF? (needs the Cloudflare keys)
npm run evals:difficulty  # the L1/L2/L3 rules vs hand-labelled questions (no API calls)
npm run evals:load    # concurrency: old vs new router at 5–100 simultaneous chatters (fake providers, real limits)
```

## Deploy (Vercel, free)
Push to `main`; Vercel builds the site and the Python function (`requirements.txt`).
Set the variables from `.env.example` in Vercel (except `AGENT_URL`).
Google Sheets logging: follow the steps at the top of `integrations/google-sheets/Code.gs`.

## Monitoring
- **Sentry** (`NEXT_PUBLIC_SENTRY_DSN`): errors from the browser, the Next.js gateway and the Python agent in one project,
  plus warnings for failed lead emails / Sheets logging and an alert when every free model is used up. No chat text is
  sent (no request bodies, no personal data, no session replay).
- **Umami** (`NEXT_PUBLIC_UMAMI_WEBSITE_ID`): page views plus events — `chat_open`, `chat_question`, `chat_quick_answer`,
  `chat_paused`, `chat_ended`, `lead_submitted`, `resume_download`, `linkedin_click`, `github_click`, `email_click`,
  `paper_click`. Never the visitor's words.
- **Cloudflare Web Analytics** (`NEXT_PUBLIC_CF_BEACON_TOKEN`): cookieless traffic overview.

## CI
`.github/workflows/agent.yml` runs on every change to `content/`, `agent/` or `evals/` (and weekly): it rebuilds the
FAISS index — committing it if the content changed, which redeploys the site — then runs the evals and uploads the
results. RAGAS runs weekly and on manual runs only, because its judge shares the site's free Gemini quota. Needs the `GROQ_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` repository secrets.
