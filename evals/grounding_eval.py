"""Does the grounding check (agent/grounding.py) catch a wrong number and leave a right one alone?

    python -m evals.grounding_eval            # the shipped pool in its order: what production does (keys needed)
    python -m evals.grounding_eval --models   # every model of the pool on its own: which checker to lead with
    python -m evals.grounding_eval --dry      # the acceptance rules alone, on canned checker replies: no keys

Each case is an answer written from real site passages with one planted mistake — a result of another project, a
wrong quarter, a wrong city, an invented tool, a false premise — that must come back corrected (the planted value
gone, the right one present when the sources have it), or a correct answer, including a fair paraphrase, that must
come back unchanged. Two numbers: caught (of the planted mistakes) and false alarms (right answers that were
changed; a check that skipped or was rejected leaves the answer alone and is not an alarm). Each case prints a
::notice:: line, so the run page shows the outcomes without a sign-in. Informational on the real models until the
numbers say which model to lead with (it exits 0 and warns); --dry fails on any acceptance rule that misbehaves.

First CI run (19 Nov 2026, run #91, Nemotron Lightning first): caught 2/5, false alarms 2/4.
"""

import asyncio
import statistics
import sys
from dataclasses import replace

from agent import grounding, llm
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
    # Seen on the live site, 19 Nov 2026: the question's false premise was accepted. The checker gets the chunks of
    # every page the answer or the question names (graph.check), so LCSNet's own page is among its sources here.
    ("lcsnet-premise", "What did LCSNet achieve on osteoarthritis X-rays?",
     "**LCSNet graded knee X-rays with 98% accuracy and AUC.**\n- OA-Classification & Reporting: 98% grading accuracy, 98% AUC, under-2-minute report.\n- Clinical validation: >90% concordance with radiologists in a randomised trial.\n- Stack: TensorFlow models deployed on AWS EC2 H100 cluster, served via Lambda.",
     ["project:oa-classification", "publication:lcsnet"], ("fixed", "LCSNet graded knee", "caries")),
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


def outcome(expect: tuple, answer: str, result: grounding.Grounding) -> tuple[bool, str]:
    """(passed, what happened): caught / missed / changed-wrong for a planted mistake; kept / false alarm for a right answer."""
    if expect[0] == "fixed":
        _, gone, present = expect
        if result.why != "fixed":
            return False, f"missed ({result.why})"
        right = gone.lower() not in result.text.lower() and (not present or present.lower() in result.text.lower())
        return right, "caught" if right else "changed, still wrong"
    if result.text == answer:
        return True, "kept" if result.why == "ok" else f"kept ({result.why})"
    return False, "FALSE ALARM: a right answer was changed"


async def run_cases(label: str, notices: bool) -> tuple[int, int, int, int, float]:
    caught = planted = alarms = right = 0
    times = []
    for case_id, question, answer, ids, expect in CASES:
        result = await grounding.check(question, answer, [DOCS[i] for i in ids])
        passed, what = outcome(expect, answer, result)
        if expect[0] == "fixed":
            planted += 1
            caught += passed
        else:
            right += 1
            alarms += not passed
        times.append(result.ms)
        line = f"{case_id}: {what} — {result.model.split('/')[-1] or 'no model'}, {result.ms} ms"
        print(f"{'PASS' if passed else 'FAIL'}  {label:<24} {line}" + ("" if passed else f"\n      got: {result.text[:200]!r}"))
        if notices:
            print(f"::notice::grounding {label}: {line}")
        await asyncio.sleep(2)
    return caught, planted, alarms, right, statistics.median(times) if times else 0.0


async def real(per_model: bool) -> int:
    pool = [n for n in llm.GROUNDING_POOL if llm.M[n].available]
    if not pool:
        print("::warning::grounding check: no checker model has a key here — nothing measured")
        return 0
    rows = []
    if per_model:
        shipped = grounding.TIER
        for name in pool:
            grounding.TIER = replace(shipped, pool=[name])
            rows.append((name, *await run_cases(name, notices=False)))
        grounding.TIER = shipped
    else:
        rows.append(("shipped pool", *await run_cases("shipped pool", notices=True)))
    print(f"\n{'checker':<26} {'caught':>8} {'false alarms':>13} {'median ms':>10}")
    for name, caught, planted, alarms, right, ms in rows:
        print(f"{name:<26} {caught:>4}/{planted:<3} {alarms:>8}/{right:<4} {ms:>10.0f}")
        if per_model:
            print(f"::notice::grounding checker {name}: caught {caught}/{planted}, false alarms {alarms}/{right}, {ms:.0f} ms")
    name, caught, planted, alarms, right, _ = rows[0]
    if not per_model and (caught < planted or alarms):
        print(f"::warning::grounding check: caught {caught}/{planted}, false alarms {alarms}/{right} — the ::notice:: lines above say which cases")
    return 0


if __name__ == "__main__":
    sys.exit(dry() if "--dry" in sys.argv else asyncio.run(real("--models" in sys.argv)))
