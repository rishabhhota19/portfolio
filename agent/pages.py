"""The site's pages: the only places Dumbledore links to or takes a visitor (built from knowledge.json).

Two kinds of action, both decided by rules — no LLM call, so they're instant and can't be talked into a strange URL:
  - navigate: the visitor asks to go somewhere ("take me to his projects", "open the LCSNet paper") → the chat moves
    the page there. A pure "take me to X" is answered by the router alone (L0).
  - links: after an answer, up to two "take me there" buttons for the pages it was about.

Nothing here lists pages by hand, so it grows with the site: sections come from content/site.json (the same list the
header nav and the sitemap use), and every project, paper, role and post from content/. A new section with a "kind"
brings its content pages along. evals/navigation_eval.py fails CI if a route in app/ isn't a section, and generates a
"take me to …" test for every section and page.
"""

import re
from collections import Counter

from .config import KNOWLEDGE, SITE

# Sections of the site (content/site.json), and the words that name them: path → (label, regex).
SECTIONS = {s["path"]: (s["label"], "|".join(re.escape(w.lower()) for w in [s["label"], *s.get("words", [])]))
            for s in SITE["sections"]}
KIND_OF_SECTION = {s["path"]: s["kind"] for s in SITE["sections"] if s.get("kind")}  # whose pages live under it

# "take me to …", "open …", "I'd like to see …", "where can I find …" (not "is he open to relocating?").
NAVIGATE = re.compile(
    r"\b(take|bring|send|get) me\b|\b(go|navigate|jump|head|skip|redirect me) (to|back)\b|^\s*(please )?(open|show|display|load)\b"
    r"|\bshow me\b|\b(open|pull up|bring up|display)\b (the|his|rishabh'?s|a|an|up|me)\b|\blet me see\b"
    r"|\b(i'?d|i would|i want|i wanna|can i|could i|may i)( like)? (to )?(see|view|read|check out|look at|visit|browse|explore|download)\b"
    r"|\bwhere (can|do|should) i (find|see|read|get|download)\b|\b(link|links) to\b",
    re.I,
)
ASKS_MORE = re.compile(r"\b(what|how|why|when|which|who|explain|tell|summari[sz]e|describe|compare|walk me|is he|does he|did he|has he|"
                       r"links?|urls?)\b", re.I)  # "links to his papers" → go there AND answer with the links


def _label(title: str) -> str:
    """'LCSNet: Lightweight Caries …' → 'LCSNet'; 'TurboTrade — Zerodha …' → 'TurboTrade'; drops '(Mar 2026 – …)'."""
    return re.split(r":| — | \(", title)[0].strip()


def _pages() -> list[dict]:
    """Every specific page an answer can be about. Items that share their section's page (papers, roles) get an
    #anchor (their list item's id); items with a page of their own (projects, posts) don't."""
    docs = [d for d in KNOWLEDGE["docs"] if d["kind"] in KIND_OF_SECTION.values()]
    common = {kw for kw, n in Counter(kw.lower() for d in docs for kw in set(d["keywords"])).items() if n > 4}  # rag, faiss…
    section_words = "|".join(words for _, words in SECTIONS.values())
    pages = []
    for d in docs:
        slug = d["id"].split(":", 1)[1]
        anchor = f"#{slug}" if d["url"] in SECTIONS else ""
        label = _label(d["title"])
        words = {kw.lower() for kw in d["keywords"]  # words that point at this page (not "rag", not "blog")
                 if len(kw) > 2 and kw.lower() not in common and not re.fullmatch(section_words, kw.lower())}
        summary = d.get("summary", "")
        if len(summary) > 90:
            summary = summary[:90].rsplit(" ", 1)[0].rstrip(",;—– ") + "…"
        paper = re.search(r"Link: (https?://\S+)", d["text"])  # a publication's own page (journal, IEEE, Springer)
        pages.append({"id": d["id"], "kind": d["kind"], "path": d["url"] + anchor, "label": label, "summary": summary,
                      "paper": paper[1] if paper else "", "names": {label.lower()}, "words": words})
    return pages


PAGES = _pages()
PATHS = set(SECTIONS) | {p["path"].split("#")[0] for p in PAGES}  # every page that exists (for the output guard)


def _mentions(text: str, phrase: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text) is not None


def find_page(text: str) -> dict | None:
    """The page a message names: a specific one if it's clear ("the osteoarthritis project"), else the section."""
    t = text.lower()
    section = next((path for path, (_, words) in SECTIONS.items() if re.search(rf"\b({words})\b", t)), None)
    kind = KIND_OF_SECTION.get(section)
    named = {p["id"]: [n for n in p["names"] if _mentions(t, n)] for p in PAGES}
    longest = max((n for ns in named.values() for n in ns), key=len, default="")
    if len(owners := [p for p in PAGES if longest in named[p["id"]]]) == 1:
        return {"path": owners[0]["path"], "label": owners[0]["label"]}  # a page's own name beats section words
    scored = []
    for p in PAGES:
        if kind and p["kind"] != kind:
            continue  # "the osteoarthritis *paper*" isn't the project
        if named[p["id"]] and all(n != longest and n in longest for n in named[p["id"]]):
            continue  # "Sr. AI Researcher at Simplilearn" also contains the junior role's name: the longer one wins
        score = 2 * len(named[p["id"]]) + sum(_mentions(t, w) for w in p["words"])
        if score:
            scored.append((score, p))
    if scored:
        best = max(s for s, _ in scored)
        top = [p for s, p in scored if s == best]
        if len(top) == 1:
            return {"path": top[0]["path"], "label": top[0]["label"]}
        bases = Counter(p["path"].split("#")[0] for p in top)
        (base, n), *rest = bases.most_common()
        if not rest or n > rest[0][1]:  # e.g. both OsteosConnect roles (and one paper) → the Experience page
            return {"path": base, "label": SECTIONS.get(base, (_label(top[0]["label"]),))[0]}
    if section:
        return {"path": section, "label": SECTIONS[section][0]}
    return None


def navigation(text: str) -> dict | None:
    """A navigate action if the visitor asks to go somewhere we have. `pure` = nothing else to answer."""
    if not NAVIGATE.search(text) or not (page := find_page(text)):
        return None
    pure = len(text.split()) <= 9 and not ASKS_MORE.search(text)
    return {"type": "navigate", **page, "pure": pure}


KIND_ORDER = {"project": 0, "publication": 1, "blog": 2, "experience": 3}  # timeline entries are the weakest "go there"


def links_for(answer: str, docs: list[dict], skip: set[str] = frozenset()) -> list[dict]:
    """Up to two "take me there" buttons, only for pages the answer names — any other page would be a guess (the
    retrieval's top hit can be off even when the answer is right). If one name contains another ("Sr. AI Researcher
    at Simplilearn" / "AI Researcher at Simplilearn"), the longer wins. Projects and papers come first, then pages the
    evidence came from. The page the visitor is already being taken to is skipped."""
    text = answer.lower()
    found = {p["id"]: n for p in PAGES for n in p["names"] if _mentions(text, n)}
    named = [p for p in PAGES if p["id"] in found and not any(found[p["id"]] != m and found[p["id"]] in m for m in found.values())]
    evidence = {d["id"].split("#")[0] for d in docs}
    named.sort(key=lambda p: (KIND_ORDER.get(p["kind"], 9), p["id"] not in evidence))
    out: list[dict] = []
    for p in named:
        base = p["path"].split("#")[0]
        if p["path"] in skip or base in skip:
            continue
        if all(p["path"] != o["path"] for o in out):
            out.append({"path": p["path"], "label": p["label"]})
    return out[:2]


def site_map() -> str:
    """The page list in the system prompt, so answers link real pages (fixed text → cached by Groq)."""
    lines = [f"{path} — {label}" for path, (label, _) in SECTIONS.items() if path != "/privacy"]
    lines += [f"{p['path']} — {p['label']}{': ' + p['summary'] if p['summary'] else ''}"
              f"{' — [read the paper](' + p['paper'] + ')' if p['paper'] else ''}" for p in PAGES]  # copied as a link
    return "\n".join(lines)
