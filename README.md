# Rishabh Hota — portfolio + recruiter agent

[![Agent evals](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml/badge.svg)](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml) · **Live: [rishabh-hota.vercel.app](https://rishabh-hota.vercel.app)**

A Next.js portfolio with an AI agent, **Dumbledore**, that answers recruiters' questions about Rishabh and takes them
to the pages they want to see. The chat window is only its interface.
The AI pipeline is **Python** (LangGraph + LangChain): hybrid RAG with **FAISS + BM25**, a **five-gate refusal
pipeline**, page navigation, **one open-source embedding model served two ways**, a **4-level routing web of 17 free LLMs** across Groq, Gemini, Cloudflare Workers AI and
OpenRouter, and **RAGAS** evals. ₹0/month.

```
Browser ─► Next.js gateway  (app/api/chat/route.ts)          security: bot check, input validation,
             │                                               rate limits, daily budget
             ▼  shared secret
           Python agent  (api/index.py → agent/graph.py)     LangGraph:
             route ─► retrieve ─► scope ─► rerank ─► respond ─► check
                                                               route    Gate 1 rules: refusals, canned replies,
                                                                        "take me to …", answer cache (no LLM);
                                                                        else difficulty L1 / L2 / L3 (rules, 0 tokens)
                                                               retrieve FAISS (meaning) + BM25 (keywords) → RRF
                                                               scope    Gate 2: off-topic by meaning → refused;
                                                                        answer bank for common questions (no LLM)
                                                               rerank   top 2/4/6 by level (RRF order)
                                                               respond  Gate 3 prompt; the level's pool of free models
                                                               check    Gate 4 output guard, Gate 5 cache gate,
                                                                        "take me there" page links
           ◄── NDJSON events: text · replace · navigate · links
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
- **A refusal pipeline, measured.** Out-of-scope questions are denied before any LLM, and answers are checked before the
  visitor sees them (`agent/guard.py`, `agent/scope.py`):
  1. **rules**: harmful requests, jailbreaks, personal questions, off-topic tasks;
  2. **meaning**: the question's embedding (already computed for retrieval, so free) vs banks of on-topic and off-topic
     examples. Questions naming one of his pages always pass, questions about him need a much bigger margin, and a
     follow-up ("give me the link of the paper") is refused only if it's off-topic alone *and* with the previous question;
  3. **prompt**: one exact refusal sentence. If a model refuses a question that's about him, a *different* model gets a
     second opinion (small models over-refuse);
  4. **output**: the server holds each sentence until it's checked. Code and leaked instructions replace the answer;
     unknown links (including made-up pages), long numbers, IDs and other people's emails are removed;
  5. **cache**: only clean, on-topic, first-turn answers are cached.

  `evals/scope.json` has 76 attack/off-topic prompts and 47 real recruiter questions (follow-ups included), split into a
  *tuned* set and a *held-out* set written before any test run. Result: **0 leaks**; held-out attacks 32/33 refused
  (24 before any LLM; the other got a polite decline); **0 false refusals**. CI fails on any leak or false refusal.
- **An agent that acts.** "Take me to his projects", "open the LCSNet paper" → the page changes and the chat stays
  (it lives in the layout); on phones the full-screen chat steps aside. Answers get up to two "take me there" buttons.
  Targets are decided by rules over an allow-list of the site's pages (`agent/pages.py`), never by the model, and the
  browser only follows site-relative paths.
- **One embedding model, served two ways (`agent/embeddings.py`).** Vectors only compare within one model, so instead
  of several models (each needing its own index) the site serves **one** open-source model from two places, behind
  **one** index, scope bank and answer bank:
  1. **bge-small-en-v1.5** (BAAI, int8 ONNX from Hugging Face, 34 MB) on the function's own CPU — ~3 ms a question,
     no key, no quota, no daily limit;
  2. **the same model on Cloudflare Workers AI** (with the same [CLS] pooling) if the local copy can't run;
  3. keyword search (BM25) if both are down — the chat still answers.

  Chosen on this site's evals: same retrieval hit rate as EmbeddingGemma (14/14), scope separation AUC 0.93 vs 0.94
  (bge-base: no better, 3× the size and 7× the CPU), and ~100× faster than a network call. A failing route is paused, so
  visitors don't each wait for its timeout (measured in a real Cloudflare outage: 1.2 s for the first question, then
  7 ms). Groq serves no embedding models, and Hugging Face's hosted API has no free tier any more, which is why the
  open model runs locally.
- **Answering instantly.** Two L0 layers: an exact cache for repeated first questions, and an **answer bank**: common
  questions with ~8 paraphrases each, answered by the agent and kept only if the answer passes that question's eval
  checks. A new question is served from the bank only if its embedding is clearly nearest one intent (score ≥ 0.90 and
  0.05 ahead of the next): 56% of held-out paraphrases served, 0 wrong.
- **A routing web of free models, by difficulty.** Questions get a level from plain rules (0 tokens): **L0**
  greetings/contact/repeats (no LLM), **L1** one fact (small fast models, 2 chunks), **L2** the usual question
  (4 chunks), **L3** reasoning such as role fit (strongest models, 6 chunks, longer answers). Each level has a pool of
  free models across 4 providers; if a pool is busy the router spills to the neighbouring level. **Tiny models**
  (Qwen3-30B-A3B, 3B active; IBM Granite 4.0 Micro, 3B) sit before the bigger Cloudflare models for easy questions:
  Cloudflare's shared 10,000 neurons a day go 3–8× further. In the load simulator that adds answers under heavy load
  (100 chatters: 40% → 44% answered, median 5.7 s → 4.9 s) and changes nothing at normal load. Running a model inside
  the function instead isn't viable: one vCPU needs ~30–60 s for a 2,500-token prompt, and the 4 free CPU-hours a
  month would last a few hundred answers. Check any new model with `python -m evals.model_bench <name>` first.
- **Reserve, then call — safe under concurrency.** Before calling a model, one atomic Redis (Lua) script checks every
  limit that applies — requests/tokens per minute, per hour and per day, plus shared pools like Cloudflare's 10,000
  neurons/day — and books the call only if all have room. A load simulator (`npm run evals:load`) with the real free
  limits shows it: at 50 simultaneous chatters, 0 rate-limit errors (vs 194 for check-then-count) and a 3.9 s median.
  Then the booking is corrected to the provider's real token count (Groq's own remaining quota is read from its
  headers and its 429 messages; prompt tokens Groq served from its cache don't count, as on Groq). Pacing (≤3× a model's hourly share) only orders the models; 429s pause a model for the provider's
  retry-after; three outages in a minute trip a breaker for that provider. When every free model is out for the
  **day**, the chat pauses until the limits reset — never before.
- **Context shifting per model.** Each level's prompt is trimmed to fit the chosen model: older turns first, then
  fewer chunks — the profile always stays. The prompt starts with everything fixed (persona, rules, site map, profile)
  and ends with what changes (date, context), so Groq's automatic prompt cache covers the fixed part.
- **Security in the gateway, AI in Python.** Bot checks, rate limits and the daily budget sit in front of the agent;
  the Python service only accepts calls carrying a shared secret, and stays small and testable. A Vercel Firewall rule
  adds a per-IP limit at the edge. Every page sends a strict CSP, HSTS, `nosniff`, frame-deny and permissions headers
  (`next.config.ts`). The browser's chat history is untrusted: every turn and the total are capped, and tokens are
  estimated so non-English padding can't pass as small. Chat answers and chat summaries have separate daily budgets
  (`DAILY_LLM_BUDGET`, `DAILY_SUMMARY_BUDGET`); replies that used no model give the budget back.
- **Fails soft.** If Upstash errors (an outage or the free plan's monthly cap), limits fall back to each server's memory
  and the site keeps working; the dashboard shows "Reconnecting". Sheet writes that fail are queued and removed only
  after they were sent. Visitor text never becomes a Sheet formula.
- **No visitor can switch a model off for everyone.** Each network (hashed IP) may use at most 10% of any model's daily
  quota. A model is paused straight away only when the provider itself says the account is limited (429); errors one
  request could cause (too big, malformed, slow, 5xx) skip the model for that request, and pause it for everyone only
  when 2+ different networks see it fail in the same minute (3+ for the whole provider: a real outage).
- **Grounded answers, measured.** The prompt forbids guessing or embellishing; the evals check facts and guardrails on
  every content change, and RAGAS scores faithfulness.

## Code map
| Path | What it does |
|---|---|
| `agent/graph.py` | The LangGraph agent: the 6 nodes and how they connect |
| `agent/guard.py` | Refusal pipeline: Gate 1 rules, canned replies, Gate 4 output guard (also while streaming) |
| `agent/scope.py` | Gate 2: on-topic vs off-topic example banks, judged by embedding |
| `agent/pages.py` | The site map: navigation ("take me to …") and "take me there" links |
| `agent/embeddings.py` | One embedding model: local ONNX, then Cloudflare, then keyword search |
| `agent/rag.py` | FAISS + BM25 hybrid search, Reciprocal Rank Fusion, optional cross-encoder re-ranking |
| `agent/llm.py` | The model web: every free model, its limits, and the pool for each difficulty level |
| `agent/difficulty.py` | L1 / L2 / L3 from plain rules (tested by `evals/difficulty.json`) |
| `agent/router.py` | Pick → reserve → call → settle; spill-over, pauses, breaker, the wait for per-minute limits |
| `agent/usage.py` | Atomic budget reservations (Redis Lua), pacing, per-visit token totals |
| `agent/cache.py` | L0 answers: exact cache (a day) and the answer bank |
| `agent/prompts.py` | Dumbledore's system prompt (grounding + Gate 3) and the summary prompt |
| `agent/build_index.py` | Chunks the content; embeds it (locally, free) into the FAISS index + scope bank (skips unchanged) |
| `agent/build_answers.py` | Builds the answer bank: paraphrases, checked answers, embeddings |
| `api/index.py` | FastAPI: `/api/agent/chat` (NDJSON events), `/api/agent/summarize`, `/api/agent/health` |
| `evals/run_evals.py` | Retrieval / fact / guardrail checks over `evals/questions.json` |
| `evals/scope_eval.py` | Refusal pipeline: leaks and false refusals over `evals/scope.json` |
| `evals/navigation_eval.py` | "Take me to …" lands on the right page (`evals/navigation.json`, no API calls) |
| `evals/ragas_eval.py` | RAGAS: faithfulness, answer relevancy, context precision |
| `evals/rerank_ab.py` | A/B: RRF order vs the cross-encoder re-ranker (hit@4, MRR@4) |
| `evals/model_bench.py` | Is a free model good enough for a pool? Fact accuracy, latency, tokens |
| `evals/groq_smoke.py` | CI: one real question per Groq model (a broken key or path fails) |
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

## Adding a page
- **A project, paper, role or post:** add a Markdown file in `content/`. Dumbledore can take visitors to it at once
  (by its title or keywords), and CI generates a "take me to …" test for it.
- **A new section** (e.g. `/talks`): create the route in `app/` and add one entry to `sections` in
  `content/site.json` — label, the words people use for it, `"nav": true` to show it in the header, and `"kind"` if
  content pages live under it. That one entry feeds the header nav, the sitemap, the agent's navigation and the output
  guard's list of allowed links. CI (`npm run evals:nav`) fails if a route in `app/` is missing from `sections`, or
  if a page whose items share it (like `/publications`) renders no `id` anchors to land on.

## After editing content
Just push — CI rebuilds the FAISS index and redeploys. To rebuild it locally instead:
```bash
npm run agent:index   # rebuilds knowledge.json, the FAISS index, scope bank and answer bank in agent/data/
```

## Evals
```bash
npm run evals         # checks; writes evals/results.jsonl
npm run evals:ragas   # RAGAS scores on those results (Gemini as the judge)
npm run evals:rerank  # does the re-ranker beat RRF? (needs the Cloudflare keys)
npm run evals:difficulty  # the L1/L2/L3 rules vs hand-labelled questions (no API calls)
npm run evals:nav     # navigation: "take me to …" → the right page (no API calls)
npm run evals:scope   # refusal pipeline through the whole agent: 0 leaks, 0 false refusals
npm run evals:load    # concurrency: old vs new router at 5–100 simultaneous chatters (fake providers, real limits)
```

## Deploy (Vercel, free)
Push to `main`; Vercel builds the site and the Python function (`requirements.txt`).
Set the variables from `.env.example` in Vercel (except `AGENT_URL`).
Google Sheets logging: follow the steps at the top of `integrations/google-sheets/Code.gs`.

## Private dashboard (`/admin`)
Realtime analytics for the owner, fed **directly** by the site (`lib/server/events.ts` → Upstash Redis), in parallel
with the Google Sheet (which stays a copy to read on the go):
- **On the site now**: an open, visible tab in use pings every 30 s (`/api/visit/live`), and stops after 3 idle
  minutes; page views count on each page change. Paths that aren't pages count as "other".
- **Today and 7 days**: visits, page views, questions, leads and tokens with sparklines; top pages, sources, countries,
  networks (company or ISP) and devices.
- **Dumbledore**: how each question was handled (answered, refused, cache, answer bank, navigated), difficulty level,
  model, tokens and latency. The agent sends these on a final `meta` stream line that the gateway records and strips,
  so visitors never see model names. No chat text is stored, only the AI summary when a chat ends.
- **Leads** and the **model web** (today's budget per model and the embedding lineup, loaded only while open).

Every write is one Lua script (one Upstash command, rate limits included) and each poll (every 10 s, paused after 5
idle minutes) reads everything in one command, so it fits the free tier. A day's counters are capped at 600 fields, so
made-up pages or sources can't grow Redis. Sign-in: `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` → a signed, HttpOnly, SameSite=Strict `__Host-` cookie
(7 days, nothing stored server-side); BotID and rate limits on the login; noindex, disallowed in robots, and never in
the nav, sitemap or the agent's site map (`content/site.json` → `private`).

## Monitoring
- **Sentry** (`NEXT_PUBLIC_SENTRY_DSN`): errors from the browser, the Next.js gateway and the Python agent in one project,
  plus warnings for failed lead emails / Sheets logging and an alert when every free model is used up. No chat text is
  sent (no request bodies, no personal data, no session replay).
- **Umami** (`NEXT_PUBLIC_UMAMI_WEBSITE_ID`): page views plus events — `chat_open`, `chat_question`, `chat_quick_answer`,
  `chat_paused`, `chat_ended`, `agent_navigate`, `lead_submitted`, `resume_download`, `linkedin_click`, `github_click`, `email_click`,
  `paper_click`. Never the visitor's words.
- **Cloudflare Web Analytics** (`NEXT_PUBLIC_CF_BEACON_TOKEN`): cookieless traffic overview.

## Capacity (free tiers, measured 1 Nov 2026)
| | |
|---|---|
| People chatting at once | ~40 (~55 model answers a minute at full speed) |
| AI answers a day | ~1,950: Gemini ~1,000 · Groq ~500 · Workers AI ~400 · OpenRouter 50, plus free replies (greetings, cache, answer bank, refusals, page jumps) |
| Visits a month | ~20,000, set by Upstash (500K commands, ~24 a visit); then Vercel edge requests ~22,700, Active CPU ~60,000, function calls ~85,000, bandwidth ~220,000 |
| Readers at once | thousands: pages are static files on the CDN |

One visit = 3 pages, 2.5 minutes; 1 visitor in 5 asks 3 questions. Every limit is a hard free-tier cap, so busier
months slow the chat or the dashboard down; they never cost money.

## CI
`.github/workflows/agent.yml` runs on every change to `content/`, `agent/` or `evals/` (and weekly): it rebuilds the
search data (the index and scope bank, embedded locally) and the answer bank — committing them if they changed,
which redeploys the site — then runs the difficulty, navigation, refusal-pipeline and fact/guardrail evals and uploads
the results. RAGAS runs weekly and on manual runs only, because its judge shares the site's free Gemini quota. Groq
stays out of the full evals (they'd spend most of its 200,000 tokens per model per day, which visitors need); a
two-question smoke test is the only step with the Groq key. Secrets: `GOOGLE_GENERATIVE_AI_API_KEY`, `CF_ACCOUNT_ID`,
`CF_WORKERS_AI_TOKEN`, `GROQ_API_KEY`.
