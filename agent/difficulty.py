"""How hard is a question? Plain rules, no LLM call (0 tokens), checked against evals/difficulty.json.

    L1  one fact            "Where did he study?"  "Has he used MCP?"
    L2  the usual question  "What did he build at Simplilearn, and what was the impact?"
    L3  needs reasoning     "Would he fit a Forward Deployed Engineer role?"  "Compare his two jobs."
(L0 — greetings, contact questions, repeats — never reaches here: the router or the answer cache handles it.)

A wrong guess is cheap: if a level's models are busy the router spills to the next level anyway.
"""

import re

# Judgement, comparison or explanation → reasoning.
HARD = re.compile(
    r"\b(fit|suit(able|ed)?|good match|right (person|candidate|fit)|hire|compare|comparison|versus|vs\.?|differ"
    r"|why|how (would|could|does|did|do) (he|his|you)|evaluate|assess|strengths?|weakness(es)?|trade-?offs?"
    r"|pros|cons|recommend|stand out|unique|best (project|work)|biggest|most (impressive|impactful|complex)"
    r"|job description|\bjd\b|requirements?|in (detail|depth)|deep dive|walk me through|explain|summari[sz]e)\b",
    re.I,
)
# A short question asking for one fact.
FACT = re.compile(
    r"^(where|when|which|who|what(?:'s| is| was| are) (his|he|the)|how (many|long|old)|(is|was|does|did|has|can) (he|his)"
    r"|what degree|what college|what company)\b",
    re.I,
)


def difficulty(question: str, past_messages: int = 0) -> str:
    q = question.strip()
    if HARD.search(q) or len(q) > 280 or q.count("?") >= 3:
        return "L3"
    overview = re.search(r"\babout\??$", q, re.I)  # "What are his papers about?" wants a summary, not one fact
    if len(q.split()) <= 12 and FACT.search(q) and " and " not in q.lower() and not overview:
        return "L1"
    if past_messages >= 10:
        return "L3"  # a long conversation needs more context to answer well
    return "L2"
