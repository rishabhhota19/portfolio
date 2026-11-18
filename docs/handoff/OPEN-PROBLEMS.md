# Open problems (as of 18 Nov 2026)

Everything listed under "Done" in the old session is live and verified. These are NOT done.

## 1. Dumbledore RAG fixes — in progress, nothing applied yet (top priority)
He wants these fixed, then planned/checked with him. An attempt to add overview documents was interrupted and is NOT on
disk (`scripts/build-content.ts` is unchanged). (Full notes are in the private handoff zip, `memory/rag-audit-2026-11-18.md`.)

Measured with `agent.rag.search` at the depth the writer sees (L1 = 2 chunks, L2 = 4, L3 = 6):
- **Broad questions miss 4 of 10:** "any publications?" finds no paper in the top 8; "tell me his best research" first
  paper at rank 8; "what papers has he published" rank 5; "where has he worked" rank 3 (L1 sees 2).
- Causes: (a) no section-overview documents, every chunk is one item; (b) "research" collides with the
  research-to-prototype service, "News Research Tool" and "AI Researcher" job titles; (c) BM25 tokenizer has no
  stemming ("publications" ≠ "publication"); (d) L1 gets only 2 chunks.
- The evals show 14/14 retrieval only because every eval question names its target; no broad or cross-attribution cases.

Planned fixes:
1. **Overview documents** in `scripts/build-content.ts` (one per section: projects, research, experience, services; every
   item one line, in the site's best-first order; ids `overview:*`, urls `/projects`, `/publications`, `/experience`, `/services`).
2. **Search:** light stemming in `agent/rag.py` `tokenize`, section synonyms (research → papers/publications), minimum 4
   chunks for every level (`agent/llm.py` TIERS).
3. **Grounding check (model-based):** after the writer, a model compares the answer's numbers and named results with the
   chunks + PROFILE and rewrites unsupported claims (the stream supports a "replace" event). Goes in `graph.check`.
4. **Evals:** the 10 broad questions as retrieval cases; cross-attribution facts ("What accuracy did LCSNet get?" must
   never say 98%); consider making RAGAS faithfulness block CI on a small sample.
Re-measure before/after; prove on the live site; CI must pass so the index updates.

## 2. Hallucination seen live: facts mixed between projects
The small L1/L2 models said "LCSNet achieved 98% accuracy on osteoarthritis X-ray grading". False: LCSNet is dental
caries segmentation (F1 71.7%, IoU 56.8%); the 98% is the OA project. Cause: retrieval missed the papers and the
always-on PROFILE (`content/profile/core.md`) has both nearby. Fixed by problem 1 (overviews + grounding check).

## 3. 3D site frame stalls (his rule: no frame over 50 ms in the descent)
Median 16.7 ms, but 6–37 frames over 50 ms per walk (worst 300–1000 ms). They predate the recent work (the live site
before the changes stalled as much or more, measured side by side). The light budget check (World.ts) reports no
overflow. Not investigated yet. Note: this PC also has a known ~31 s stall in any page (private zip, `memory/live-testing-notes.md`):
run a blank WebGL control page first.

## 4. Next.js security upgrade
Next prints a known vulnerability for 16.4.3; upgrade to 16.4.6 (`next upgrade --agent=security ...` is what it suggests).
He has been told and has not said yes yet. Run the evals and a live check after.

## 5. Booking: small gaps
- A "Pending" hold on his calendar never expires if he doesn't approve or decline.
- Once the Sheet script answered "Service Spreadsheets failed while accessing document" (from a local test). Not
  seen again; worth checking the Sessions sheet still fills.

## 6. Loose files
- `extras/clef_ab.py`, `clef_ab.json`, `clef_ab_v1.json` were untracked in `portfolio/evals/` (not from the old session's
  work; origin unknown). Ask him before committing or deleting.
- `extras/3d-descent-plan.md` is the approved plan for the 3D chamber order (done and live).

## Done recently (for context, all live)
2D makeover (header, CTAs, 3D tour card); Book a call with approval loop (pending hold → email with signed
approve/decline → Meet invite); service and contact icons; 3D: new chamber order (best work → experience → projects →
research → writing → services → contact), sticky Book a call button, floating official contact logos one by one in the
last chamber, glass panes removed; Product Launch System replaced Collaterals Agent as the lead project; OA facts
corrected (98%, SRM Trichy, Fortis) with a licensed X-ray in the 3D project window; ready-made chat questions now open
their page and a clear "View <page>" button shows on narrow screens.
