# Open problems (as of 19 Nov 2026)

Everything listed under "Done" in the old session is live and verified. These are NOT done.

## 1. Dumbledore RAG fixes — code written 19 Nov 2026, not yet proven live (top priority)
His rules for this work: concepts over brute force, no patches, BM25 only as the fallback, one reranker on every
retrieval, keep it simple. (The audit's notes are in the private handoff zip, `memory/rag-audit-2026-11-18.md`.)

Measured 18 Nov at the depth the writer sees (L1 = 2 chunks, L2 = 4, L3 = 6): broad questions found the right section
1/10 ("any publications?" no paper in the top 8; "tell me his best research" first paper at rank 8). The evals showed
14/14 because every eval question named its target and the check looked at the 6 kept, not at what the writer read.

Done on disk (measured 19 Nov on the M1, 10 broad + 14 named questions; the live x86 numbers will differ a little —
five margins are under 0.006 cosine):
1. **Section pages** (`scripts/build-content.ts`): one `page:<section>` doc per site.json section, every item one line,
   kept as one chunk (`whole`, honoured by `agent/build_index.py`). Broad 1/10 → 8/10 with the old fusion.
2. **BM25 is the fallback** (`agent/rag.py`): the first stage is the vectors' order; BM25 only when nothing could embed
   the question. Fused in, BM25 voted for keyword collisions: broad 8/10 → 10/10, named MRR 0.964 → 1.000.
3. **Second vote** (`agent/reranker.py`): cross-encoder/ms-marco-TinyBERT-L-2-v2, int8, 4 MB, ~25 ms a question, fused
   1:2 with the first stage, on every retrieval (graph.rerank and research.search_site). Eight cross-encoders were
   measured; as the decider every one was worse than the vectors alone; as a 1:2 voter none cost a rank 1.
4. **Evals**: `run_evals.py` checks retrieval on the chunks the writer read; the 10 broad questions and two LCSNet
   cross-attribution cases are in `questions.json`; `rerank_ab.py` measures the vote against the first stage, no keys.
Rejected, measured: stemming + synonyms (+0 with the pages; "news" → "new"), 4 chunks for L1 (budget for a wrong
level), the BGE query instruction (broke an eval), Cloudflare's bge-reranker-base (MRR 0.81), FAISS (same numbers, 66 MB).

Still to do:
- CI must go green on the push, so the index (61 chunks) is rebuilt on x86 and committed; then prove on the live site
  with his Chrome (the chat blocks headless browsers).
- **Level by the model**, planned with him: `difficulty.py`'s regex calls "where has he worked" and "has he done any
  research?" one-fact questions (L1, 2 chunks). The judge already reads every turn; its verdict could carry the level.
  Needs its own eval (evals/difficulty.json).
- **Grounding check: measure it in CI, then enforce.** `evals/grounding_eval.py` runs on the real checker models with a
  warning, not a failure, until its first CI numbers are read (caught x/5 planted mistakes, false alarms y/3). Then
  make it fail CI, and consider RAGAS faithfulness on a small sample.

## 2. Hallucination seen live: facts mixed between projects
The small L1/L2 models said "LCSNet achieved 98% accuracy on osteoarthritis X-ray grading". False: LCSNet is dental
caries segmentation (F1 71.7%, IoU 56.8%); the 98% is the OA project. Cause: retrieval missed the papers and the
always-on PROFILE (`content/profile/core.md`) has both nearby. Addressed twice over (19 Nov 2026): retrieval now puts
the LCSNet chunk first for LCSNet questions (measured), and the grounding check (`agent/grounding.py`, in `graph.check`)
reads every written answer against its sources and corrects a result given to the wrong project — he chose stream, then
replace. Two eval cases watch it end to end (`lcsnet-not-oa`, `lcsnet-oa-trap`); `evals/grounding_eval.py` watches the
check alone. Not yet seen on the live site.

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
