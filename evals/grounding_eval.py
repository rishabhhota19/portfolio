"""Does the grounding check (agent/grounding.py) catch a wrong number and leave a right one alone?

    python -m evals.grounding_eval          # the real checker models (keys needed)
    python -m evals.grounding_eval --dry    # the acceptance rules alone, on canned checker replies: no keys

Each case is an answer written from real site passages with one planted mistake — a result of another project, a
wrong quarter, a wrong city, an invented tool — that must come back corrected (the planted value gone, the right one
present when the sources have it), or a correct answer, including a fair paraphrase, that must come back unchanged.
Reports caught / false alarms. Informational on the real models until a first CI run has measured it (it exits 0 and
prints a warning when a planted mistake gets through); --dry fails on any acceptance rule that misbehaves.
"""

import asyncio
import sys

from agent import grounding
from agent.config import KNOWLEDGE

DOCS = {d["id"]: d for d in KNOWLEDGE["docs"]}

# (id, question, answer, source doc ids, expectation): expectation is ("fixed", gone, present) or ("unchanged",)
CASES = [
    ("lcsnet-98", "What accuracy did LCSNet get?",
     "**LCSNet reached 98% accuracy** on osteoarthritis X-ray grading.\n- [Research](/publications): published in Intelligence-Based Medicine (Elsevier).",
     ["publication:lcsnet", "project:oa-classification"], ("fixed", "98", "71.7")),
    ("lcsnet-right", "What accuracy did LCSNet get?",
     "**LCSNet reached an F1-score of 71.7% and IoU of 56.8%** on dental caries segmentation.\n- [Research](/publications): Intelligence-Based Medicine (Elsevier, IF 2.3), October 2025.",
     ["publication:lcsnet", "project:oa-classification"], ("unchanged",)),
    ("award-quarter", "Which award did he win at Simplilearn?",
     "**He won the Best Team Award (Q2)** for the Collaterals Agent.\n- Cut collateral creation from 7–10 days to 1 day.",
     ["experience:02-simplilearn-ai-researcher"], ("fixed", "Q2", "Q3")),
    ("oa-city", "Where was the osteoarthritis trial run?",
     "**The randomised controlled trial ran at SRM Chennai**, and the system is deployed at Fortis Nagarbhavi, Bengaluru.",
     ["project:oa-classification"], ("fixed", "Chennai", "Trichy")),
    ("launch-right", "How many versions of the Product Launch System has he shipped?",
     "**88 tested versions in eleven weeks**, and it is in use as an internal tool.\n- [Product Launch System](/projects/product-launch-system): three teams, from programme sheet to editable artwork.",
     ["project:product-launch-system"], ("unchanged",)),
    ("years-paraphrase", "How many years of experience does he have?",
     "**About three years** of turning AI research into production prototypes and AWS-hosted pipelines.",
     [], ("unchanged",)),
    ("invented-tool", "What did he build the Product Launch System with?",
     "**Claude Agent Skills, Adobe Illustrator automation and Kubernetes**, with a human in the loop.\n- 88 tested versions in eleven weeks.",
     ["project:product-launch-system"], ("fixed", "Kubernetes", "")),
    ("osteos-dates", "When was he at OsteosConnect?",
     "**AI Engineer at OsteosConnect from Feb 2024 to Mar 2025**, remote, for a California company; AI/ML intern there before that.",
     ["experience:03-osteosconnect-ai-engineer"], ("unchanged",)),
]

# --dry: the checker's reply is canned; what matters is what decide() does with it
ANSWER = "**LCSNet reached 98% accuracy** on osteoarthritis X-ray grading.\n- [Research](/publications): Intelligence-Based Medicine."
DRY = [
    ("quoted claim, sound rewrite → fixed",
     '{"unsupported": ["LCSNet reached 98% accuracy"], "answer": "**LCSNet reached an F1-score of 71.7%** on dental caries segmentation.\\n- [Research](/publications): Intelligence-Based Medicine."}',
     "fixed"),
    ("nothing unsupported → ok", '{"unsupported": [], "answer": ""}', "ok"),
    ("a claim the answer never made → rejected", '{"unsupported": ["he won a Nobel prize"], "answer": "Something else entirely."}', "rejected:unquoted"),
    ("rewrite three times longer → rejected", '{"unsupported": ["98% accuracy"], "answer": "' + "LCSNet is a dental model. " * 12 + '"}', "rejected:grew"),
    ("rewrite with code → rejected", '{"unsupported": ["98% accuracy"], "answer": "```python\\nprint(1)\\n```"}', "rejected:guard"),
    ("rewrite is a stub → rejected", '{"unsupported": ["98% accuracy"], "answer": "LCSNet."}', "rejected:stub"),
    ("not JSON → skipped", "I think the answer is fine.", "skipped:unparsed"),
    ("JSON in prose and smart quotes → fixed",
     'Here you go: {"unsupported": ["LCSNet reached 98% accuracy"], "answer": "**LCSNet reached F1 71.7%** on dental caries.\\n- [Research](/publications): Intelligence-Based Medicine."} Done.',
     "fixed"),
]


def dry() -> int:
    failed = 0
    for name, reply, expected in DRY:
        _, _, why = grounding.decide(ANSWER, reply)
        ok = why == expected
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name:<48} got {why}")
    print(f"\nacceptance rules: {len(DRY) - failed}/{len(DRY)}")
    return 1 if failed else 0


async def real() -> int:
    caught = should_catch = alarms = should_keep = 0
    for case_id, question, answer, ids, expect in CASES:
        result = await grounding.check(question, answer, [DOCS[i] for i in ids])
        if expect[0] == "fixed":
            _, gone, present = expect
            should_catch += 1
            ok = result.why == "fixed" and gone.lower() not in result.text.lower() and (not present or present.lower() in result.text.lower())
            caught += ok
        else:
            should_keep += 1
            ok = result.why == "ok" and result.text == answer
            alarms += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {case_id:<16} {result.why:<20} {result.model.split('/')[-1]:<22} {result.ms:>5} ms"
              + ("" if ok else f"\n      got: {result.text[:160]!r}"))
        await asyncio.sleep(2)
    print(f"\ncaught {caught}/{should_catch} planted mistakes; false alarms {alarms}/{should_keep}")
    if caught < should_catch or alarms:
        print(f"::warning::grounding check: caught {caught}/{should_catch}, false alarms {alarms}/{should_keep} — read evals/grounding_eval.py's output")
    return 0


if __name__ == "__main__":
    sys.exit(dry() if "--dry" in sys.argv else asyncio.run(real()))
