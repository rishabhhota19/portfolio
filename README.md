# Rishabh Hota — portfolio + recruiter agent

[![Agent evals](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml/badge.svg)](https://github.com/rishabhhota19/portfolio/actions/workflows/agent.yml) · **Live: [rishabh-hota.vercel.app](https://rishabh-hota.vercel.app)**

A Next.js portfolio with an AI agent, **Dumbledore**, that answers recruiters' questions about Rishabh and takes them
to the pages they want to see. The chat window is only its interface.
The AI pipeline is **Python** (LangGraph + LangChain): **one agent session per chat** with a research loop and a
working memory, hybrid RAG with **FAISS + BM25**, a **five-gate refusal pipeline**, page navigation, **one open-source
embedding model served two ways**, a **4-level routing web of 23 free LLMs** (+2 optional SambaNova) across Groq,
NVIDIA's API catalog, Gemini, Cloudflare Workers AI and OpenRouter, and **RAGAS** evals. ₹0/month.

```
Browser ─► Next.js gateway  (app/api/chat/route.ts)          security: bot check, input validation,
             │                                               rate limits, daily budget
             ▼  shared secret
           Python agent  (api/index.py → agent/graph.py)     LangGraph, one session per chat:
             route ─► retrieve ─► scope ─► rerank ─► recall ─► plan ⇄ act ─► respond ─► check ─► remember
                                                               route    Gate 1 rules: refusals, canned replies,
                                                                        "take me to …", answer cache (no LLM);
                                                                        else difficulty L1 / L2 / L3 (rules, 0 tokens)
                                                               retrieve FAISS (meaning) + BM25 (keywords) → RRF
                                                               scope    Gate 2: off-topic by meaning → refused;
                                                                        answer bank for common questions (no LLM)
                                                               rerank   top 2/4/6 by level (RRF order)
                                                               recall   this chat's memory; economy mode if quota is thin
                                                               plan/act the research loop: what the question needs,
                                                                        each point searched once
                                                               respond  Gate 3 prompt; the level's pool of free models
                                                               check    Gate 4 output guard, Gate 5 cache gate,
                                                                        "take me there" page links
                                                               remember this turn's points and one summary line
           ◄── NDJSON events: text · replace · navigate · links
```

**Visit analytics.** Every visit (one browser tab) gets one row in the Google Sheet's *Sessions* tab: pages, active time,
source/UTM, clicks, city-level location, network (company or ISP), device — and, if they chat, the **real token counts**
the providers report (in/out, models, latency, summary tokens) plus an AI summary (never the transcript). The transcript
lives only in the tab; the agent keeps a short-lived working memory (below). When a recruiter shares their details, the same row gets them and you get an email (Resend if
`RESEND_API_KEY` is set, otherwise the Sheet's Apps Script sends it). IPs are blanked after 90 days; see `/privacy`.

## Why it's built this way
- **One agent session per chat.** The conversation id is the LangGraph thread: its memory is loaded at the start of a
  turn and saved at the end, whichever model or instance answers. `plan ⇄ act` (`agent/research.py`) is the agent's own
  search: a one-point question is one search with no model, a job description is searched requirement by requirement,
  and a planner model runs only for open reasoning questions (why hire him, the biggest risk). The memory
  (`agent/memory.py`, Redis, two hours, deleted at End chat) keeps each point's evidence and note, plus one line per
  earlier turn with the first 140 characters of that question; never the answers. A long chat sends that summary and the
  last 4 messages, and nothing is researched twice. **Economy mode** (the day's quota thin, or a chat that has spent a
  lot) skips the planner and shortens the answer. If Redis is unreachable, the agent answers from the transcript alone.
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

  `evals/scope.json` has 78 attack/off-topic prompts and 66 real recruiter questions (follow-ups included), split into a
  *tuned* set (76) and a *held-out* set (68). Last CI run (5 Nov): **0 leaks, 0 false refusals**. CI fails on any leak or
  false refusal, or if more than two off-topic questions get a harmless answer instead of a refusal.
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
  free models across 5 providers (SambaNova is a sixth, on when its key is set); if a pool is busy the router spills to
  the neighbouring level. `agent/llm.py` registers 28 models and 25 are in a pool (23 without SambaNova); Granite 4.0
  Micro and NVIDIA's Nemotron Nano and Bolt stay registered but out of every pool after failing guardrail cases. NVIDIA's
  catalog sits near the front of the pools: free, ~40 requests a minute per account, no published daily cap. A **tiny
  model** (Qwen3-30B-A3B, 3B active) sits before the bigger Cloudflare models for easy questions: Cloudflare's shared
  10,000 neurons a day go 3–8× further. In the load simulator (1 Nov, with Granite then in the pool) tiny models added
  answers under heavy load (100 chatters: 40% → 44% answered, median 5.7 s → 4.9 s) and changed nothing at normal load. Running a model inside
  the function instead isn't viable: one vCPU needs ~30–60 s for a 2,500-token prompt, and the 4 free CPU-hours a
  month would last a few hundred answers. Check any new model with `python -m evals.model_bench <name>` first.
- **Reserve, then call — safe under concurrency.** Before calling a model, one atomic Redis (Lua) script checks every
  limit that applies — requests/tokens per minute, per hour and per day, plus shared pools like Cloudflare's 10,000
  neurons/day — and books the call only if all have room. A load simulator (`npm run evals:load`) with the real free
  limits shows it: at 50 simultaneous chatters, 0 rate-limit errors (vs 194 for check-then-count) and a 3.9 s median.
  Then the booking is corrected to the provider's real token count (Groq's own remaining quota is read from its
  headers and its 429 messages; prompt tokens Groq served from its cache don't count, as on Groq). Pacing (≤3× a model's hourly share) only orders the models; 429s pause a model for the provider's
  retry-after; three outages in a minute trip a breaker for that provider. When every free model is out, the
  agent still answers in character from the evidence in hand and Sentry gets an alert: it degrades, it never stops.
- **Context shifting per model.** Each level's prompt is trimmed to fit the chosen model: older turns first, then
  fewer chunks — the profile always stays. The prompt starts with everything fixed (persona, rules, site map, profile)
  and ends with what changes (date, context), so Groq's automatic prompt cache covers the fixed part.
- **Awake before the first question.** A cold agent made the next visitor's first question wait about 3 s for Python to
  start and load its index. Every instance now loads everything as it starts (`preload` in `api/index.py`). The browser
  calls `GET /api/agent/warm` once the page is idle, at most every 3 minutes, and the CDN answers repeats for 3 minutes,
  so a warm agent isn't warmed again. A Cloudflare cron (`cloudflare/warm/`) wakes it every 4 minutes, proving itself with
  `WARM_KEY`. A visitor's warm-up never calls a model; only the cron does, to keep Groq's prompt cache warm while people
  chat, at most once every 100 minutes. Vercel can still send a chat to a fresh instance, so cold starts are rarer, not gone.
- **One dashboard for every model call.** Groq, Gemini, Cloudflare and OpenRouter calls go through Cloudflare AI Gateway
  (`agent/llm.py`): same models, same requests, only the address changes. SambaNova and NVIDIA go direct, because the
  gateway has no route for them. Logging and caching are off there, so no prompt or answer is stored. If the gateway
  itself fails, that call retries direct and the instance skips the gateway for 60 s; `AI_GATEWAY=off` sends everything direct.
- **Heavy media on Cloudflare.** `lib/media.ts` loads files in `public/media/` from a static Worker (`cloudflare/media/`,
  free, unlimited bandwidth), so they don't count against Vercel's 100 GB a month. Vercel serves the same folder, and an
  element switches to that copy if Cloudflare can't deliver. It holds only a test file so far.
- **The dashboard's data on a Durable Object.** Browser heartbeats go straight to a Cloudflare Worker
  (`cloudflare/analytics/`) instead of a Vercel function, and its SQLite-backed Durable Object keeps the counters, feed
  and leads, by the same rules as the Upstash scripts. Details under *Private dashboard*.
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
| `agent/graph.py` | The LangGraph agent: the 10 nodes and how they connect |
| `agent/research.py` | The research loop: what a question needs, and a site search for each point (LangChain tools) |
| `agent/memory.py` | One chat's working memory in Redis: points researched, a line per turn, tokens spent |
| `agent/guard.py` | Refusal pipeline: Gate 1 rules, canned replies, Gate 4 output guard (also while streaming) |
| `agent/scope.py` | Gate 2: on-topic vs off-topic example banks, judged by embedding |
| `agent/pages.py` | The site map: navigation ("take me to …") and "take me there" links |
| `agent/embeddings.py` | One embedding model: local ONNX, then Cloudflare, then keyword search |
| `agent/rag.py` | FAISS + BM25 hybrid search, Reciprocal Rank Fusion, optional cross-encoder re-ranking |
| `agent/llm.py` | The model web: every free model, its limits, the pool for each difficulty level, AI Gateway routing |
| `agent/difficulty.py` | L1 / L2 / L3 from plain rules (tested by `evals/difficulty.json`) |
| `agent/router.py` | Pick → reserve → call → settle; spill-over, pauses, breaker, the wait for per-minute limits |
| `agent/usage.py` | Atomic budget reservations (Redis Lua), pacing, per-visit token totals |
| `agent/cache.py` | L0 answers: exact cache (a day) and the answer bank |
| `agent/prompts.py` | Dumbledore's system prompt (grounding + Gate 3) and the summary prompt |
| `agent/build_index.py` | Chunks the content; embeds it (locally, free) into the FAISS index + scope bank (skips unchanged) |
| `agent/build_answers.py` | Builds the answer bank: paraphrases, checked answers, embeddings |
| `api/index.py` | FastAPI: `/api/agent/chat` (NDJSON events), `/api/agent/warm`, `/api/agent/summarize`, `/api/agent/session/{id}`, `/api/agent/health` |
| `evals/run_evals.py` | Retrieval / fact / guardrail checks over `evals/questions.json` |
| `evals/scope_eval.py` | Refusal pipeline: leaks and false refusals over `evals/scope.json` |
| `evals/navigation_eval.py` | "Take me to …" lands on the right page (`evals/navigation.json`, no API calls) |
| `evals/ragas_eval.py` | RAGAS: faithfulness, answer relevancy, context precision |
| `evals/rerank_ab.py` | A/B: RRF order vs the cross-encoder re-ranker (hit@4, MRR@4) |
| `evals/model_bench.py` | Is a free model good enough for a pool? Fact accuracy, latency, tokens |
| `evals/groq_smoke.py` | CI: one real question per Groq model (a broken key or path fails) |
| `evals/advocacy_eval.py` | Recruiter cases (`evals/advocacy.json`): proof, links, a next step, no invented gaps |
| `evals/baseline.py` | The ratchet: a case that passed before must keep passing (`evals/baseline.json`) |
| `app/api/*` | Next.js gateway: security checks, then calls the Python agent; logging + lead email |
| `lib/visit.ts`, `app/api/visit` | The visit: tab session id, pages, clicks, active time → one Sessions row (sendBeacon) |
| `lib/server/visitor.ts`, `session.ts` | Location, device, network (IPinfo), returning visitor; combining a visit's chats |
| `lib/traffic.ts` | Bot list, device and source rules, shared by the site and the analytics Worker |
| `lib/media.ts` | Where heavy media loads from: Cloudflare, then the Vercel copy |
| `cloudflare/media/` | Static Worker: serves `public/media/` |
| `cloudflare/analytics/` | Worker + Durable Object (SQLite): browser heartbeats and the dashboard's data |
| `cloudflare/warm/` | Cron Worker: wakes the agent every 4 minutes |
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
python -m evals.advocacy_eval  # the 12 recruiter cases through the whole agent (real LLM calls)
```
The **recruiter cases** check that Dumbledore represents him the way a good agent would and stays honest doing it: job
descriptions, why hire him, weaknesses, too junior, a bio, a comparison. Each needs proof, links and a next step, with no
invented gaps. The **ratchet** (`evals/baseline.py`) sits under the evals: a case that passed on the last fully green run
must keep passing, however good the percentages look. A case that has never passed is reported but doesn't fail the
run. Green full runs add to `evals/baseline.json` and never remove from it.

## Deploy (Vercel + Cloudflare, free)
Push to `main`; Vercel builds the site and the Python function (`requirements.txt`).
Set the variables from `.env.example` in Vercel (except `AGENT_URL`).
Google Sheets logging: follow the steps at the top of `integrations/google-sheets/Code.gs`.

Three Cloudflare Workers deploy separately and by hand, because the GitHub secret `CLOUDFLARE_API_TOKEN` isn't set
(`media.yml` and `analytics.yml` only leave a note until it is; the cron has no workflow):
```bash
npm run media:deploy      # rishabh-media: the files in public/media/
npm run analytics:deploy  # rishabh-analytics: the dashboard's Worker + Durable Object
npm run warm:deploy       # rishabh-warm: the 4-minute wake-up cron
```
Their secrets are set once with `wrangler secret put`: `EVENTS_SECRET` and `IP_HASH_SALT` on analytics, `WARM_KEY` on warm.

## Private dashboard (`/admin`)
Realtime analytics for the owner, fed **directly** by the site (`lib/server/events.ts` → a Cloudflare Durable Object,
`cloudflare/analytics/`), in parallel with the Google Sheet (which stays a copy to read on the go). Unset
`NEXT_PUBLIC_ANALYTICS_URL` or `ANALYTICS_SECRET` and the same code switches back to Upstash Redis.
- **On the site now**: an open, visible tab in use pings every 30 s straight to the Worker (`/live`); if it can't be
  reached, `/api/visit/live` passes the ping on. Pings stop after 3 idle minutes; page views count on each page change.
  Paths that aren't pages count as "other".
- **Today and 7 days**: visits, page views, questions, leads and tokens with sparklines; top pages, sources, countries,
  networks (company or ISP) and devices.
- **Dumbledore**: how each question was handled (answered, refused, cache, answer bank, navigated), difficulty level,
  model, tokens and latency. The agent sends these on a final `meta` stream line that the gateway records and strips,
  so visitors never see model names. No chat text is stored, only the AI summary when a chat ends.
- **Leads** and the **model web** (today's budget per model and the embedding lineup, loaded only while open).

The Durable Object keeps everything in SQLite, because it leaves memory after a few idle seconds: one row per event, one
per heartbeat and one per page view, far under the free 100,000 rows a day, at 0–2 ms of CPU a request (measured 3 Nov;
the free limit is 10 ms). Each poll (every 10 s, paused after 5 idle minutes) reads everything in one call. On Upstash,
every write is one Lua script and each poll one command. A day's counters are capped at 600 fields either way, so
made-up pages or sources can't grow the store. Sign-in: `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` → a signed, HttpOnly, SameSite=Strict `__Host-` cookie
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

## Capacity (free tiers)
Dated numbers: none of them has been re-measured since the session agent, NVIDIA's models and the cron landed (4–5 Nov 2026).

| | |
|---|---|
| People chatting at once | ~40 (~55 model answers a minute at full speed), measured 1 Nov |
| AI answers a day | ~1,950 on 1 Nov: Gemini ~1,000 · Groq ~500 · Workers AI ~400 · OpenRouter 50, plus free replies (greetings, cache, answer bank, refusals, page jumps). Since then NVIDIA's catalog adds models with no published daily cap, and Gemini four more models |
| Tokens a turn | a usual question ~1,200 counted on Groq when its prompt cache hits (~3,000 before), a hard one ~4.5–5.3k, measured 5 Nov |
| Visits a month | ~28,000, worked out 3 Nov once the dashboard and its heartbeats moved to Cloudflare, set by Vercel's 1M CDN requests (~20,000 before the move, when Upstash ran out first). Other Vercel limits on 1 Nov: Active CPU ~60,000, function calls ~85,000, bandwidth ~220,000 |
| Readers at once | thousands: pages are static files on the CDN |

One visit = 3 pages, 2.5 minutes; 1 visitor in 5 asks 3 questions. Every limit is a hard free-tier cap, so busier
months slow the chat or the dashboard down; they never cost money.

## CI
`.github/workflows/agent.yml` runs on every change on the chat's path (`content/`, `agent/`, `evals/`, `api/`,
`lib/server/`, `app/api/`, `scripts/build-content.ts`, `requirements*.txt`, the workflow itself) and weekly. It rebuilds the
search data (the index and scope bank, embedded locally) and the answer bank, then runs the difficulty, navigation, Groq
smoke, refusal-pipeline, fact/guardrail and recruiter evals, with the ratchet. Only if all of them pass does it commit
the rebuilt data and the grown baseline, which redeploys the site. Runs queue rather than cancel. Vercel doesn't wait for
CI: a push deploys at once, and a failing run only keeps the rebuilt data off the site.

The evals run on NVIDIA's API catalog (free, a per-minute limit, no daily cap), never on the site's Gemini or Cloudflare
quotas. Groq stays out of them (they'd spend most of its 200,000 tokens per model per day, which visitors need); a
two-question smoke test is the only step with the Groq key. RAGAS runs weekly and on manual runs only, and only with a
CI-only Gemini key, because its judge is a Gemini model. Secrets: `NVIDIA_API_KEY`, `GROQ_API_KEY`; optional
`GOOGLE_GENERATIVE_AI_API_KEY_CI`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
