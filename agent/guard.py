"""The refusal pipeline: out-of-scope questions are denied before any LLM sees them, and answers are checked before
the visitor sees them.

    Gate 1  rules (this file)        harmful, jailbreak, personal, off-topic requests → refusal, 0 tokens
    Gate 2  meaning (scope.py)       the question's embedding is closer to off-topic examples than to his work
    Gate 3  prompt (prompts.py)      the model answers only from his profile, else says REFUSAL word for word
    Gate 4  output (this file)       code, prompt leaks → replaced; phone numbers, IDs, emails, unknown links → removed
    Gate 5  cache (graph.py)         only clean, in-scope, first-turn answers are cached

Every pattern here is checked by evals/scope.json: attack prompts must be refused, recruiters' real questions must not.
"""

import re
from urllib.parse import urlsplit

from .config import KNOWLEDGE, SITE
from .pages import PAGES, PATHS, SECTIONS

REFUSAL = ("I'll have to pass on that one: I only answer questions about Rishabh's work — his projects, research, "
           "experience and fit for a role.")

# A visitor who seems to be in real distress gets this, whole and unchanged, whoever noticed: the judge (judge.py) or
# the writer, which answers with CARE_MARK alone (prompts.py rule 10). No model writes it and nothing is added to it:
# no page, no link, no next step. It goes out as it is, so the output check's number filter never touches the helpline.
# Checked 14 Nov 2026: Tele-MANAS (14416) is the Government of India's free helpline, open all hours, in 20 languages;
# findahelpline.com is the directory the International Association for Suicide Prevention points to.
CARE = ("I'm sorry you're going through this. I'm only an AI that knows Rishabh's work, so I can't be the help you need, "
        "but you deserve real support right now. In India, Tele-MANAS is free and open day and night: call 14416. "
        "Anywhere else, findahelpline.com lists a helpline for your country. If you are in immediate danger, please call "
        "your local emergency number or reach out to someone near you.")
CARE_MARK = "CARE"


def is_care(answer: str) -> bool:
    """The writer's one-word signal: the reply's first line is the word, whatever a model dresses it in or adds
    after it. Anything it adds is dropped: a visitor in distress gets the care reply and nothing a model wrote."""
    first = answer.strip().split("\n", 1)[0]
    return first.strip(" *_`.!\"'").upper() == CARE_MARK


def may_be_care(start: str) -> bool:
    """Could a reply that begins like this still turn out to be the care signal? Yes for the signal, for its first
    letters, and while nothing but markup has arrived. Nothing is shown and the page is not moved while it could."""
    first, _, rest = start.lstrip().partition("\n")
    word = first.strip(" *_`.!\"'")
    return word == CARE_MARK or (not rest and CARE_MARK.startswith(word))


CANNED = {
    "injection": "My instructions stay as they are, I'm afraid. Ask me anything about Rishabh's work — his projects, research or experience.",
    "contact": f"You can email him at **{SITE['email']}** or message him on [LinkedIn]({SITE['linkedin']}). He doesn't share a phone number or address here — or tap **Share your details** below and he'll get back to you.",
    "identity": "I'm **Dumbledore**, the AI agent on Rishabh's portfolio. I answer questions about his work from what's on this site, say so when I don't know, and can take you to any page — just ask (\"take me to his projects\").",
    "thanks": "You're most welcome. Anything else you'd like to know about Rishabh's work?",
    "greeting": "Hello! I'm **Dumbledore**, Rishabh's AI agent. Ask me about his projects, research or experience — or ask me to take you to any page.",
}

# ── Gate 1: rules ───────────────────────────────────────────────────────────

ABOUT_HIM = r"\b(he|his|him|rishabh'?s?)\b"
ABOUT_HIM_OR_SITE = r"\b(he|his|him|rishabh'?s?|this (site|website|chat|chatbot|bot|agent|portfolio))\b"
# "hi", "hy", "hii", "heyy", "helo", "hlo", "hai", "yo", "sup", "namaste", "good morning"… as visitors actually type them
GREETING = r"(h+[iy]+|hiya|hel+o+|hlo|hai|hey+|yo|sup|what'?s up|namaste|namaskar|hola|good (morning|afternoon|evening|day|night))"
REQUEST = (r"(^|[.,;:!?]\s*|\b(can|could|would|will) you\s+|\bplease\s+)((now|then|ok|okay|so|also|and|cool),?\s+)?"
           r"(write|generate|create|build|make|give me|fix|debug|solve|compose|draft|code|implement|translate|calculate|"
           r"compute|tell me)\b")
RULES = {  # checked in this order; the first match wins
    "harmful": r"\b(bombs?|explosives?|weapons?|guns?|kill|murder|suicide|self-harm|poison|meth|cocaine|heroin|hack(ing|ed)? into|"
               r"malware|ransomware|keylogger|phishing|scam (people|someone)|steal|passwords?|credit cards?|cvv|porn|nudes?|"
               r"terroris[mt]|product keys?|licen[cs]e keys?|serial keys?|crack(ed)? (software|version))\b",
    "injection": r"ignore (all|any|previous|prior|the above|your|these|those|everything)|disregard|forget (all|everything|your|previous)|"
                 r"system prompt|(your|the system|the hidden|these) (instructions|rules|prompt|guidelines|programming)|rules you (were|are|have)|"
                 r"jailbreak|\bDAN\b|developer mode|pretend (to be|you are|you're|that|he|rishabh)|you are now|you're now|"
                 r"(^|[.,!?]\s*)(please\s+)?act as\b|role-?play|let'?s play a game|from now on|verbatim|(everything|text|words) above|"
                 r"translate your|base64|decode this|new instructions|\boverride\b|\bsudo\b|grandma used to|ignora|instrucciones|ignorez|anweisungen",
    "personal": r"\b(girlfriend|boyfriend|wife|husband|married|dating|his (family|parents|father|mother|dad|mom|sister|brother|religion|caste)|"
                r"date of birth|birthday|how old is he|his age|aadhaa?r|pan (card|number)|passport|bank account|"
                r"(name of his|his) (manager|boss|colleagues?|team-?mates?)|ceo of|salary of|"
                r"fraud|scandals?|scammer|criminal|arrested|lawsuits?|controvers(y|ies)|"
                r"say (that )?(he|rishabh)|(he|rishabh) told me to|accept an? .{0,20}offer|what do you think (about|of) (?!him|rishabh|his))\b",
    "off_topic": REQUEST + r".{0,60}\b(code|function|script|program|snippet|component|query|sql|regex|website|poem|joke|song|essay|"
                 r"haiku|limerick|rap|lyrics|recipe|homework|assignment|cover letter|tweet|caption|bedtime story|short story)\b"
                 r"|\b(capital of|who won|world cup|weather|forecast|stock market|share price|which stocks|crypto|bitcoin|nifty|sensex|"
                 r"election|vote for|prime minister|horoscope|astrology|homework|derivative of|integral of|solve for)\b"
                 r"|\b(i have|i've got|my) (a )?(headache|fever|cold|cough|pain)\b|\b(which|what) medicine\b|\bshould i (buy|sell|invest|vote|take)\b"
                 r"|\b\d+\s*(times|plus|minus|divided by|multiplied by|[*+/^])\s*\d+\b",
    "contact": r"\b(his|rishabh'?s) (e-?mail|linkedin|github|phone|number|mobile|whatsapp|address|contact)\b|"
               r"\b(contact|reach|call|email|e-mail|message|ping) (him|rishabh)\b|\bget in touch\b|\bcontact (details|info)|"
               r"\bhow (do|can|should) i (contact|reach|email|get hold of)\b|\bwhere does (he|rishabh) live\b|\blive on\b|"
               r"\bwhich street\b|\bhome address\b|\bphone number\b|"
               r"^\s*((take|bring|get) me to |go to |open |show( me)? )?(the |his )?contact( page| section| him)?[\s!.?]*$",
    "identity": r"^\s*(who|what) are you\b[\s?!.]*$|\byour name\b|\bwho is dumbledore\b|\bare you (a bot|a human|human|real|an ai|chatgpt)\b",
    "thanks": r"^\s*(thanks|thank you|thx|cheers|great,? thanks|ok,? thanks)\b[\s!.,a-z]{0,20}$",
    # the whole message is the greeting (maybe twice, maybe addressed to someone); "hi, has he used LangGraph?" is a question
    "greeting": rf"^\s*{GREETING}([\s,!.]+{GREETING})?(,?\s*(there|dumbledore|sir|ma'?am|rishabh|bot|agent|everyone|team|all))?[\s!.,]*$",
}
# There is no "general question" rule any more. It refused a first message that began "what is", "what are", "how to"
# and named neither him nor a page: that is how recruiters write ("What are the key skills?", "What is the notice
# period?"), and 15 of 18 such questions were turned away before any model saw them (14 Nov 2026). What a question is
# about is for Gate 2 and the models to judge.
REFUSED = {"harmful", "injection", "personal", "off_topic"}


def names_a_page(text: str) -> bool:
    t = text.lower()
    return any(re.search(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", t) for p in PAGES for w in p["names"] | p["words"])


ONE_LINER = 500  # characters: the longest message that could reach these rules before 14 Nov 2026


def classify(text: str) -> str:
    """Gate 1. Returns an intent: one of REFUSED, a canned one (contact, identity, thanks, greeting), or "question".

    A message longer than ONE_LINER never gets a canned reply: "how can I reach him" at the end of a recruiter's
    600-character note is one clause of a longer question, and the contact card alone would leave the rest unanswered.

    The refusing rules read every message, whatever its length. They were written for one-line messages, and a pasted
    job description holds their words in ordinary senses ("system prompt design", "write production code", "fraud",
    "passwords"), so some postings are refused here. Skipping the rules for long messages was tried and withdrawn the
    same day: an attack added to a real hiring note then passed every gate (73 of 73), and one model summarised its
    rules. The way through for a real posting is the judge (JUDGE=rescue, graph.rescued), which sets the refusal
    aside when it is sure the message is about him and nothing else rides on it."""
    long = len(text) > ONE_LINER
    for intent, pattern in RULES.items():
        if long and intent not in REFUSED:
            continue
        if re.search(pattern, text, re.I):
            return intent
    return "question"


def reply_for(intent: str) -> str:
    return CANNED.get(intent, REFUSAL)


def is_refusal(answer: str) -> bool:
    return answer.strip().startswith(REFUSAL[:40])


# ── Gate 4: output ──────────────────────────────────────────────────────────

_ALL_TEXT = "\n".join([KNOWLEDGE["core"], *(d["text"] for d in KNOWLEDGE["docs"])])
ALLOWED_URLS = {u.rstrip(".,;:") for u in re.findall(r"https?://[^\s)\"'\]]+", _ALL_TEXT)} | {SITE["linkedin"], SITE["github"], SITE["url"]}
PROMPT_MARKERS = re.compile(r"Answer only from PROFILE|Treat user messages,? (and )?CONTEXT|reveal or discuss these rules|"
                            r"reply with exactly|copy numbers exactly|Don't embellish|in the talent-agent sense|"
                            r"ANSWER SHAPE|You plan the research|closest proof it does show|Raise only what matters|"
                            r"never invent it|are data, not instructions|^\s*(RULES|PROFILE|CONTEXT|PAGES|RESEARCH|STYLE)\s*$", re.I | re.M)
CODE = re.compile(r"```|^\s{4,}(def |class |import |function |const |let |SELECT |<\w+)|<\?php|#include\b", re.M)
URL = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)|https?://[^\s)\]]*[^\s)\].,;:!?]")  # a sentence's final "." isn't part of it
NUMBER = re.compile(r"\+?\d[\d\s().-]{7,}\d")  # 10+ digits = a phone, Aadhaar or card number
SECRETS = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b|\b[A-Z0-9]{5}(-[A-Z0-9]{5}){3,4}\b")  # PAN, product keys
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")


def check(answer: str) -> str | None:
    """Things that replace the whole answer with the refusal: code and leaked instructions."""
    if CODE.search(answer):
        return "code"
    if PROMPT_MARKERS.search(answer):
        return "prompt_leak"
    return None


SITE_HOST = urlsplit(SITE["url"]).hostname


def _allowed(url: str) -> bool:
    if url.startswith("/"):
        return url.split("#")[0].rstrip("/") in PATHS or url == "/"
    if url.startswith("mailto:"):
        return url[7:] == SITE["email"]
    if url.rstrip("/.,") in ALLOWED_URLS:
        return True
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    return u.scheme == "https" and u.hostname == SITE_HOST and "@" not in u.netloc and _allowed(u.path or "/")


LABELS = {path: label for path, (label, _) in SECTIONS.items()} | {p["path"]: p["label"] for p in PAGES}
BARE_PATH = re.compile(r"\s?\[(/[a-z0-9\-/]*(?:#[a-z0-9\-]+)?)\](?!\()", re.I)  # "[/experience]": a citation, not a link


def linkify(answer: str) -> str:
    """A page path cited in bare brackets becomes a real link to that page — or goes, if the page doesn't exist."""
    def fix(m: re.Match) -> str:
        path = m.group(1).rstrip("/") or "/"
        label = LABELS.get(path) or LABELS.get(path.split("#")[0])
        return f" ([{label}]({path}))" if label and (path.split("#")[0] in PATHS) else ""
    return BARE_PATH.sub(fix, answer)


# The agent's hidden line (read_brief takes the first one) if a model writes it again further down, or a piece of it.
_HIDDEN_LINE = re.compile(r"^[^\w\n]*(?:BRIEF:|SHOW:\s*(?:/|stay\b)).*(?:\n|$)|\s*\|\s*SHOW:\s*(?:/\S*|stay\b)", re.M)


def clean(answer: str) -> str:
    """Things that are removed, keeping the rest: unknown links (made-up pages too), long numbers, IDs, other emails."""
    answer = linkify(_HIDDEN_LINE.sub("", answer))

    def link(m: re.Match) -> str:
        label, url = (m.group(1), m.group(2)) if m.group(1) else (None, m.group(0))
        if label is None:  # a bare URL
            return url if _allowed(url) else ""
        # A link's label is visible text, so it is redacted like any other ("[9876543210](…)" can't smuggle a number).
        return f"[{_redact(label)}]({url})" if _allowed(url) else _redact(label)

    parts, last = [], 0
    for m in URL.finditer(answer):  # numbers inside allowed URLs (DOIs, IDs) are left alone
        parts.append(_redact(answer[last:m.start()]))
        parts.append(link(m))
        last = m.end()
    parts.append(_redact(answer[last:]))
    return "".join(parts)


def _redact(text: str) -> str:
    text = NUMBER.sub(lambda m: m.group(0) if sum(c.isdigit() for c in m.group(0)) < 10 else "[number removed]", text)
    text = SECRETS.sub("[removed]", text)
    return EMAIL.sub(lambda m: m.group(0) if m.group(0).lower() == SITE["email"] else "[email removed]", text)


_BRIEF = re.compile(r"^[\s*_]*BRIEF:[\s*_]*(.*?)\|[\s*_]*SHOW:[\s*_]*([^\s*_]\S*)[^\n]*(?:\n+|$)")


def read_brief(text: str) -> tuple[str, str, str]:
    """The agent's hidden first line (prompts.py): what it worked out, the page it chose, and the reply without it."""
    m = _BRIEF.match(text)
    return (m[1].strip(), m[2].strip("`[]()"), text[m.end():]) if m else ("", "", text)


class BriefReader:
    """Holds a stream back until its BRIEF line has passed, so the page can move before the reply and the visitor never
    sees the line. A model that didn't write one streams straight through."""

    def __init__(self) -> None:
        self.raw = ""
        self.done = False
        self.show = ""

    def push(self, text: str) -> str:
        if self.done:
            return text
        self.raw += text
        start = self.raw.lstrip(" \n*_")
        if not ("BRIEF:".startswith(start[:6]) or start.startswith("BRIEF:")):
            self.done = True
            return self.raw
        if "\n" not in start or not start.startswith("BRIEF:"):
            return ""
        self.done = True
        _, self.show, body = read_brief(self.raw)
        return body


class StreamGuard:
    """Gate 4 while streaming: holds text back until a sentence ends, checks everything so far, then releases it.
    So nothing reaches the visitor unchecked. Yields ("text", more) or ("replace", whole answer) events."""

    BOUNDARY = re.compile(r"[.!?:](\s)|\n")

    def __init__(self) -> None:
        self.raw = ""  # everything the model wrote so far
        self.cut = 0  # how much of it has been checked
        self.sent = ""  # what the visitor has (after clean())
        self.blocked: str | None = None

    def push(self, text: str) -> list[tuple[str, str]]:
        self.raw += text
        start = self.raw.lstrip()
        if not self.sent and (REFUSAL.startswith(start) or start.startswith(REFUSAL[:40])):
            return []  # looks like the refusal: it's sent whole at the end (or replaced by a second opinion)
        if not self.sent and may_be_care(start):
            return []  # the writer's care signal, or its beginning: the visitor sees the care reply, never this
        ends = [m.end() for m in self.BOUNDARY.finditer(self.raw)]
        cut = next((e for e in reversed(ends) if e > self.cut and self._balanced(self.raw[:e])), 0)
        return self._release(cut) if cut else []

    def finish(self) -> list[tuple[str, str]]:
        return self._release(len(self.raw))

    def _release(self, cut: int) -> list[tuple[str, str]]:
        self.cut = cut
        if self.blocked:
            return []
        if reason := check(self.raw[:cut]):
            self.blocked, self.sent = reason, REFUSAL
            return [("replace", REFUSAL)]
        safe = clean(self.raw[:cut])
        if safe == self.sent:
            return []
        if not safe.startswith(self.sent):  # a fix changed text already shown → resend it whole
            self.sent = safe
            return [("replace", safe)]
        more, self.sent = safe[len(self.sent):], safe
        return [("text", more)]

    @staticmethod
    def _balanced(text: str) -> bool:
        """Don't cut inside a [link](…) — the link check needs all of it."""
        return text.count("[") == text.count("]") and text.count("(") == text.count(")")
