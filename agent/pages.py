"""The site's pages: the only places Dumbledore links to or takes a visitor (built from knowledge.json).

Two kinds of action, both decided by rules — no LLM call, so they're instant and can't be talked into a strange URL:
  - navigate: the visitor asks to go somewhere ("take me to his projects", "open the LCSNet paper") → the chat moves
    the page there. A pure "take me to X" is answered by the router alone (L0).
  - links: after an answer, up to two "take me there" buttons for the pages it was about.
"""

import re
from collections import Counter

from .config import KNOWLEDGE

# Sections of the site, and the words that name them.
SECTIONS = {
    "/": ("Home", r"home|homepage|main page|landing page"),
    "/projects": ("Projects", r"projects?|things he (built|made)|case stud(y|ies)"),
    "/experience": ("Experience", r"experience|work history|career|jobs?|roles?|employment|skills?|tech stack|education|degree|timeline"),
    "/publications": ("Publications", r"publications?|papers?|research|journals?"),
    "/blog": ("Blog", r"blog|posts?|articles?|write-?ups?"),
    "/resume": ("Résumé", r"r[eé]sum[eé]|\bcv\b|curriculum vitae"),
    "/privacy": ("Privacy", r"privacy|data policy|cookies"),
}
KIND_OF_SECTION = {"/projects": "project", "/experience": "experience", "/publications": "publication", "/blog": "blog"}

# "take me to …", "open …", "I'd like to see …", "where can I find …" (not "is he open to relocating?").
NAVIGATE = re.compile(
    r"\b(take|bring|send|get) me\b|\b(go|navigate|jump|head|skip|redirect me) (to|back)\b|^\s*(please )?(open|show|display|load)\b"
    r"|\bshow me\b|\b(open|pull up|bring up|display)\b (the|his|rishabh'?s|a|an|up|me)\b|\blet me see\b"
    r"|\b(i'?d|i would|i want|i wanna|can i|could i|may i)( like)? (to )?(see|view|read|check out|look at|visit|browse|explore|download)\b"
    r"|\bwhere (can|do|should) i (find|see|read|get|download)\b|\b(link|links) to\b",
    re.I,
)
ASKS_MORE = re.compile(r"\b(what|how|why|when|which|who|explain|tell|summari[sz]e|describe|compare|walk me|is he|does he|did he|has he)\b", re.I)


def _label(title: str) -> str:
    """'LCSNet: Lightweight Caries …' → 'LCSNet'; 'TurboTrade — Zerodha …' → 'TurboTrade'; drops '(Mar 2026 – …)'."""
    return re.split(r":| — | \(", title)[0].strip()


def _pages() -> list[dict]:
    """Every specific page an answer can be about. Publications and roles share a page, so they get an #anchor."""
    docs = [d for d in KNOWLEDGE["docs"] if d["kind"] in ("project", "publication", "experience", "blog")]
    common = {kw for kw, n in Counter(kw.lower() for d in docs for kw in set(d["keywords"])).items() if n > 4}  # rag, faiss…
    section_words = "|".join(words for _, words in SECTIONS.values())
    pages = []
    for d in docs:
        slug = d["id"].split(":", 1)[1]
        anchor = f"#{slug}" if d["kind"] in ("publication", "experience") else ""
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
    scored = []
    for p in PAGES:
        if kind and p["kind"] != kind:
            continue  # "the osteoarthritis *paper*" isn't the project
        score = 2 * sum(_mentions(t, n) for n in p["names"]) + sum(_mentions(t, w) for w in p["words"])
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


def links_for(answer: str, docs: list[dict], skip: set[str] = frozenset()) -> list[dict]:
    """Up to two "take me there" buttons: pages the answer names, then the page of the best evidence.
    The page the visitor is already being taken to is skipped."""
    text = answer.lower()
    named = [p for p in PAGES if any(_mentions(text, n) for n in p["names"])]
    best_doc = [p for d in docs[:1] for p in PAGES if p["id"] == d["id"].split("#")[0]]
    out: list[dict] = []
    for p in named + best_doc:
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
              f"{' (paper: ' + p['paper'] + ')' if p['paper'] else ''}" for p in PAGES]
    return "\n".join(lines)
