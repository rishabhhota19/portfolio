# Rishabh Hota — portfolio + recruiter agent

A static Next.js portfolio with an AI agent that answers recruiters' questions about Rishabh. The agent is a **LangGraph** graph doing **RAG** over the site's own content. It streams answers from a chain of **free** LLMs and costs ₹0/month at 10k+ visitors.

```
Browser ── static pages (Vercel CDN)
   │
   ├─ POST /api/chat ──► BotID → rate limit + daily budget (Upstash Redis)
   │                     → LangGraph: retrieve (Upstash Vector RAG) → respond (provider chain)
   │                     → Cloudflare AI Gateway → Groq → Gemini → Groq small → Workers AI (→ Vercel AI Gateway credit)
   ├─ POST /api/chat/end ► chat closed / site left → LLM summary → Google Sheet (transcript never stored)
   └─ POST /api/lead ────► "Share your details" → summary + details → Google Sheet + email (Resend)
```

**Memory is temporary.** The conversation lives only in React state in the open tab. Ending the chat (✕) or leaving the site wipes it. Only a short summary row reaches the Google Sheet. Minimizing (—) keeps the chat while the visitor browses other pages.

## Edit your content
Everything lives in `content/`. The same files render the pages *and* feed the agent.

| File | What it is |
|---|---|
| `content/profile/core.md` | Always-on agent context. **Fill in the FAQ** (notice period, relocation, etc.) |
| `content/projects/*.md`, `publications/*.md`, `experience/*.md`, `blog/*.md` | Pages + RAG documents |
| `content/starters.json` | Hand-written answers for the quick-question chips (free, instant) |
| `content/site.json` | Name, links, site URL |

After editing, run `npm run ingest` to re-index the RAG store (it rebuilds the content first).

## Run locally
```bash
npm install
npm run dev          # http://localhost:3000 — works with no keys (mock agent, console logging)
```
Copy `.env.example` to `.env.local` and add keys to use real models.

```bash
npm run evals        # retrieval, fact and guardrail checks against the real agent
npm run ingest       # (re)index content into Upstash Vector
```
Testing fallbacks: `FORCE_FAIL=groq,google-ai-studio npm run dev` skips those providers.

## One-time setup (all free)
1. **Groq:** console.groq.com → API key → `GROQ_API_KEY`.
2. **Google AI Studio:** aistudio.google.com → API key → `GOOGLE_GENERATIVE_AI_API_KEY`.
3. **Cloudflare:**
   - AI → AI Gateway → create `portfolio-agent` (turn on caching) → `CF_ACCOUNT_ID`, `CF_GATEWAY_ID`.
   - My Profile → API Tokens → "Workers AI" token → `CF_WORKERS_AI_TOKEN`.
   - Web Analytics → add the site → `NEXT_PUBLIC_CF_BEACON_TOKEN`.
4. **Upstash** (via Vercel → Storage → Marketplace, or upstash.com):
   - **Redis** database: the `KV_REST_API_*` variables are added automatically.
   - **Vector** index with embedding model **BAAI/bge-small-en-v1.5** → `UPSTASH_VECTOR_REST_URL/TOKEN`. Then run `npm run ingest`.
5. **Google Sheet logging:** follow the header of `integrations/google-sheets/Code.gs`, then set `GOOGLE_SHEETS_WEBHOOK_URL` and `GOOGLE_SHEETS_SECRET`. Set the sheet's timezone (File → Settings) to IST.
6. **Resend:** sign up with the inbox that should receive leads → `RESEND_API_KEY`, `LEAD_ALERT_EMAIL`.
7. **Secrets:** generate `CHAT_TOKEN_SECRET` and `IP_HASH_SALT` (command in `.env.example`).
8. **Vercel:**
   - Import the GitHub repo (Hobby plan) and add every variable above.
   - Firewall → add a rate-limit rule on `/api/*` (60 req/min per IP).
   - Turn on Bot Protection.

## Where things are
- `lib/agent/graph.ts`: the LangGraph agent (retrieve → respond, provider fallback)
- `lib/agent/retriever.ts`: Upstash Vector RAG retriever with a lexical fallback
- `lib/agent/providers.ts`: free-provider chain and Cloudflare AI Gateway routing
- `lib/agent/summarize.ts`: end-of-chat summary for the sheet
- `lib/server/*`: rate limits and budget, bot check, Sheets logger, lead email, request validation
- `components/chat/*`: chat widget (lazy-loaded), lead form, safe markdown renderer
- `integrations/google-sheets/Code.gs`: Apps Script that upserts one row per conversation
- `evals/`: agent eval suite
