# Rishabh Hota — portfolio + 3D site + Dumbledore agent: handoff for a new Claude

Written 18 Nov 2026. Read this whole file, then `docs/handoff/OPEN-PROBLEMS.md` and `docs/handoff/RAG-PIPELINE.md`.
**This repo is public: keys are NOT here.** They are in his private handoff zip (Google Drive, `secrets/`) and in
Vercel. Never commit a key, never paste a value into chat, a URL or a log.

## Who you work for
Rishabh Hota, Sr. AI Researcher (Bengaluru). The portfolio markets and sells him to recruiters and clients.
- Talk plainly and briefly. He is direct; when he is angry, fix the thing, don't apologise at length.
- He is an AI engineer: agent behaviour = prompt, reasoning steps and evals. The model decides; no hand-coded rules for
  judgement calls. Guardrails are model-based.
- Prove every change on the live site, with numbers. Local dev is not proof.
- For signed-in sites (Google Cloud, Gmail, Vercel dashboard, Apps Script) use the Claude in Chrome extension (his real
  Chrome, already signed in), not a headless or built-in browser.
- When asked to list or audit: report and stop; confirm scope before writing code. Plan big changes with him.
- ₹0 rule: free tiers only.
- 3D site: inside the descent 60 fps, no frame over 50 ms, measured on the live site.

## The pieces
| What | Where | Live |
|---|---|---|
| 2D site + Dumbledore agent (Next.js 16 + Python LangGraph) | github.com/rishabhhota19/portfolio (branch `main`) | https://rishabh-hota.vercel.app |
| 3D site "Into the Agent" (Vite + TypeScript + three.js) | github.com/rishabhhota19/into-the-agent (`main`; old clone sits on `fix/tier-measurement`, same commit) | https://rishabh-hota.vercel.app/3d (proxied from https://into-the-agent.vercel.app) |
| Admin dashboard | portfolio `/admin` | password `ADMIN_PASSWORD` in secrets |
| Booking approvals | portfolio `/book/decide` (signed links from the request email) | — |

The 3D site reads its content from the portfolio repo (`tools/content.mjs` reads `../portfolio/content`): **clone both
repos side by side** in one folder.

### Hosting and accounts
- **Vercel team `rishabh-099b`** (Hobby), projects `rishabh-hota` and `into-the-agent`, both Git-linked: a push to
  `main` deploys. Functions run in **bom1 (Mumbai)**. Log the Vercel CLI in as rishabhhota19@gmail.com. The Claude app's
  Vercel connector is his WORK account: never authorize it for the portfolio.
- **GitHub:** rishabhhota19 is the personal, recruiter-facing account. If `gh` has several accounts, push as rishabhhota19:
  `TOK=$(gh auth token --user rishabhhota19); git -c credential.helper= -c "credential.helper=!f(){ echo username=rishabhhota19; echo password=$TOK; }; f" push origin main`
- **Redis:** Upstash `portfolio-redis-mumbai` (ap-south-1) = `UPSTASH_REDIS_REST_*` in production. Old Vercel KV (`KV_*`) stays for CI.
- **Models (all free tiers):** Groq, NVIDIA NIM, Google Gemini, Cloudflare Workers AI + AI Gateway, OpenRouter. Keys in secrets.
- **Cloudflare Workers** (in `portfolio/cloudflare/`): `rishabh-media` (media), `rishabh-analytics` (stats, Durable Object),
  `rishabh-warm` (cron that keeps the agent warm, uses `WARM_KEY`). Deploy with `npm run media:deploy` / `analytics:deploy` / `warm:deploy` (wrangler login needed).
- **Google:** Apps Script project **"Portfolio logger"** (script.google.com, his account) is the web app behind
  `GOOGLE_SHEETS_WEBHOOK_URL`: it writes the Sessions sheet and sends email (lead alerts, booking requests, decline notes)
  from his Gmail. Source: `portfolio/integrations/google-sheets/Code.gs`; after editing, Deploy → Manage deployments →
  Edit → New version (same URL). Currently version 4.
- **Booking (Book a call):** Google Calendar API via OAuth client **"portfolio-booking"** (Desktop) in Google Cloud
  project **TeddyAI** (`gen-lang-client-0931775629`, consent screen External + In production). Refresh token made by
  `npm run calendar:connect`. Keys: `GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN`.
- **Monitoring:** Sentry (`NEXT_PUBLIC_SENTRY_DSN`, org/project in secrets), Umami (`NEXT_PUBLIC_UMAMI_WEBSITE_ID`), Cloudflare beacon.

### Keys (in the private handoff zip's secrets/, not in this repo)
- `portfolio.env.local` — the old machine's `portfolio/.env.local`: everything needed to run locally (copy to `portfolio/.env.local`).
- `into-the-agent.env.local` — `into-the-agent/.env.local` (only a Vercel OIDC token).
- `vercel-production.rishabh-hota.env`, `vercel-production.into-the-agent.env` — pulled with `vercel env pull --environment=production`
  on 18 Nov 2026: the live values. The empty ones are Vercel's own build variables (filled at deploy).
- Not in the pack: GitHub Actions secrets (set in each repo's Settings → Secrets) and Cloudflare Worker secrets (wrangler).

## Set up on the new machine
1. Clone both repos side by side; `npm ci` in each. Python 3.13: `python -m venv .venv` in portfolio, then
   `pip install -r requirements.txt -r requirements-dev.txt`.
2. From the private zip, copy `secrets/portfolio.env.local` to `portfolio/.env.local` (or `vercel env pull`).
3. `vercel login` (rishabhhota19), `vercel link` in each repo (team rishabh-099b).
4. `npm run dev` (portfolio) and `npm run agent` (Python agent on :8000); `npm run dev` in into-the-agent (port 5177).
5. On Windows from Claude's sandboxed shell, `next build` may fail with 0xc0000142: run it from a real terminal.

## How things are verified
- Portfolio: CI workflow "Agent index + evals" (GitHub Actions, ~25–50 min) rebuilds the search index and runs the evals
  (retrieval, facts, guardrails, "selling by showing", recruiter cases). If it fails, the index is NOT updated.
- Live checks: Playwright with real Chrome (`channel="chrome"`, `--disable-features=AsyncDns`). The live chat blocks
  headless browsers (BotID): test the chat in his real Chrome. 3D tests: add `?tier=high` to skip the speed gate.

## Dumbledore's pipeline
The exact path of a question (browser starters → route → retrieve → scope/answer bank → rerank → recall → plan →
write → check → remember) is in `docs/handoff/RAG-PIPELINE.md`. Read it before touching `agent/`.

## Content rules he set
- The Product Launch System project never names his employer in its write-up.
- OA project facts: KL grading 98% accuracy and AUC; segmentation double-check; report in under 2 min; randomised
  controlled trial at **SRM Trichy** (Dr. Mahesh Magadum); deployed at Fortis Nagarbhavi; TensorFlow, EC2 H100, Lambda, API Gateway.
- Images on the site must be licensed and credited (e.g. the OA X-ray, CC BY-SA 3.0, credit shown under it).
