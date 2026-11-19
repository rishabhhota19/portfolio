# Dumbledore: the path of a question

He asked me to keep this map and never mix it up (18 Nov 2026). Code: Desktop\portfolio\agent\ (graph.py wires it).
Verify against graph.py before relying on a detail; update this note when the pipeline changes.

**0. Browser, before the server:** chat starter buttons (content/starters.json) show a pre-written answer in the
browser (components/chat/ChatPanel.tsx pickStarter) and open the starter's `show` page. No agent call.

**1. route** (graph.route, rules, no model): guard.classify → refusal / canned (greeting, thanks, contact = also opens
the booking card) / pages.move ("go back", "scroll") / pages.navigation ("take me to …") / cache.get (first turn,
asked before). Else sets difficulty level L1 (one fact) / L2 (usual) / L3 (reasoning, JD, long chat) (difficulty.py).

**2. retrieve** (always): embeddings.embed with BAAI/bge-small-en-v1.5 int8 ONNX on the function's CPU (Cloudflare
Workers AI same model as backup), one text at a time (embeddings.VERSION 2, 19 Nov 2026: batched, the int8 model's
quantisation scales depended on the batch, so a content edit moved every chunk's vector by up to 0.0065 cosine and
flipped thin margins; the stamps and the answer bank carry embeddings.TAG so a change of method rebuilds every vector). rag.search = the 8 chunks closest by cosine (NumPy over index.npy) + a relevance score;
BM25 (keywords) is the fallback, used only when no route could embed the question (until 19 Nov 2026 it was fused into
every ranking by RRF and pulled keyword collisions up — the numbers are in rag.py). Follow-ups search with the previous
question too.
Index: knowledge.json (38 docs = 33 items + 5 section pages: one `page:<section>` doc per site.json section, every item
one line, kept as one chunk) → 61 chunks, 900 chars / 150 overlap, title prefixed, keywords (build_index.py), CI rebuilds.

**3. scope** (graph.scope, gate 2): off-topic by relevance + scope bank → decline unless the judge model rescues;
first turn and a close answer-bank match (cache.from_bank, built by build_answers.py from evals/questions.json facts +
starters, starters carry their `show` page first) → bank answer, no model; judge says small talk → our own line.

**4. rerank** (always): the second vote — cross-encoder/ms-marco-TinyBERT-L-2-v2 (int8 ONNX, 4 MB, agent/reranker.py,
same tokenizer as the embedding model) scores question + chunk pairs; its order is fused with the first stage's by RRF,
the first stage counting double; keeps top 6. If the model cannot run, the first stage's order stands.
research.search_site (step 6's tool) votes the same way, 8 → 4. evals/rerank_ab.py measures the vote against the
first stage alone, no keys needed.

**5. recall**: chat memory (memory.py, Redis) + economy mode when the day's writer quota runs thin.

**6. plan** (research.py): L1/L2 → rules plan, the step-2 search is the evidence; a list of ≥3 requirements → one
search per point, no model; L3 with time/quota → planner model + tools search_site/open_page, up to 2 rounds (act).

**7. respond** (writer model from the level's pool in llm.py TIERS: L1 2 chunks, L2 4, L3 6–10; economy ≤4) sees the
chunks + PROFILE (content/profile/core.md, ALWAYS in the prompt) + memory. Hidden first line "BRIEF: … | SHOW: <path>"
picks the page to open; second opinion on a wrong refusal.

**8. check** (graph.check, gate 4/5): strips code / prompt leaks / bad links; then the **grounding check**
(agent/grounding.py, since 19 Nov 2026): a cheap model (llm.GROUNDING_POOL, Nemotron Lightning first, never Groq) reads
the answer against PROFILE + the chunks the writer read and returns the unsupported claims quoted from the answer plus a
corrected answer; accepted only if each quoted claim is really in the answer and the rewrite passes guard.check and a
size bound (0.35–1.35×); otherwise the answer stands (trace says why: ok / fixed / skipped:… / rejected:…). A
correction reaches the browser as one "replace" event after the stream (api/index.py). Then the hiring next-step line,
SHOW → navigate, named pages → "take me there" links, caches first-turn answers that no check changed.
Evals: evals/grounding_eval.py (--dry: acceptance rules, no keys; real: 8 planted-mistake cases, CI).

**9. remember**: saves memory for the next turn.

Known weak spots and the fix plan: `docs/handoff/OPEN-PROBLEMS.md`, problem 1.
